from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import platform
import shutil
import socket
import threading
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from audio_pipeline import audio_duration_seconds, normalize_cleanup_mode, write_enhanced_copy
from engine import MODEL_INFO, TranscriptionCancelled, hardware_payload, load_model, transcribe_audio
from job_store import JobStore
from pairing import PairingStore, is_private_client, laptop_pairing_qr

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)
RUNTIME_DIR = Path(os.getenv("LECTUREAI_RUNTIME_DIR") or ROOT / ".lectureai-runtime")
JOB_STORE = JobStore(RUNTIME_DIR / "jobs")
jobs: dict[str, dict] = JOB_STORE.mark_unfinished_interrupted()
ENHANCEMENT_STORE = JobStore(RUNTIME_DIR / "enhancement-jobs")
enhancement_jobs: dict[str, dict] = ENHANCEMENT_STORE.load_all()
for _enhancement_id, _enhancement_job in enhancement_jobs.items():
    if _enhancement_job.get("status") in {"queued", "processing"}:
        _enhancement_job.update({
            "status": "interrupted",
            "message": "Windows helper restarted before the derived copy finished. Generate it again; the phone original was never changed.",
            "finished_at": time.time(),
        })
        enhancement_jobs[_enhancement_id] = ENHANCEMENT_STORE.write(_enhancement_job)
jobs_lock = threading.Lock()
active_job_ids: set[str] = set()
active_enhancement_ids: set[str] = set()
# Large/medium Whisper inference can consume most of a laptop's GPU/RAM. Keep one
# authoritative transcription job active at a time instead of letting multiple UI
# clicks fight over the same model and make every job less reliable.
transcription_slot = threading.Semaphore(1)
STALL_TIMEOUT_SECONDS = 20 * 60
# This is a denial-of-service ceiling for a deliberately paired LAN helper, not a
# product minute quota. Eight GiB comfortably exceeds multi-hour AAC/WAV lectures.
MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
helper_state: dict[str, str | None] = {"warm_status": "starting", "warm_model": None, "warm_error": None}
LAN_MODE = os.getenv("LECTUREAI_LAN_MODE", "0").strip().lower() in {"1", "true", "yes", "on"}
pairing_store = PairingStore(os.getenv("LECTUREAI_PAIRING_CODE") or None)

DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4174",
    "http://127.0.0.1:4174",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://lecture-ai-blush.vercel.app",
)
allowed_origins = [
    origin.strip()
    for origin in os.getenv("LECTUREAI_ALLOWED_ORIGINS", ",".join(DEFAULT_ALLOWED_ORIGINS)).split(",")
    if origin.strip()
]

app = FastAPI(title="LectureAI Local Transcription", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Access-Control-Request-Private-Network"],
)


class PairRequest(BaseModel):
    code: str


def request_host(request: Request) -> str:
    return request.client.host if request.client else ""


def bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "").strip()
    if not header.lower().startswith("bearer "):
        return None
    return header[7:].strip() or None


def request_authorized(request: Request) -> bool:
    if not LAN_MODE:
        return True
    return pairing_store.authorize(request_host(request), bearer_token(request))


def protected_path(path: str) -> bool:
    return path == "/transcribe" or path == "/jobs" or path.startswith("/jobs/") or path == "/enhancements" or path.startswith("/enhancements/")


@app.middleware("http")
async def network_guard(request: Request, call_next):
    # Loopback remains the default. LAN access exists only when explicitly enabled,
    # and even then it is restricted to private/link-local clients plus a paired
    # bearer token before any transcription endpoint is allowed to run.
    if LAN_MODE:
        host = request_host(request)
        if not is_private_client(host):
            return JSONResponse(status_code=403, content={"detail": "LectureAI LAN mode accepts only private/local-network clients."})
        if protected_path(request.url.path) and not request_authorized(request):
            return JSONResponse(status_code=401, content={"detail": "Pair this device with the Windows helper before transcription."})

    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Cache-Control"] = "no-store"
    return response


