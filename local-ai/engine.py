from __future__ import annotations

import json
import os
import re
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterable

from faster_whisper import WhisperModel

from audio_enhancement import prepare_audio_copy
from hardware import detect_hardware, recommendation

MODEL_INFO = {
    "small": {"label": "Fast", "download": "~500 MB", "storage": "~1 GB", "memory": "4+ GB RAM"},
    "medium": {"label": "Balanced", "download": "~1.5 GB", "storage": "~3 GB", "memory": "8+ GB RAM or 6+ GB VRAM"},
    "large-v3": {"label": "Large", "download": "~3.1 GB", "storage": "~6 GB", "memory": "16+ GB RAM or 10+ GB VRAM preferred"},
}

_models: dict[tuple[str, str, str], WhisperModel] = {}


def sanitize_transcript_text(value: Any) -> str:
    """Remove Whisper control/timestamp tokens before any text leaves the helper."""
    text = str(value or "")
    text = re.sub(r"<\|(?:startoftranscript|endoftext|transcribe|translate|notimestamps|[a-z]{2}|\d+(?:\.\d+)?)\|>", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


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
        "University lecture. Preserve speech exactly as spoken. The lecturer may switch naturally "
        "between English, Egyptian Arabic (Masri), and Modern Standard Arabic. Keep English technical "
        "terms in English inside Arabic sentences and Arabic wording in Arabic when that is what was "
        "spoken. Student questions may also be present. Preserve numbers, formulas, abbreviations, "
        "product names, code symbols, names, and course terminology exactly when audible. Do not infer "
        "speaker identity from the audio transcript alone. Do not translate, summarize, paraphrase, or "
        "invent missing speech in the original transcript."
    )
    return f"{base} Course terminology: {', '.join(terms)}" if terms else base


def english_translation_prompt(glossary: Iterable[str]) -> str:
    terms = [re.sub(r"[\r\n\t]+", " ", str(term)).strip()[:120] for term in glossary]
    terms = [term for term in terms if term][:250]
    base = (
        "Translate the lecture faithfully into natural English. Keep already-English technical terms, "
        "names, acronyms, code, formulas, units, and numbers unchanged when possible. Do not summarize, "
        "simplify, add explanations, or invent missing speech. The source may mix English with Egyptian "
        "Arabic or Modern Standard Arabic."
    )
    return f"{base} Course terminology: {', '.join(terms)}" if terms else base


def _segment_payload(segment: Any, index: int, language: str, *, translated: bool = False) -> dict[str, Any] | None:
    spoken = sanitize_transcript_text(segment.text)
    if not spoken:
        return None
    avg_logprob = float(segment.avg_logprob)
    uncertain = avg_logprob < -0.87
    if uncertain and not spoken.startswith("[uncertain]"):
        spoken = f"[uncertain] {spoken}"
    return {
        "id": f"{'english' if translated else 'source'}-segment-{index + 1}",
        "start": round(float(segment.start), 3),
        "end": round(float(segment.end), 3),
        "text": spoken,
        "language": "en" if translated else language,
        "language_scope": "translation" if translated else "lecture",
        "translated_to_english": translated,
        "uncertain": uncertain,
        "avg_logprob": round(avg_logprob, 4),
        "no_speech_probability": round(float(segment.no_speech_prob), 4),
        "speaker": "Speaker",
        "words": [
            {
                "start": word.start,
                "end": word.end,
                "word": word.word,
                "probability": round(word.probability, 3),
            }
            for word in (segment.words or [])
        ],
    }


def _transcribe_pass(
    model: WhisperModel,
    audio_path: Path,
    *,
    task: str,
    language: str | None,
    prompt: str,
    hotwords: str | None,
):
    # Beam 5 is the faster-whisper/Whisper practical default. The previous beam 8
    # materially increased long-lecture decode work without evidence from this repo's
    # human-reference benchmarks that it improved LectureAI accuracy. Keep all other
    # anti-hallucination/VAD/timestamp safeguards intact and benchmark any future
    # accuracy claim instead of assuming a larger beam is better.
    return model.transcribe(
        str(audio_path),
        task=task,
        language=language,
        beam_size=5,
        best_of=5,
        patience=1.1,
        temperature=0.0,
        condition_on_previous_text=True,
        initial_prompt=prompt,
        hotwords=hotwords,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 400},
        word_timestamps=True,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        hallucination_silence_threshold=2.0,
    )


