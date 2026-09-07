from __future__ import annotations

import hashlib
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


# Keep this deliberately gentle. It targets steady classroom noise/rumble on a
# temporary transcription copy and is not intended to erase competing speakers.
BALANCED_FILTER = "highpass=f=70,lowpass=f=7600,afftdn=nr=10:tn=1"


@dataclass
class AudioPreparation:
    source_path: str
    transcription_path: str
    mode: str
    applied: bool
    reason: str
    filter_chain: str | None = None
    source_sha256_before: str | None = None
    source_sha256_after: str | None = None

    def payload(self) -> dict[str, object]:
        return asdict(self)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_audio_copy(source: Path, directory: Path, mode: str = "balanced") -> AudioPreparation:
    """Create a disposable speech-oriented copy for ASR without touching source.

    `balanced` uses FFmpeg when available to remove low rumble, unnecessary high
    frequencies, and a modest amount of stationary background noise such as AC/fan
    noise. If FFmpeg is absent or preprocessing fails, transcription safely falls
    back to the untouched original rather than failing the lecture.
    """
    source = source.resolve()
    directory = directory.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Audio file not found: {source}")
    if mode not in {"off", "balanced"}:
        raise ValueError("Audio enhancement mode must be 'off' or 'balanced'.")

    source_hash_before = _sha256(source)
    if mode == "off":
        return AudioPreparation(
            source_path=str(source),
            transcription_path=str(source),
            mode=mode,
            applied=False,
            reason="disabled",
            source_sha256_before=source_hash_before,
            source_sha256_after=source_hash_before,
        )

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return AudioPreparation(
            source_path=str(source),
            transcription_path=str(source),
            mode=mode,
            applied=False,
            reason="ffmpeg-not-found; original audio used",
            filter_chain=BALANCED_FILTER,
            source_sha256_before=source_hash_before,
            source_sha256_after=source_hash_before,
        )

    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "speech-enhanced-for-transcription.wav"
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        BALANCED_FILTER,
        str(target),
    ]

    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        if completed.returncode != 0 or not target.is_file() or target.stat().st_size < 1024:
            reason = (completed.stderr or "FFmpeg did not create a usable transcription copy").strip()[-500:]
            target.unlink(missing_ok=True)
            source_hash_after = _sha256(source)
            if source_hash_after != source_hash_before:
                raise RuntimeError("Original audio changed during preprocessing; transcription was stopped.")
            return AudioPreparation(
                source_path=str(source),
                transcription_path=str(source),
                mode=mode,
                applied=False,
                reason=f"preprocessing-failed; original audio used: {reason}",
                filter_chain=BALANCED_FILTER,
                source_sha256_before=source_hash_before,
                source_sha256_after=source_hash_after,
            )
    except OSError as error:
        source_hash_after = _sha256(source)
        if source_hash_after != source_hash_before:
            raise RuntimeError("Original audio changed during preprocessing; transcription was stopped.") from error
        return AudioPreparation(
            source_path=str(source),
            transcription_path=str(source),
            mode=mode,
            applied=False,
            reason=f"preprocessing-unavailable; original audio used: {error}",
            filter_chain=BALANCED_FILTER,
            source_sha256_before=source_hash_before,
            source_sha256_after=source_hash_after,
        )

    source_hash_after = _sha256(source)
    if source_hash_after != source_hash_before:
        target.unlink(missing_ok=True)
        raise RuntimeError("Original audio changed during preprocessing; transcription was stopped.")

    return AudioPreparation(
        source_path=str(source),
        transcription_path=str(target),
        mode=mode,
        applied=True,
        reason="temporary mono 16 kHz speech copy with gentle stationary-noise reduction",
        filter_chain=BALANCED_FILTER,
        source_sha256_before=source_hash_before,
        source_sha256_after=source_hash_after,
    )