def configured_model():
    selected = MODELS_DIR / "selected-model.txt"
    if selected.exists():
        choice = selected.read_text(encoding="utf-8").strip()
        if choice in MODEL_INFO:
            return choice
    return hardware_payload()["recommendation"]["model"]


def warm_configured_model():
    model = configured_model()
    helper_state.update({"warm_status": "loading", "warm_model": model, "warm_error": None})
    try:
        with transcription_slot:
            load_model(model, MODELS_DIR)
        helper_state.update({"warm_status": "ready", "warm_model": model, "warm_error": None})
    except Exception as error:
        # Do not stop the helper. A transcription request can retry model loading and
        # surface the detailed error while recording data remains untouched.
        helper_state.update({"warm_status": "failed", "warm_model": model, "warm_error": str(error)[:500]})


@app.on_event("startup")
def start_model_warmup():
    threading.Thread(target=warm_configured_model, name="lectureai-model-warmup", daemon=True).start()
    threading.Thread(target=stall_watchdog, name="lectureai-stall-watchdog", daemon=True).start()


@app.post("/pair")
def pair_device(payload: PairRequest, request: Request):
    if not LAN_MODE:
        raise HTTPException(404, "Wireless pairing is disabled. Start the helper with --lan to enable it deliberately.")
    try:
        session = pairing_store.pair(request_host(request), payload.code)
    except PermissionError as error:
        raise HTTPException(403, str(error)) from error
    except RuntimeError as error:
        raise HTTPException(429, str(error)) from error
    except ValueError as error:
        raise HTTPException(401, str(error)) from error
    return {
        "ok": True,
        "token": session.token,
        "expires_at": session.expires_at,
        "expires_in_seconds": max(0, round(session.expires_at - time.time())),
        "privacy": "authenticated-private-lan",
    }


@app.get("/health")
def health(request: Request):
    cleanup_jobs()
    if LAN_MODE and not request_authorized(request):
        return {
            "ok": True,
            "version": "0.6.0",
            "privacy": "authenticated-private-lan",
            "pairing_required": True,
        }

    with jobs_lock:
        queued = sum(1 for job in jobs.values() if job.get("status") == "queued")
        active = sum(1 for job in jobs.values() if job.get("status") in {"loading-model", "transcribing", "stalled"})
        active_enhancements = sum(1 for job in enhancement_jobs.values() if job.get("status") in {"queued", "processing"})
    return {
        "ok": True,
        "version": "0.6.0",
        "privacy": "authenticated-private-lan" if LAN_MODE else "loopback-only",
        "pairing_required": False,
        "configured_model": configured_model(),
        "active_jobs": active,
        "queued_jobs": queued,
        "active_enhancements": active_enhancements,
        "max_concurrent_transcriptions": 1,
        "transfer_integrity": "md5-when-provided",
        "computer_name": platform.node()[:63] or "Windows computer",
        "server_time": time.time(),
        "durable_jobs": True,
        "job_retention_days": 7,
        "resume_supported": True,
        **helper_state,
        **hardware_payload(),
    }


def resolve_model(choice: str):
    return configured_model() if choice == "configured" else choice


def cleanup_jobs(now: float | None = None):
    expired = JOB_STORE.cleanup(now)
    expired_enhancements = ENHANCEMENT_STORE.cleanup(now)
    with jobs_lock:
        for job_id in expired:
            jobs.pop(job_id, None)
        for job_id in expired_enhancements:
            enhancement_jobs.pop(job_id, None)


def set_job(job_id: str, **patch):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(patch)
            jobs[job_id]["updated_at"] = time.time()
            jobs[job_id] = JOB_STORE.write(jobs[job_id])


def set_enhancement_job(job_id: str, **patch):
    with jobs_lock:
        if job_id in enhancement_jobs:
            enhancement_jobs[job_id].update(patch)
            enhancement_jobs[job_id]["updated_at"] = time.time()
            enhancement_jobs[job_id] = ENHANCEMENT_STORE.write(enhancement_jobs[job_id])


