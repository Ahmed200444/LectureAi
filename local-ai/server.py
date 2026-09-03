from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from engine import MODEL_INFO, hardware_payload, load_model, transcribe_audio
from pairing import PairingStore, is_private_client

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
# Large/medium Whisper inference can consume most of a laptop's GPU/RAM. Keep one
# authoritative transcription job active at a time instead of letting multiple UI
# clicks fight over the same model and make every job less reliable.
transcription_slot = threading.Semaphore(1)
JOB_RETENTION_SECONDS = 60 * 60
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
    return path == "/transcribe" or path == "/jobs" or path.startswith("/jobs/")


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
            "version": "0.5.0",
            "privacy": "authenticated-private-lan",
            "pairing_required": True,
        }

    with jobs_lock:
        queued = sum(1 for job in jobs.values() if job.get("status") == "queued")
        active = sum(1 for job in jobs.values() if job.get("status") in {"loading-model", "transcribing"})
    return {
        "ok": True,
        "version": "0.5.0",
        "privacy": "authenticated-private-lan" if LAN_MODE else "loopback-only",
        "pairing_required": False,
        "configured_model": configured_model(),
        "active_jobs": active,
        "queued_jobs": queued,
        "max_concurrent_transcriptions": 1,
        **helper_state,
        **hardware_payload(),
    }


def resolve_model(choice: str):
    return configured_model() if choice == "configured" else choice


def cleanup_jobs(now: float | None = None):
    cutoff = (now or time.time()) - JOB_RETENTION_SECONDS
    with jobs_lock:
        expired = [
            job_id
            for job_id, job in jobs.items()
            if job.get("status") in {"complete", "failed"}
            and float(job.get("finished_at") or 0) < cutoff
        ]
        for job_id in expired:
            jobs.pop(job_id, None)


def set_job(job_id: str, **patch):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(patch)
            jobs[job_id]["updated_at"] = time.time()


def run_job(job_id: str, target: Path, directory: Path, model: str, glossary_terms: list[str], lecture_id: str):
    try:
        set_job(job_id, status="queued", progress=5, message="Recording preserved · waiting for the local transcription slot…")
        with transcription_slot:
            set_job(job_id, status="loading-model", progress=10, message=f"Loading {model} multilingual model…")
            result = transcribe_audio(
                target,
                model,
                MODELS_DIR,
                glossary_terms,
                lambda value, message: set_job(job_id, status="transcribing", progress=value, message=message),
            )
        result["lectureId"] = lecture_id[:100]
        set_job(job_id, status="complete", progress=100, message="Transcript ready", result=result, finished_at=time.time())
    except Exception as error:
        set_job(job_id, status="failed", progress=100, message="Transcription failed", error=str(error), finished_at=time.time())
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def parse_glossary(glossary: str):
    try:
        glossary_terms = json.loads(glossary)
        if not isinstance(glossary_terms, list):
            raise ValueError
        return [str(term)[:120] for term in glossary_terms[:250]]
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(400, "Glossary must be a JSON array.")


def ensure_upload_space(directory: Path, incoming_bytes: int = 0):
    """Protect the disk without imposing a LectureAI file-size or minute quota."""
    free = shutil.disk_usage(directory).free
    reserve = max(512 * 1024 * 1024, incoming_bytes)
    if free < reserve:
        raise HTTPException(507, "Not enough free disk space to keep receiving this recording safely.")


async def save_upload(audio: UploadFile, directory: Path):
    suffix = Path(audio.filename or "lecture.webm").suffix.lower()
    if suffix not in {".webm", ".m4a", ".mp4", ".wav", ".mp3", ".ogg", ".flac", ".aac"}:
        suffix = ".audio"
    target = directory / f"original{suffix}"
    total = 0
    ensure_upload_space(directory)
    with target.open("wb") as output:
        while chunk := await audio.read(1024 * 1024):
            total += len(chunk)
            if total % (64 * 1024 * 1024) < len(chunk):
                ensure_upload_space(directory, max(512 * 1024 * 1024, total // 4))
            output.write(chunk)
    if not total:
        raise HTTPException(400, "The transferred recording is empty.")
    ensure_upload_space(directory, max(512 * 1024 * 1024, min(total, 2 * 1024 * 1024 * 1024)))
    return target


@app.post("/jobs", status_code=202)
async def create_job(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    model: str = Form("configured"),
    glossary: str = Form("[]"),
    lectureId: str = Form("lecture"),
):
    cleanup_jobs()
    model = resolve_model(model)
    if model not in MODEL_INFO:
        raise HTTPException(400, "Choose small, medium, or large-v3.")
    glossary_terms = parse_glossary(glossary)
    directory = Path(tempfile.mkdtemp(prefix="lectureai-job-"))
    try:
        target = await save_upload(audio, directory)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    job_id = uuid.uuid4().hex
    created_at = time.time()
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 3,
            "message": "Recording received · waiting for local transcription",
            "created_at": created_at,
            "updated_at": created_at,
        }
    background_tasks.add_task(run_job, job_id, target, directory, model, glossary_terms, lectureId)
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    cleanup_jobs()
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Transcription job not found or its completed result has expired.")
        return dict(job)


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    model: str = Form("configured"),
    glossary: str = Form("[]"),
    lectureId: str = Form("lecture"),
):
    model = resolve_model(model)
    if model not in MODEL_INFO:
        raise HTTPException(400, "Choose small, medium, or large-v3.")
    glossary_terms = parse_glossary(glossary)
    with tempfile.TemporaryDirectory(prefix="lectureai-") as directory:
        target = await save_upload(audio, Path(directory))
        try:
            with transcription_slot:
                result = transcribe_audio(target, model, MODELS_DIR, glossary_terms)
        except Exception as error:
            raise HTTPException(500, f"Local transcription failed: {error}") from error
        result["lectureId"] = lectureId[:100]
        return result


def local_ipv4() -> str | None:
    # Determine the address Windows would normally use on the current LAN without
    # sending application data. Fall back cleanly when offline.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        address = sock.getsockname()[0]
        return address if is_private_client(address) and not address.startswith("127.") else None
    except OSError:
        return None
    finally:
        sock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LectureAI private local transcription helper")
    parser.add_argument("--lan", action="store_true", help="Allow explicitly paired iPhone/iPad clients on the same private LAN")
    parser.add_argument("--port", type=int, default=int(os.getenv("LECTUREAI_HELPER_PORT", "8765")))
    args = parser.parse_args()
    if args.lan:
        LAN_MODE = True

    if LAN_MODE:
        address = local_ipv4()
        print("LectureAI authenticated LAN transcription is ON.")
        print(f"Pairing code: {pairing_store.code}")
        if address:
            print(f"Computer address for LectureAI: http://{address}:{args.port}")
        else:
            print(f"Computer address: use this PC's private IPv4 address with port {args.port}.")
        print("Only paired private-LAN clients can submit or read transcription jobs.")
        print("Audio is copied only to this computer for local transcription. Press Ctrl+C to stop.")
        uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")
    else:
        print(f"LectureAI local transcription: http://127.0.0.1:{args.port}")
        print("Audio stays on this computer. Add --lan only when you deliberately want paired iPhone/iPad access.")
        print("Press Ctrl+C to stop.")
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
