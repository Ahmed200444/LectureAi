from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import uuid
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from engine import MODEL_INFO, hardware_payload, transcribe_audio

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4174",
    "http://127.0.0.1:4174",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://lecture-ai-blush.vercel.app",
    "https://lectureai-ahmed.ahmedalkadi02.chatgpt.site",
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
    allow_headers=["Content-Type", "Access-Control-Request-Private-Network"],
)


@app.middleware("http")
async def private_network_header(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health")
def health():
    return {"ok": True, "version": "0.3.0", "privacy": "loopback-only", "configured_model": configured_model(), **hardware_payload()}


def configured_model():
    selected = MODELS_DIR / "selected-model.txt"
    if selected.exists():
        choice = selected.read_text(encoding="utf-8").strip()
        if choice in MODEL_INFO:
            return choice
    return hardware_payload()["recommendation"]["model"]


def resolve_model(choice: str):
    return configured_model() if choice == "configured" else choice


def set_job(job_id: str, **patch):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(patch)


def run_job(job_id: str, target: Path, directory: Path, model: str, glossary_terms: list[str], lecture_id: str):
    try:
        set_job(job_id, status="loading-model", progress=10, message=f"Loading {model} multilingual model…")
        result = transcribe_audio(
            target,
            model,
            MODELS_DIR,
            glossary_terms,
            lambda value, message: set_job(job_id, status="transcribing", progress=value, message=message),
        )
        result["lectureId"] = lecture_id[:100]
        set_job(job_id, status="complete", progress=100, message="Transcript ready", result=result)
    except Exception as error:
        set_job(job_id, status="failed", progress=100, message="Transcription failed", error=str(error))
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
    with jobs_lock:
        jobs[job_id] = {"id": job_id, "status": "queued", "progress": 3, "message": "Recording received · waiting for local transcription"}
    background_tasks.add_task(run_job, job_id, target, directory, model, glossary_terms, lectureId)
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Transcription job not found.")
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
            result = transcribe_audio(target, model, MODELS_DIR, glossary_terms)
        except Exception as error:
            raise HTTPException(500, f"Local transcription failed: {error}") from error
        result["lectureId"] = lectureId[:100]
        return result


if __name__ == "__main__":
    print("LectureAI local transcription: http://127.0.0.1:8765")
    print("Audio stays on this computer. Press Ctrl+C to stop.")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