def stall_watchdog():
    while True:
        time.sleep(30)
        now = time.time()
        with jobs_lock:
            candidates = [dict(job) for job in jobs.values() if job.get("status") in {"loading-model", "transcribing"}]
        for job in candidates:
            last_progress = float(job.get("last_progress_at") or job.get("updated_at") or now)
            if now - last_progress >= STALL_TIMEOUT_SECONDS:
                completed = float(job.get("completed_audio_seconds") or 0)
                total = float(job.get("total_audio_seconds") or 0)
                set_job(
                    job["id"],
                    status="stalled",
                    message=f"Transcription appears stalled at {round(completed)} of {round(total)} seconds. Original audio and completed sections are safe.",
                    stalled_at=now,
                )


def public_job(job: dict) -> dict:
    hidden = {"audio_path", "glossary", "owner_host", "cancel_requested"}
    payload = {key: value for key, value in job.items() if key not in hidden}
    payload["resume_available"] = job.get("status") in {"interrupted", "failed", "stalled", "cancelled"} and job.get("id") not in active_job_ids
    payload["worker_active"] = job.get("id") in active_job_ids
    payload["seconds_since_progress"] = max(0, round(time.time() - float(job.get("last_progress_at") or job.get("updated_at") or time.time())))
    started = float(job.get("started_at") or job.get("created_at") or time.time())
    finished = float(job.get("finished_at") or time.time())
    payload["elapsed_seconds"] = max(0, round(finished - started))
    checkpoint = job.get("checkpoint") if isinstance(job.get("checkpoint"), dict) else {}
    processed = float(checkpoint.get("processing_seconds_accumulated") or 0)
    completed = float(job.get("completed_audio_seconds") or 0)
    total = float(job.get("total_audio_seconds") or 0)
    active = job.get("status") in {"loading-model", "transcribing"}
    payload["eta_seconds"] = round((processed / completed) * max(0, total - completed)) if active and processed > 0 and completed > 0 and total > completed else None
    return payload


def progress_stage(message: str) -> str:
    lowered = message.casefold()
    if lowered.startswith("reading recording"):
        return "reading-recording"
    if lowered.startswith("splitting / planning"):
        return "planning-sections"
    if lowered.startswith("loading") or lowered.startswith("model ready"):
        return "loading-model"
    if lowered.startswith("preparing audio"):
        return "preparing-audio"
    if lowered.startswith("cleaning audio"):
        return "cleaning-audio"
    if lowered.startswith("combining transcript"):
        return "combining-transcript"
    return "transcribing"


def owned_job(job_id: str, request: Request) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Transcription job not found or its retained result has expired.")
        if LAN_MODE and job.get("owner_host") != request_host(request):
            raise HTTPException(403, "This transcription job belongs to a different paired device.")
        return dict(job)