def _timing_payload(started_at: float, duration: float, source_seconds: float, translation_seconds: float) -> dict[str, Any]:
    processing_seconds = max(0.0, time.perf_counter() - started_at)
    return {
        "processing_seconds": round(processing_seconds, 3),
        "source_pass_seconds": round(max(0.0, source_seconds), 3),
        "translation_pass_seconds": round(max(0.0, translation_seconds), 3),
        "real_time_factor": round(processing_seconds / duration, 4) if duration > 0 else None,
        "timing_note": "Wall-clock timing includes local audio preparation/model readiness and any requested English translation pass.",
    }


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    models_dir: Path,
    glossary: list[str] | None = None,
    progress: Callable[[int, str], None] | None = None,
    *,
    enhancement: str = "balanced",
    translate_to_english: bool = True,
) -> dict[str, Any]:
    if model_name not in MODEL_INFO:
        raise ValueError(f"Unsupported model: {model_name}")
    if enhancement not in {"off", "balanced"}:
        raise ValueError("Audio enhancement must be 'off' or 'balanced'.")

    terms = glossary or []
    report = progress or (lambda _value, _message: None)
    started_at = time.perf_counter()
    source_pass_seconds = 0.0
    translation_pass_seconds = 0.0

    # The temporary working directory is separate from the protected original. The
    # preparation helper verifies the source hash before/after and falls back to the
    # original when optional FFmpeg preprocessing is unavailable.
    with tempfile.TemporaryDirectory(prefix="lectureai-asr-") as work_dir:
        report(6, "Preparing a non-destructive speech copy for transcription")
        prepared = prepare_audio_copy(audio_path, Path(work_dir), enhancement)
        transcription_path = Path(prepared.transcription_path)
        if prepared.applied:
            report(10, "Speech copy ready · reducing steady AC/fan/room noise without changing the original")
        elif enhancement == "balanced":
            report(10, f"Speech enhancement unavailable · using the untouched original ({prepared.reason})")
        else:
            report(10, "Audio enhancement disabled · using the untouched original")

        report(12, f"Loading {model_name} multilingual model")
        model, device, compute_type = load_model(model_name, models_dir)
        report(22, f"Model ready on {device} · detecting language and transcribing source speech")

        source_started = time.perf_counter()
        source_generator, source_info = _transcribe_pass(
            model,
            transcription_path,
            task="transcribe",
            language=None,
            prompt=context_prompt(terms),
            hotwords=", ".join(terms[:250]) or None,
        )

        detected_language = str(source_info.language or "unknown")
        duration = max(float(source_info.duration or 0), 0.0)
        source_segments: list[dict[str, Any]] = []
        for index, segment in enumerate(source_generator):
            payload = _segment_payload(segment, index, detected_language, translated=False)
            if payload:
                source_segments.append(payload)
            report(
                min(62, 23 + round(39 * (segment.end / max(duration, 1)))),
                f"Source transcript · {round(segment.end)} of {round(duration)} seconds",
            )
        source_pass_seconds = time.perf_counter() - source_started

        common = {
            "engine": "faster-whisper",
            "model": model_name,
            "device": device,
            "compute_type": compute_type,
            "detected_language": detected_language,
            "source_language": detected_language,
            "language_probability": round(float(source_info.language_probability), 3),
            "duration": round(duration, 3),
            "audio_preparation": prepared.payload(),
        }

        if not source_segments:
            report(92, "No intelligible speech was detected")
            return {
                **common,
                **_timing_payload(started_at, duration, source_pass_seconds, translation_pass_seconds),
                "segments": [],
                "source_segments": [],
                "english_segments": [],
                "english_translation": "unavailable-no-speech",
            }

        if detected_language == "en":
            english_segments = [
                {
                    **segment,
                    "id": segment["id"].replace("source-", "english-", 1),
                    "language": "en",
                    "language_scope": "translation",
                    "translated_to_english": False,
                }
                for segment in source_segments
            ]
            english_method = "source-is-english"
            report(88, "English source transcript ready")
        elif not translate_to_english:
            english_segments = []
            english_method = "disabled-source-only"
            report(90, "Source transcript ready · separate English translation skipped")
        else:
            report(64, "Creating a separate faithful English translation")
            translation_language = detected_language if float(source_info.language_probability) >= 0.55 and detected_language != "unknown" else None
            translation_started = time.perf_counter()
            english_generator, _english_info = _transcribe_pass(
                model,
                transcription_path,
                task="translate",
                language=translation_language,
                prompt=english_translation_prompt(terms),
                hotwords=", ".join(terms[:250]) or None,
            )
            english_segments = []
            for index, segment in enumerate(english_generator):
                payload = _segment_payload(segment, index, detected_language, translated=True)
                if payload:
                    english_segments.append(payload)
                report(
                    min(90, 65 + round(25 * (segment.end / max(duration, 1)))),
                    f"English transcript · {round(segment.end)} of {round(duration)} seconds",
                )
            translation_pass_seconds = time.perf_counter() - translation_started
            english_method = "whisper-translate"

        # Expo currently treats `segments` as the editable/current transcript. Keep
        # that behavior when an English view exists. Source-only CLI runs intentionally
        # return the original multilingual segments as current so no second full ASR
        # pass is required.
        current_segments = english_segments or source_segments
        report(94, "Transcript ready · finalizing local metadata")

        return {
            **common,
            **_timing_payload(started_at, duration, source_pass_seconds, translation_pass_seconds),
            "segments": current_segments,
            "source_segments": source_segments,
            "english_segments": english_segments,
            "english_translation": english_method,
            "accuracy_note": (
                "Machine transcription/translation is not guaranteed perfect. Low-confidence segments are marked [uncertain] and should be checked against the original audio."
            ),
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
