from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
COMPLETED_RETENTION_SECONDS = 7 * 24 * 60 * 60
INCOMPLETE_RETENTION_SECONDS = 30 * 24 * 60 * 60


class JobStore:
    """Atomic local persistence for resumable transcription jobs.

    Pairing codes and bearer tokens are deliberately never accepted by this API.
    """

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def directory(self, job_id: str) -> Path:
        if not job_id or any(character not in "0123456789abcdef" for character in job_id.lower()):
            raise ValueError("Invalid transcription job ID.")
        directory = (self.root / job_id.lower()).resolve()
        if directory.parent != self.root:
            raise ValueError("Invalid transcription job path.")
        return directory

    def state_path(self, job_id: str) -> Path:
        return self.directory(job_id) / "job.json"

    def write(self, job: dict[str, Any]) -> dict[str, Any]:
        record = dict(job)
        record["schema_version"] = SCHEMA_VERSION
        record["updated_at"] = float(record.get("updated_at") or time.time())
        # Defensive refusal prevents future callers from leaking authentication
        # material into persistent lecture job metadata.
        forbidden = {"token", "bearer", "bearer_token", "pairing_code", "authorization"}

        def contains_secret_key(value: Any) -> bool:
            if isinstance(value, dict):
                return any(str(key).casefold() in forbidden or contains_secret_key(nested) for key, nested in value.items())
            if isinstance(value, (list, tuple)):
                return any(contains_secret_key(item) for item in value)
            return False

        if contains_secret_key(record):
            raise ValueError("Authentication secrets may not be persisted in transcription jobs.")
        path = self.state_path(str(record["id"]))
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".json.partial")
            temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, path)
        return record

    def read(self, job_id: str) -> dict[str, Any] | None:
        path = self.state_path(job_id)
        with self._lock:
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION or value.get("id") != job_id:
            return None
        return value

    def load_all(self) -> dict[str, dict[str, Any]]:
        loaded: dict[str, dict[str, Any]] = {}
        with self._lock:
            directories = list(self.root.iterdir()) if self.root.exists() else []
        for directory in directories:
            if not directory.is_dir():
                continue
            try:
                job = self.read(directory.name)
            except ValueError:
                continue
            if job:
                loaded[directory.name] = job
        return loaded

    def mark_unfinished_interrupted(self) -> dict[str, dict[str, Any]]:
        jobs = self.load_all()
        active = {"queued", "loading-model", "transcribing", "stalled"}
        for job_id, job in jobs.items():
            if job.get("status") in active:
                job.update({
                    "status": "interrupted",
                    "message": "Windows helper restarted. Completed transcript sections are safe; resume to continue from the next section.",
                    "worker_active": False,
                    "interrupted_at": time.time(),
                })
                jobs[job_id] = self.write(job)
        return jobs

    def remove(self, job_id: str) -> None:
        directory = self.directory(job_id)
        if directory.parent == self.root:
            shutil.rmtree(directory, ignore_errors=True)

    def cleanup(self, now: float | None = None) -> list[str]:
        current = now or time.time()
        removed: list[str] = []
        for job_id, job in self.load_all().items():
            # Successful results may be pruned sooner. Failed/interrupted jobs keep
            # their upload and checkpoint for the longer recovery window.
            completed = job.get("status") == "complete"
            retention = COMPLETED_RETENTION_SECONDS if completed else INCOMPLETE_RETENTION_SECONDS
            reference = float(job.get("finished_at") or job.get("updated_at") or job.get("created_at") or current)
            if current - reference > retention:
                self.remove(job_id)
                removed.append(job_id)
        return removed