def run_job(job_id: str):
    with jobs_lock:
        job = dict(jobs.get(job_id) or {})
        if not job:
            return
        active_job_ids.add(job_id)
    try:
        set_job(job_id, status="queued", stage="queued", progress=5, message="Recording preserved · waiting for the local transcription slot…", started_at=time.time())
        with transcription_slot:
            if bool((jobs.get(job_id) or {}).get("cancel_requested")):
                raise TranscriptionCancelled("Transcription cancelled before the local worker started.")
            model_info = MODEL_INFO.get(job["model"], {})
            set_job(job_id, status="loading-model", stage="loading-model", progress=10, message=f"Loading/downloading {job['model']} multilingual model ({model_info.get('download', 'cached after first use')})…", last_progress_at=time.time(), worker_active=True)

            def progress(value: int, message: str):
                stage = progress_stage(message)
                set_job(job_id, status="loading-model" if stage == "loading-model" else "transcribing", stage=stage, progress=value, message=message, last_progress_at=time.time())

            def cancellation_requested() -> bool:
                with jobs_lock:
                    return bool((jobs.get(job_id) or {}).get("cancel_requested"))

            def checkpoint(payload: dict):
                set_job(
                    job_id,
                    checkpoint=payload,
                    partial_segments=payload.get("segments", []),
                    completed_chunk=payload.get("completed_chunk", -1),
                    completed_audio_seconds=payload.get("completed_audio_seconds", 0),
                    total_audio_seconds=payload.get("total_audio_seconds", 0),
                    total_chunks=payload.get("total_chunks", 0),
                    device=payload.get("device"),
                    compute_type=payload.get("compute_type"),
                    last_progress_at=time.time(),
                    message=f"Checkpoint saved through {round(float(payload.get('completed_audio_seconds') or 0))} of {round(float(payload.get('total_audio_seconds') or 0))} seconds",
                )

            result = transcribe_audio(
                Path(job["audio_path"]),
                job["model"],
                MODELS_DIR,
                list(job.get("glossary") or []),
                progress,
                checkpoint=job.get("checkpoint"),
                checkpoint_callback=checkpoint,
                enhancement=str(job.get("enhancement") or "automatic"),
                working_directory=JOB_STORE.directory(job_id),
                cancellation_check=cancellation_requested,
            )
        result["lectureId"] = str(job.get("lecture_id") or "lecture")[:100]
        set_job(job_id, status="complete", stage="complete", progress=100, message="SOURCE TRANSCRIPT READY · optional translations can be generated separately", result=result, finished_at=time.time(), worker_active=False, cancel_requested=False)
    except TranscriptionCancelled:
        completed = float((jobs.get(job_id) or {}).get("completed_audio_seconds") or 0)
        total = float((jobs.get(job_id) or {}).get("total_audio_seconds") or 0)
        set_job(
            job_id,
            status="cancelled",
            stage="cancelled",
            progress=min(99, int((completed / total) * 100)) if total else 0,
            message=f"Cancelled near {round(completed)} of {round(total)} seconds. Original audio and completed transcript sections are safe and resumable.",
            finished_at=time.time(),
            worker_active=False,
            cancel_requested=False,
        )
    except Exception as error:
        completed = float((jobs.get(job_id) or {}).get("completed_audio_seconds") or 0)
        total = float((jobs.get(job_id) or {}).get("total_audio_seconds") or 0)
        set_job(
            job_id,
            status="failed",
            stage="failed",
            progress=min(99, int((completed / total) * 100)) if total else 0,
            message=f"Windows transcription stopped near {round(completed)} of {round(total)} seconds. Original audio and completed sections are safe.",
            error=str(error)[:1000],
            finished_at=time.time(),
            worker_active=False,
        )
    finally:
        with jobs_lock:
            active_job_ids.discard(job_id)


def parse_glossary(glossary: str):
    try:
        glossary_terms = json.loads(glossary)
        if not isinstance(glossary_terms, list):
            raise ValueError
        return [str(term)[:120] for term in glossary_terms[:250]]
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(400, "Glossary must be a JSON array.")


def normalize_expected_md5(value: str) -> str | None:
    candidate = str(value or "").strip().lower()
    if not candidate:
        return None
    if len(candidate) != 32 or any(character not in "0123456789abcdef" for character in candidate):
        raise HTTPException(400, "audioMd5 must be a 32-character hexadecimal MD5 value.")
    return candidate


def ensure_upload_space(directory: Path, incoming_bytes: int = 0):
    """Protect the disk without imposing a LectureAI file-size or minute quota."""
    free = shutil.disk_usage(directory).free
    reserve = max(512 * 1024 * 1024, incoming_bytes)
    if free < reserve:
        raise HTTPException(507, "Not enough free disk space to keep receiving this recording safely.")


