from __future__ import annotations

import hashlib
import math
import os
import wave
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

import av
import numpy as np

from audio_enhancement import enhance_speech_pcm

SAMPLE_RATE = 16_000
CANONICAL_CLEANUP_MODES = {"off", "balanced", "strong"}
# Keep the earlier API values readable so retained jobs and older Expo clients can
# resume safely after this upgrade. New callers use off/balanced/strong.
CLEANUP_MODE_ALIASES = {
    "original": "off",
    "automatic": "balanced",
    "enhanced": "strong",
}
SUPPORTED_ENHANCEMENT_MODES = CANONICAL_CLEANUP_MODES | set(CLEANUP_MODE_ALIASES)


def normalize_cleanup_mode(mode: str) -> str:
    requested = str(mode or "balanced").strip().lower()
    normalized = CLEANUP_MODE_ALIASES.get(requested, requested)
    if normalized not in CANONICAL_CLEANUP_MODES:
        raise ValueError("Cleanup must be off, balanced, or strong.")
    return normalized


def file_md5(path: Path) -> str:
    digest = hashlib.md5()  # Transfer/integrity identity only, never authentication.
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def audio_duration_seconds(path: Path) -> float:
    """Read container timing without decoding a full lecture into memory."""
    with av.open(str(path), mode="r") as container:
        streams = [stream for stream in container.streams if stream.type == "audio"]
        if not streams:
            raise ValueError("The recording contains no audio stream.")
        stream = streams[0]
        if stream.duration is not None and stream.time_base is not None:
            duration = float(stream.duration * stream.time_base)
        elif container.duration is not None:
            duration = float(container.duration / av.time_base)
        else:
            duration = 0.0
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("The recording duration could not be determined safely.")
        return duration


def _window_pcm(path: Path, start_seconds: float, end_seconds: float) -> np.ndarray:
    """Decode only the requested time range into mono 16 kHz signed PCM."""
    if start_seconds < 0 or end_seconds <= start_seconds:
        raise ValueError("Invalid transcription window boundaries.")

    pieces: list[np.ndarray] = []
    with av.open(str(path), mode="r") as container:
        streams = [stream for stream in container.streams if stream.type == "audio"]
        if not streams:
            raise ValueError("The recording contains no audio stream.")
        stream = streams[0]
        seek_seconds = max(0.0, start_seconds - 1.0)
        container.seek(int(seek_seconds * av.time_base), any_frame=False, backward=True)
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        fallback_time = seek_seconds

        for frame in container.decode(stream):
            frame_time = float(frame.time) if frame.time is not None else fallback_time
            fallback_time = frame_time + float(frame.samples / max(frame.sample_rate or SAMPLE_RATE, 1))
            if frame_time > end_seconds + 1.0:
                break
            converted = resampler.resample(frame)
            for output in converted:
                output_time = float(output.time) if output.time is not None else frame_time
                samples = output.to_ndarray().reshape(-1)
                output_end = output_time + samples.size / SAMPLE_RATE
                if output_end <= start_seconds or output_time >= end_seconds:
                    continue
                left = max(0, int(math.floor((start_seconds - output_time) * SAMPLE_RATE)))
                right = min(samples.size, int(math.ceil((end_seconds - output_time) * SAMPLE_RATE)))
                if right > left:
                    pieces.append(np.asarray(samples[left:right], dtype=np.int16).copy())

    if not pieces:
        raise ValueError("No audio samples were decoded for this transcription section.")
    return np.concatenate(pieces)


def _enhance_speech_pcm(samples: np.ndarray, mode: str) -> tuple[np.ndarray, dict[str, float | str | bool]]:
    requested_mode = str(mode or "balanced").strip().lower()
    mode = normalize_cleanup_mode(requested_mode)
    if mode == "off" or not samples.size:
        floating = samples.astype(np.float32) / 32768.0
        original_rms = float(np.sqrt(np.mean(np.square(floating), dtype=np.float64))) if floating.size else 0.0
        original_peak = float(np.max(np.abs(floating))) if floating.size else 0.0
        return samples, {
            "mode": mode,
            "requested_mode": requested_mode,
            "applied": False,
            "input_rms": round(original_rms, 6),
            "input_peak": round(original_peak, 6),
            "gain": 1.0,
            "transient_suppression": False,
            "vad_guided": False,
            "vad_trimming": False,
        }
    return enhance_speech_pcm(samples, mode)


