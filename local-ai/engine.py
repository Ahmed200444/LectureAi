from __future__ import annotations

import json
import os
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterable

from faster_whisper import WhisperModel

from hardware import detect_hardware, recommendation

MODEL_INFO = {
    "small": {"label": "Fast", "download": "~500 MB", "storage": "~1 GB", "memory": "4+ GB RAM"},
    "medium": {"label": "Balanced", "download": "~1.5 GB", "storage": "~3 GB", "memory": "8+ GB RAM or 6+ GB VRAM"},
    "large-v3": {"label": "Large", "download": "~3.1 GB", "storage": "~6 GB", "memory": "16+ GB RAM or 10+ GB VRAM preferred"},
}

_models: dict[tuple[str, str, str], WhisperModel] = {}


def select_runtime(model_name: str) -> tuple[str, str]:
    hardware = detect_hardware()
    if hardware.nvidia_gpu and (hardware.gpu_vram_gb or 0) >= 6:
        compute = "float16" if (hardware.gpu_vram_gb or 0) >= 8 else "int8_float16"
        return "cuda", compute
    return "cpu", "int8"


def load_model(model_name: str, models_dir: Path) -> tuple[WhisperModel, str, str]:
    device, compute_type = select_runtime(model_name)
    key = (model_name, device, compute_type)
    if key not in _models:
        try:
            _models[key] = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=str(models_dir))
        except Exception:
            if device != "cuda":
                raise
            device, compute_type = "cpu", "int8"
            key = (model_name, device, compute_type)
            if key not in _models:
                _models[key] = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=str(models_dir))
    return _models[key], device, compute_type


def context_prompt(glossary: Iterable[str]) -> str:
    terms = [re.sub(r"[\r\n\t]+", " ", str(term)).strip()[:120] for term in glossary]
    terms = [term for term in terms if term][:250]
    base = (
        "University lecture. Preserve speech exactly as spoken. The professor may switch naturally "
        "between English, Egyptian Arabic (Masri), and Modern Standard Arabic. Keep English technical "
        "terms in English inside Arabic sentences. Do not translate the original transcript."
    )
    return f"{base} Course terminology: {', '.join(terms)}" if terms else base


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    models_dir: Path,
    glossary: list[str] | None = None,
    progress: Callable[[int, str], None] | None = None,
) -> dict[str, Any]:
    if model_name not in MODEL_INFO:
        raise ValueError(f"Unsupported model: {model_name}")
    report = progress or (lambda _value, _message: None)
    report(12, f"Loading {model_name} multilingual model")
    model, device, compute_type = load_model(model_name, models_dir)
    report(24, "Model ready · analyzing speech")
    segments, info = model.transcribe(
        str(audio_path),
        task="transcribe",
        language=None,
        beam_size=8,
        best_of=8,
        patience=1.2,
        temperature=0.0,
        condition_on_previous_text=True,
        initial_prompt=context_prompt(glossary or []),
        hotwords=", ".join((glossary or [])[:250]) or None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 400},
        word_timestamps=True,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        hallucination_silence_threshold=2.0,
    )

    output_segments: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        spoken = segment.text.strip()
        avg_logprob = float(segment.avg_logprob)
        if not spoken:
            continue
        # avg_logprob is an uncalibrated model score, not an accuracy percentage.
        # Use it only as a conservative review heuristic.
        if avg_logprob < -0.87 and not spoken.startswith("[uncertain]"):
            spoken = f"[uncertain] {spoken}"
        output_segments.append({
            "id": f"segment-{index + 1}",
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": spoken,
            "language": "unknown",
            "avg_logprob": round(avg_logprob, 4),
            "no_speech_probability": round(segment.no_speech_prob, 4),
            "speaker": "Professor",
            "words": [
                {"start": word.start, "end": word.end, "word": word.word, "probability": round(word.probability, 3)}
                for word in (segment.words or [])
            ],
        })
        report(min(88, 25 + round(63 * (segment.end / max(info.duration, 1)))), f"Transcribing locally · {round(segment.end)} of {round(info.duration)} seconds")

    report(92, "Timestamped transcript complete")

    return {
        "engine": "faster-whisper",
        "model": model_name,
        "device": device,
        "compute_type": compute_type,
        "detected_language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "segments": output_segments,
    }


def read_context_files(paths: list[Path]) -> list[str]:
    terms: list[str] = []
    for path in paths:
        if path.suffix.lower() == ".pdf":
            from pypdf import PdfReader
            text = "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages[:100])
        else:
            text = path.read_text(encoding="utf-8", errors="ignore")
        terms.extend(re.findall(r"[A-Za-z][A-Za-z0-9+.#_-]{2,}|[\u0600-\u06FF]{3,}", text))
    seen: set[str] = set()
    return [term for term in terms if not (term.casefold() in seen or seen.add(term.casefold()))][:250]


def hardware_payload() -> dict[str, Any]:
    hardware = detect_hardware()
    return {"hardware": asdict(hardware), "recommendation": recommendation(hardware), "models": MODEL_INFO}