async def save_upload(audio: UploadFile, directory: Path, expected_md5: str | None = None):
    suffix = Path(audio.filename or "lecture.webm").suffix.lower()
    if suffix not in {".webm", ".m4a", ".mp4", ".wav", ".mp3", ".ogg", ".flac", ".aac"}:
        suffix = ".audio"
    target = directory / f"original{suffix}"
    total = 0
    digest = hashlib.md5()  # integrity check only; not used for authentication/security
    ensure_upload_space(directory)
    with target.open("wb") as output:
        while chunk := await audio.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "The transferred recording exceeds the helper's 8 GiB safety limit. The phone original was not modified.")
            digest.update(chunk)
            if total % (64 * 1024 * 1024) < len(chunk):
                ensure_upload_space(directory, max(512 * 1024 * 1024, total // 4))
            output.write(chunk)
    if not total:
        raise HTTPException(400, "The transferred recording is empty.")

    received_md5 = digest.hexdigest()
    if expected_md5 and received_md5 != expected_md5:
        target.unlink(missing_ok=True)
        raise HTTPException(400, "The transferred recording did not match the preserved phone file. Retry the transfer; the phone original was not modified.")

    ensure_upload_space(directory, max(512 * 1024 * 1024, min(total, 2 * 1024 * 1024 * 1024)))
    return target, received_md5, total


def public_enhancement_job(job: dict) -> dict:
    hidden = {"audio_path", "output_path", "owner_host"}
    payload = {key: value for key, value in job.items() if key not in hidden}
    payload["worker_active"] = job.get("id") in active_enhancement_ids
    payload["download_ready"] = job.get("status") == "complete" and Path(str(job.get("output_path") or "")).is_file()
    return payload


def owned_enhancement_job(job_id: str, request: Request) -> dict:
    with jobs_lock:
        job = enhancement_jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Enhanced-audio job not found or its temporary Windows copy has expired.")
        if LAN_MODE and job.get("owner_host") != request_host(request):
            raise HTTPException(403, "This enhanced-audio job belongs to a different paired device.")
        return dict(job)


def run_enhancement_job(job_id: str):
    with jobs_lock:
        job = dict(enhancement_jobs.get(job_id) or {})
        if not job:
            return
        active_enhancement_ids.add(job_id)
    try:
        set_enhancement_job(job_id, status="processing", progress=3, message="Verifying protected source copy before cleanup", started_at=time.time())
        with transcription_slot:
            source = Path(job["audio_path"])
            output = Path(job["output_path"])
            duration = audio_duration_seconds(source)
            expected_wav_bytes = int(duration * 16_000 * 2) + 44
            ensure_upload_space(output.parent, max(int(job.get("audio_size") or 0), expected_wav_bytes))

            def progress(value: int, message: str):
                set_enhancement_job(job_id, status="processing", progress=value, message=message)

            result = write_enhanced_copy(source, output, str(job.get("cleanup_mode") or "balanced"), progress_callback=progress)
        set_enhancement_job(
            job_id,
            status="complete",
            progress=100,
            message="Enhanced-for-transcription copy ready · protected source hash unchanged",
            result=result,
            finished_at=time.time(),
        )
    except Exception as error:
        set_enhancement_job(
            job_id,
            status="failed",
            progress=0,
            message="Enhanced-copy generation stopped. The phone original and uploaded source copy were not modified.",
            error=str(error)[:1000],
            finished_at=time.time(),
        )
    finally:
        with jobs_lock:
            active_enhancement_ids.discard(job_id)


@app.post("/enhancements", status_code=202)
async def create_enhancement_job(
    background_tasks: BackgroundTasks,
    request: Request,
    audio: UploadFile = File(...),
    lectureId: str = Form("lecture"),
    audioMd5: str = Form(""),
    cleanupMode: str = Form("balanced"),
):
    cleanup_jobs()
    expected_md5 = normalize_expected_md5(audioMd5)
    try:
        cleanup_mode = normalize_cleanup_mode(cleanupMode)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    owner_host = request_host(request)
    if expected_md5:
        with jobs_lock:
            existing = next((
                job for job in enhancement_jobs.values()
                if job.get("source_md5") == expected_md5
                and job.get("lecture_id") == lectureId[:100]
                and job.get("owner_host") == owner_host
                and job.get("cleanup_mode") == cleanup_mode
                and job.get("status") == "complete"
                and Path(str(job.get("output_path") or "")).is_file()
            ), None)
        if existing:
            return {"job_id": existing["id"], "status": "complete", "integrity_checked": True, "reused": True}

    job_id = uuid.uuid4().hex
    directory = ENHANCEMENT_STORE.directory(job_id)
    directory.mkdir(parents=True, exist_ok=False)
    try:
        target, received_md5, total = await save_upload(audio, directory, expected_md5)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    created_at = time.time()
    record = {
        "id": job_id,
        "kind": "enhanced-audio",
        "lecture_id": lectureId[:100],
        "owner_host": owner_host,
        "audio_path": str(target),
        "output_path": str(directory / f"enhanced-{cleanup_mode}.wav"),
        "source_md5": received_md5,
        "audio_size": total,
        "cleanup_mode": cleanup_mode,
        "status": "queued",
        "progress": 1,
        "message": "Protected source copy received and integrity-checked · waiting to create derived audio",
        "created_at": created_at,
        "updated_at": created_at,
    }
    with jobs_lock:
        enhancement_jobs[job_id] = ENHANCEMENT_STORE.write(record)
    background_tasks.add_task(run_enhancement_job, job_id)
    return {"job_id": job_id, "status": "queued", "integrity_checked": bool(expected_md5)}


@app.get("/enhancements/{job_id}")
def get_enhancement_job(job_id: str, request: Request):
    cleanup_jobs()
    return public_enhancement_job(owned_enhancement_job(job_id, request))


@app.get("/enhancements/{job_id}/audio")
def download_enhancement(job_id: str, request: Request):
    job = owned_enhancement_job(job_id, request)
    if job.get("status") != "complete":
        raise HTTPException(409, "The enhanced copy is not ready to download.")
    output = Path(str(job.get("output_path") or ""))
    if not output.is_file():
        raise HTTPException(410, "The temporary Windows enhanced copy is no longer available. Generate it again; the original is safe.")
    result = job.get("result") if isinstance(job.get("result"), dict) else {}
    return FileResponse(
        output,
        media_type="audio/wav",
        filename=f"lectureai-{job.get('cleanup_mode', 'balanced')}-enhanced.wav",
        headers={
            "X-LectureAI-Source-MD5": str(result.get("source_md5") or job.get("source_md5") or ""),
            "X-LectureAI-Enhanced-MD5": str(result.get("enhanced_md5") or ""),
        },
    )


@app.post("/enhancements/{job_id}/release")
def release_enhancement(job_id: str, request: Request):
    job = owned_enhancement_job(job_id, request)
    if job_id in active_enhancement_ids:
        raise HTTPException(409, "The enhanced copy is still being created.")
    with jobs_lock:
        enhancement_jobs.pop(job_id, None)
    ENHANCEMENT_STORE.remove(job_id)
    return {"ok": True, "released": True}


@app.post("/jobs", status_code=202)
async def create_job(
    background_tasks: BackgroundTasks,
    request: Request,
    audio: UploadFile = File(...),
    model: str = Form("configured"),
    glossary: str = Form("[]"),
    lectureId: str = Form("lecture"),
    audioMd5: str = Form(""),
    enhancement: str = Form("balanced"),
):
    cleanup_jobs()
    model = resolve_model(model)
    if model not in MODEL_INFO:
        raise HTTPException(400, "Choose small, medium, or large-v3.")
    glossary_terms = parse_glossary(glossary)
    expected_md5 = normalize_expected_md5(audioMd5)
    try:
        enhancement = normalize_cleanup_mode(enhancement)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    owner_host = request_host(request)
    if expected_md5:
        with jobs_lock:
            existing = next((job for job in jobs.values() if job.get("audio_md5") == expected_md5 and job.get("lecture_id") == lectureId[:100] and job.get("owner_host") == owner_host and job.get("model") == model and normalize_cleanup_mode(str(job.get("enhancement") or "balanced")) == enhancement), None)
        if existing:
            return {"job_id": existing["id"], "status": existing["status"], "integrity_checked": True, "reused": True}

    job_id = uuid.uuid4().hex
    directory = JOB_STORE.directory(job_id)
    directory.mkdir(parents=True, exist_ok=False)
    try:
        target, received_md5, total = await save_upload(audio, directory, expected_md5)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    created_at = time.time()
    record = {
        "id": job_id,
        "lecture_id": lectureId[:100],
        "owner_host": owner_host,
        "audio_path": str(target),
        "audio_md5": received_md5,
        "audio_size": total,
        "model": model,
        "glossary": glossary_terms,
        "enhancement": enhancement,
        "checkpoint": None,
        "partial_segments": [],
        "completed_chunk": -1,
        "completed_audio_seconds": 0,
        "total_audio_seconds": 0,
        "status": "queued",
        "stage": "queued",
        "progress": 3,
        "message": "Recording received and integrity-checked · waiting for local transcription" if expected_md5 else "Recording received · waiting for local transcription",
        "created_at": created_at,
        "updated_at": created_at,
        "last_progress_at": created_at,
        "worker_active": False,
    }
    with jobs_lock:
        jobs[job_id] = JOB_STORE.write(record)
    background_tasks.add_task(run_job, job_id)
    return {"job_id": job_id, "status": "queued", "integrity_checked": bool(expected_md5)}


@app.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    cleanup_jobs()
    return public_job(owned_job(job_id, request))


@app.post("/jobs/{job_id}/resume", status_code=202)
def resume_job(job_id: str, background_tasks: BackgroundTasks, request: Request):
    job = owned_job(job_id, request)
    if job_id in active_job_ids:
        raise HTTPException(409, "This job still has an active worker. Wait for it or restart the helper before resuming a confirmed stall.")
    if job.get("status") == "complete":
        return public_job(job)
    if job.get("status") not in {"interrupted", "failed", "stalled", "cancelled"}:
        raise HTTPException(409, "This job is not in a resumable state.")
    if not Path(str(job.get("audio_path") or "")).is_file():
        raise HTTPException(410, "The retained Windows audio copy is unavailable. Export the protected phone original and create a new job.")
    set_job(job_id, status="queued", stage="queued", progress=max(3, int(job.get("progress") or 0)), message="Resume requested · completed sections remain checkpointed", error=None, finished_at=None, cancel_requested=False)
    background_tasks.add_task(run_job, job_id)
    return public_job(dict(jobs[job_id]))


@app.post("/jobs/{job_id}/retry-current", status_code=202)
def retry_current_section(job_id: str, background_tasks: BackgroundTasks, request: Request):
    job = owned_job(job_id, request)
    if job_id in active_job_ids:
        raise HTTPException(409, "The current worker is still active. Cancel it first, or wait for the section to finish safely.")
    if job.get("status") not in {"interrupted", "failed", "stalled", "cancelled"}:
        raise HTTPException(409, "There is no failed or interrupted section to retry.")
    if not Path(str(job.get("audio_path") or "")).is_file():
        raise HTTPException(410, "The retained Windows audio copy is unavailable. Export the protected phone original and create a new job.")
    set_job(job_id, status="queued", stage="queued", progress=max(3, int(job.get("progress") or 0)), message="Retrying the first unfinished section · earlier checkpoints remain unchanged", error=None, finished_at=None, cancel_requested=False)
    background_tasks.add_task(run_job, job_id)
    return public_job(dict(jobs[job_id]))


@app.post("/jobs/{job_id}/cancel", status_code=202)
def cancel_job(job_id: str, request: Request):
    job = owned_job(job_id, request)
    if job.get("status") == "complete":
        return public_job(job)
    if job.get("status") in {"failed", "interrupted", "stalled", "cancelled"} and job_id not in active_job_ids:
        set_job(job_id, status="cancelled", stage="cancelled", message="Cancelled. Original audio and completed transcript sections remain safe and resumable.", cancel_requested=False)
    else:
        set_job(job_id, cancel_requested=True, message="Cancel requested · safely stopping after the current inference boundary; completed sections will remain resumable")
    return public_job(dict(jobs[job_id]))


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    model: str = Form("configured"),
    glossary: str = Form("[]"),
    lectureId: str = Form("lecture"),
    audioMd5: str = Form(""),
):
    model = resolve_model(model)
    if model not in MODEL_INFO:
        raise HTTPException(400, "Choose small, medium, or large-v3.")
    glossary_terms = parse_glossary(glossary)
    expected_md5 = normalize_expected_md5(audioMd5)
    directory = RUNTIME_DIR / "legacy" / uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=False)
    try:
        target, _received_md5, _total = await save_upload(audio, directory, expected_md5)
        try:
            with transcription_slot:
                result = transcribe_audio(target, model, MODELS_DIR, glossary_terms)
        except Exception as error:
            raise HTTPException(500, f"Local transcription failed: {error}") from error
        result["lectureId"] = lectureId[:100]
        return result
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def local_ipv4() -> str | None:
    # Determine the address Windows would normally use on the current LAN without
    # sending application data. Fall back cleanly when offline.
    configured = os.getenv("LECTUREAI_LAN_ADDRESS", "").strip()
    if configured and is_private_client(configured) and not configured.startswith("127."):
        return configured
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        address = sock.getsockname()[0]
        return address if is_private_client(address) and not address.startswith("127.") else None
    except OSError:
        return None
    finally:
        sock.close()