def write_transcription_window(
    source: Path,
    destination: Path,
    start_seconds: float,
    end_seconds: float,
    enhancement: str = "automatic",
) -> dict[str, float | str | bool]:
    source = source.resolve()
    destination = destination.resolve()
    if source == destination:
        raise ValueError("A transcription working copy may never overwrite the original audio.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    samples = _window_pcm(source, start_seconds, end_seconds)
    processed, metadata = _enhance_speech_pcm(samples, enhancement)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        with wave.open(str(temporary), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            output.writeframes(processed.tobytes())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        **metadata,
        "start_seconds": round(start_seconds, 3),
        "end_seconds": round(end_seconds, 3),
        "sample_rate": SAMPLE_RATE,
        "derived": True,
    }


def write_enhanced_copy(
    source: Path,
    destination: Path,
    enhancement: str = "balanced",
    progress_callback: Callable[[int, str], None] | None = None,
    cancellation_check: Callable[[], bool] | None = None,
) -> dict[str, float | str | bool | int]:
    """Create a bounded-memory, full-length derived WAV without touching source."""
    source = source.resolve()
    destination = destination.resolve()
    mode = normalize_cleanup_mode(enhancement)
    if source == destination:
        raise ValueError("An enhanced copy may never overwrite the protected original audio.")
    if not source.is_file():
        raise ValueError("The protected source recording is unavailable.")
    if destination.exists():
        raise ValueError("The enhanced destination already exists and was not overwritten.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    source_md5_before = file_md5(source)
    duration = audio_duration_seconds(source)
    # Thirty-second sections keep multi-hour processing bounded while giving the
    # conservative noise-floor and gain estimator enough classroom context.
    section_seconds = 30.0
    section_count = max(1, math.ceil(duration / section_seconds))
    temporary = destination.with_suffix(destination.suffix + ".partial")
    processed_samples = 0
    maximum_applied_gain = 1.0
    transient_events_attenuated = 0
    processing_metadata: dict[str, float | str | bool] = {}
    try:
        with wave.open(str(temporary), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            for section_index in range(section_count):
                if cancellation_check and cancellation_check():
                    raise RuntimeError("Enhanced-copy generation cancelled. The protected original is unchanged.")
                start = section_index * section_seconds
                end = min(duration, start + section_seconds)
                if progress_callback:
                    progress_callback(
                        5 + round((section_index / section_count) * 88),
                        f"Creating {mode} enhanced copy · {round(start)}–{round(end)} of {round(duration)} seconds",
                    )
                samples = _window_pcm(source, start, end)
                processed, section_metadata = _enhance_speech_pcm(samples, mode)
                output.writeframes(processed.tobytes())
                processed_samples += int(processed.size)
                maximum_applied_gain = max(maximum_applied_gain, float(section_metadata.get("maximum_applied_gain") or 1.0))
                transient_events_attenuated += int(section_metadata.get("transient_events_attenuated") or 0)
                if not processing_metadata:
                    processing_metadata = {
                        key: section_metadata[key]
                        for key in (
                            "technology",
                            "speech_activity_method",
                            "vad_guided",
                            "vad_trimming",
                            "speech_preservation_floor",
                            "non_speech_spectral_floor",
                            "stationary_noise_attenuation_db",
                            "high_pass_hz",
                            "spectral_batch_frames",
                        )
                        if key in section_metadata
                    }

        source_md5_after = file_md5(source)
        if source_md5_after != source_md5_before:
            raise RuntimeError("Protected original integrity changed during enhancement. The derived result was rejected.")
        if cancellation_check and cancellation_check():
            raise RuntimeError("Enhanced-copy generation cancelled. The protected original is unchanged.")
        os.replace(temporary, destination)
        if progress_callback:
            progress_callback(98, "Enhanced copy created · verifying original and derived hashes")
        return {
            "derived": True,
            "mode": mode,
            "source_md5": source_md5_before,
            "enhanced_md5": file_md5(destination),
            "enhanced_size": destination.stat().st_size,
            "duration_seconds": round(processed_samples / SAMPLE_RATE, 3),
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "sections": section_count,
            "maximum_applied_gain": round(maximum_applied_gain, 3),
            **processing_metadata,
            "transient_suppression": transient_events_attenuated > 0,
            "transient_events_attenuated": transient_events_attenuated,
            "timestamp_reference": "original",
            "warning": "Strong cleanup can affect difficult or overlapping speech; compare against the protected original." if mode == "strong" else "",
        }
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def transcription_window(
    source: Path,
    start_seconds: float,
    end_seconds: float,
    enhancement: str = "automatic",
    directory: Path | None = None,
) -> Iterator[tuple[Path, dict[str, float | str | bool]]]:
    if directory is None:
        runtime_root = Path(os.getenv("LECTUREAI_RUNTIME_DIR") or Path.cwd() / ".lectureai-runtime")
        runtime_root.mkdir(parents=True, exist_ok=True)
        directory = runtime_root / f"lectureai-derived-{uuid.uuid4().hex}"
        directory.mkdir(parents=True, exist_ok=False)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"section-{int(start_seconds * 1000):012d}-{int(end_seconds * 1000):012d}.wav"
    metadata: dict[str, float | str | bool]
    try:
        try:
            metadata = write_transcription_window(source, target, start_seconds, end_seconds, enhancement)
        except Exception:
            if normalize_cleanup_mode(enhancement) == "off":
                raise
            metadata = write_transcription_window(source, target, start_seconds, end_seconds, "off")
            metadata["fallback_from"] = enhancement
        yield target, metadata
    finally:
        target.unlink(missing_ok=True)
        try:
            if not any(directory.iterdir()) and directory.name.startswith("lectureai-derived-"):
                directory.rmdir()
        except OSError:
            pass