def valid_lan_bind_host(value: str | None) -> bool:
    """LAN listener must be a concrete trusted IPv4, never wildcard/public."""
    try:
        address = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return False
    return (
        isinstance(address, ipaddress.IPv4Address)
        and is_private_client(str(address))
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_unspecified
    )


def write_pairing_qr(address: str, code: str, target: Path | None = None) -> Path | None:
    """Write a scannable runtime QR without printing its temporary code."""
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_M
        payload = laptop_pairing_qr(address, code)
        target = target or ROOT / ".lectureai-runtime" / "laptop-ai-pairing-qr.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        # A large, crisp image scans reliably from an ordinary Windows display.
        qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=16, border=4)
        qr.add_data(payload)
        qr.make(fit=True)
        qr.make_image(fill_color="black", back_color="white").save(target)
        return target
    except Exception as error:
        print(f"QR image could not be created ({error}). The visible address/code still work in Advanced pairing.")
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LectureAI private local transcription helper")
    parser.add_argument("--lan", action="store_true", help="Allow explicitly paired iPhone/iPad clients on the same private LAN")
    parser.add_argument("--port", type=int, default=int(os.getenv("LECTUREAI_HELPER_PORT", "8765")))
    parser.add_argument("--host", help="Private IPv4 address to bind in LAN mode (the Windows launcher chooses this safely)")
    parser.add_argument("--pairing-qr-path", help="Runtime path for the temporary pairing QR (its contents are never logged)")
    args = parser.parse_args()
    if args.lan:
        LAN_MODE = True

    if LAN_MODE:
        address = args.host or local_ipv4()
        if not valid_lan_bind_host(address):
            raise SystemExit("LectureAI needs one concrete private Wi-Fi/Ethernet IPv4 address for phone pairing. Empty, malformed, loopback, link-local, and public addresses are rejected. Re-run Start LectureAI Laptop AI.bat after connecting both devices to the same private Wi-Fi.")
        public_address = f"http://{address}:{args.port}"
        print("LectureAI authenticated LAN transcription is ON.")
        print(f"Computer address for LectureAI: {public_address}")
        qr_target = Path(args.pairing_qr_path).resolve() if args.pairing_qr_path else None
        qr_file = write_pairing_qr(public_address, pairing_store.code, qr_target)
        if qr_file:
            print("Temporary pairing QR image is ready in the private runtime directory.")
        print("Only paired private-LAN clients can submit or read transcription jobs.")
        print("Use this only on a trusted private network; LAN HTTP is authenticated but not end-to-end encrypted.")
        print("Audio is copied only to this computer for local transcription. Press Ctrl+C to stop.")
        uvicorn.run(app, host=address, port=args.port, log_level="info")
    else:
        print(f"LectureAI local transcription: http://127.0.0.1:{args.port}")
        print("Audio stays on this computer. Add --lan only when you deliberately want paired iPhone/iPad access.")
        print("Press Ctrl+C to stop.")
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
