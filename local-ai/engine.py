from __future__ import annotations

import json
import itertools
import os
import re
import time
import uuid
import gc
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterable

from faster_whisper import WhisperModel

from audio_pipeline import audio_duration_seconds, file_md5, normalize_cleanup_mode, transcription_window
from hardware import detect_hardware, recommendation

MODEL_INFO = {
    "small": {"label": "Fast", "download": "~500 MB", "storage": "~1 GB", "memory": "4+ GB RAM"},
    "medium": {"label": "Balanced", "download": "~1.5 GB", "storage": "~3 GB", "memory": "8+ GB RAM or 6+ GB VRAM"},
    "large-v3": {"label": "Most Accurate", "download": "~3.1 GB", "storage": "~6 GB", "memory": "16+ GB RAM or 10+ GB VRAM preferred"},
}

_models: dict[tuple[str, str, str], WhisperModel] = {}
WINDOW_SECONDS = 300
WINDOW_OVERLAP_SECONDS = 5
TRANSCRIPTION_VERSION = "lectureai-windows-v2"


class TranscriptionCancelled(RuntimeError):
    """Cooperative cancellation that preserves the last completed checkpoint."""


def plan_audio_windows(duration: float) -> list[tuple[float, float]]:
    """Plan bounded sequential windows without decoding the source recording."""
    if not isinstance(duration, (int, float)) or not 0 < float(duration) < float("inf"):
        raise ValueError("Audio duration must be a positive finite number.")
    windows: list[tuple[float, float]] = []
    step = WINDOW_SECONDS - WINDOW_OVERLAP_SECONDS
    start = 0.0
    while start < float(duration):
        windows.append((round(start, 6), min(float(duration), round(start + WINDOW_SECONDS, 6))))
        start += step
    return windows


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
        # One heavy model at a time prevents a prior profile from retaining GPU/RAM
        # while the next lecture loads another model.
        _models.clear()
        gc.collect()
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
        "terms in English inside Arabic sentences. Student questions may also be present. Preserve "
        "numbers, formulas, abbreviations, product names, code symbols, and course terminology exactly "
        "when audible. Do not infer speaker identity from the audio transcript alone. Do not translate "
        "the original transcript."
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


def _segment_payload(
    segment: Any,
    index: int,
    language: str,
    *,
    offset: float = 0.0,
    translated: bool = False,
) -> dict[str, Any] | None:
    spoken = sanitize_transcript_text(segment.text)
    if not spoken:
        return None
    avg_logprob = float(getattr(segment, "avg_logprob", -1.0))
    no_speech_probability = float(getattr(segment, "no_speech_prob", 0.0))
    compression_ratio = float(getattr(segment, "compression_ratio", 0.0) or 0.0)
    word_probabilities = [float(word.probability) for word in (segment.words or []) if word.probability is not None]
    mean_word_probability = sum(word_probabilities) / len(word_probabilities) if word_probabilities else None
    uncertain = avg_logprob < -0.87 or no_speech_probability > 0.65 or compression_ratio > 2.4 or (mean_word_probability is not None and mean_word_probability < 0.45)
    if uncertain and not spoken.startswith("[uncertain]"):
        spoken = f"[uncertain] {spoken}"
    return {
        "id": f"{'english' if translated else 'source'}-segment-{index + 1}",
        "start": round(offset + float(segment.start), 3),
        "end": round(offset + float(segment.end), 3),
        "text": spoken,
        "language": "en" if translated else language,
        "language_scope": "translation" if translated else "window-detected",
        "translated_to_english": translated,
        "uncertain": uncertain,
        "avg_logprob": round(avg_logprob, 4),
        "no_speech_probability": round(no_speech_probability, 4),
        "compression_ratio": round(compression_ratio, 4),
        "mean_word_probability": round(mean_word_probability, 4) if mean_word_probability is not None else None,
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
    model_name: str,
    quality_retry: bool = False,
):
    # Beam 8 / best-of 8 made long CPU lectures needlessly expensive. These
    # bounded settings retain useful search while keeping 45–120 minute jobs sane.
    beam_size = {"small": 3, "medium": 4, "large-v3": 5}.get(model_name, 4) + (1 if quality_retry else 0)
    return model.transcribe(
        str(audio_path),
        task=task,
        language=language,
        beam_size=beam_size,
        best_of=1,
        patience=1.0,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=prompt,
        hotwords=hotwords,
        vad_filter=True,
        vad_parameters={
            "threshold": 0.22 if quality_retry else 0.35,
            "min_speech_duration_ms": 100 if quality_retry else 150,
            "min_silence_duration_ms": 900 if quality_retry else 700,
            "speech_pad_ms": 650 if quality_retry else 500,
        },
        word_timestamps=True,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.72 if quality_retry else 0.6,
        hallucination_silence_threshold=2.0,
    )


def quality_retry_plan(cleanup_mode: str) -> list[tuple[str, bool]]:
    """Bounded per-section fallbacks; never restart completed sections."""
    mode = normalize_cleanup_mode(cleanup_mode)
    if mode == "strong":
        return [("strong", False), ("balanced", True), ("off", True)]
    if mode == "balanced":
        return [("balanced", False), ("off", True)]
    return [("off", False), ("off", True)]


def analyze_section_quality(segments: list[dict[str, Any]], section_duration: float, section_start: float = 0.0) -> dict[str, Any]:
    """Use supported ASR signals and deterministic text/timestamp checks."""
    if not segments:
        return {"suspicious": True, "score": -4.0, "reasons": ["no-text"], "uncertain_ratio": 1.0}
    reasons: list[str] = []
    logprobs = [float(item.get("avg_logprob", -1.0)) for item in segments]
    no_speech = [float(item.get("no_speech_probability", 0.0)) for item in segments]
    compressions = [float(item.get("compression_ratio", 0.0)) for item in segments]
    word_probabilities = [float(item["mean_word_probability"]) for item in segments if item.get("mean_word_probability") is not None]
    uncertain_ratio = sum(bool(item.get("uncertain")) for item in segments) / len(segments)
    average_logprob = sum(logprobs) / len(logprobs)
    average_no_speech = sum(no_speech) / len(no_speech)
    average_word_probability = sum(word_probabilities) / len(word_probabilities) if word_probabilities else 0.5
    if average_logprob < -0.92:
        reasons.append("low-log-probability")
    if average_no_speech > 0.60:
        reasons.append("text-during-probable-silence")
    if max(compressions, default=0.0) > 2.4:
        reasons.append("high-compression-ratio")
    if uncertain_ratio >= 0.5:
        reasons.append("mostly-low-confidence")
    normalized = [_normalized_overlap_text(str(item.get("text") or "")) for item in segments]
    repeated = max((normalized.count(value) for value in set(normalized) if value), default=0)
    combined_words = re.findall(r"[\w\u0600-\u06ff]+", " ".join(str(item.get("text") or "").casefold() for item in segments))
    repeated_word_run = max((len(list(group)) for _, group in itertools.groupby(combined_words)), default=0)
    if repeated >= 3 or repeated_word_run >= 7:
        reasons.append("repeated-text-loop")
    previous_end = -1.0
    for item in segments:
        start = float(item.get("start", 0.0))
        end = float(item.get("end", start))
        if start < previous_end - 0.01 or end <= start or start < section_start or end > section_start + section_duration + WINDOW_OVERLAP_SECONDS + 0.5:
            reasons.append("timestamp-anomaly")
            break
        previous_end = end
    score = (
        average_logprob
        + average_word_probability
        - average_no_speech
        - uncertain_ratio
        - 0.5 * len(set(reasons))
    )
    return {
        "suspicious": bool(reasons),
        "score": round(score, 5),
        "reasons": list(dict.fromkeys(reasons)),
        "uncertain_ratio": round(uncertain_ratio, 4),
    }


def _normalized_overlap_text(value: str) -> str:
    return re.sub(r"[^\w\u0600-\u06ff]+", "", value.casefold())


def _append_reconciled(target: list[dict[str, Any]], candidate: dict[str, Any], accept_after: float) -> None:
    """Deterministically reconcile neighboring window overlap."""
    if candidate["end"] <= accept_after:
        return
    candidate = dict(candidate)
    candidate["start"] = max(float(candidate["start"]), accept_after)
    if target:
        previous = target[-1]
        same_text = _normalized_overlap_text(previous["text"]) == _normalized_overlap_text(candidate["text"])
        nearby = float(candidate["start"]) <= float(previous["end"]) + WINDOW_OVERLAP_SECONDS
        if same_text and nearby:
            previous["end"] = round(max(float(previous["end"]), float(candidate["end"])), 3)
            return
        # Transcript timestamps must remain monotonic even when Whisper returns
        # slightly overlapping but genuinely different phrases at a boundary.
        candidate["start"] = max(float(candidate["start"]), float(previous["end"]))
    if float(candidate["end"]) <= float(candidate["start"]):
        return
    candidate["id"] = f"source-segment-{len(target) + 1}"
    target.append(candidate)


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    models_dir: Path,
    glossary: list[str] | None = None,
    progress: Callable[[int, str], None] | None = None,
    *,
    checkpoint: dict[str, Any] | None = None,
    checkpoint_callback: Callable[[dict[str, Any]], None] | None = None,
    enhancement: str = "automatic",
    working_directory: Path | None = None,
    cancellation_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    if model_name not in MODEL_INFO:
        raise ValueError(f"Unsupported model: {model_name}")

    cleanup_mode = normalize_cleanup_mode(enhancement)
    started_at = time.monotonic()
    audio_path = audio_path.resolve()
    report = progress or (lambda _value, _message: None)
    report(2, "Reading recording · verifying source integrity and container duration")
    source_md5_before = file_md5(audio_path)
    duration = audio_duration_seconds(audio_path)
    terms = glossary or []
    windows = plan_audio_windows(duration)
    report(6, f"Splitting / planning sections · {len(windows)} bounded windows · 300 seconds with 5-second overlap")
    saved = checkpoint if isinstance(checkpoint, dict) else {}
    if saved and saved.get("source_md5") != source_md5_before:
        raise ValueError("The saved checkpoint belongs to a different audio file; the original and checkpoint were left unchanged.")
    saved_cleanup = normalize_cleanup_mode(str(saved.get("enhancement") or cleanup_mode))
    if saved and saved_cleanup != cleanup_mode:
        raise ValueError("This checkpoint uses a different cleanup mode. Keep the existing mode to resume, or create a new transcription job; the original is unchanged.")
    if cancellation_check and cancellation_check():
        raise TranscriptionCancelled("Transcription cancelled before model loading.")
    report(12, f"Loading {model_name} multilingual model")
    model, device, compute_type = load_model(model_name, models_dir)
    report(18, f"Model ready on {device} ({compute_type}) · starting resumable source transcription")
    if cancellation_check and cancellation_check():
        raise TranscriptionCancelled("Transcription cancelled after model loading.")

    source_segments = [dict(segment) for segment in saved.get("segments", []) if isinstance(segment, dict)]
    completed_chunk = int(saved.get("completed_chunk", -1))
    previous_processing_seconds = max(0.0, float(saved.get("processing_seconds_accumulated") or 0))
    languages = [str(value) for value in saved.get("detected_languages", []) if value]
    quality_records = [dict(value) for value in saved.get("quality_records", []) if isinstance(value, dict)]
    if working_directory is None:
        runtime_root = Path(os.getenv("LECTUREAI_RUNTIME_DIR") or Path.cwd() / ".lectureai-runtime")
        runtime_root.mkdir(parents=True, exist_ok=True)
        work_root = runtime_root / f"lectureai-transcription-{uuid.uuid4().hex}"
        work_root.mkdir(parents=True, exist_ok=False)
    else:
        work_root = working_directory
    work_root.mkdir(parents=True, exist_ok=True)
    enhancement_records: list[dict[str, Any]] = []
    try:
        for chunk_index, (chunk_start, chunk_end) in enumerate(windows):
            if chunk_index <= completed_chunk:
                continue
            if cancellation_check and cancellation_check():
                raise TranscriptionCancelled("Transcription cancelled before the next section. Completed sections remain checkpointed.")
            attempts: list[dict[str, Any]] = []
            best_attempt: dict[str, Any] | None = None
            retry_plan = quality_retry_plan(cleanup_mode)
            for attempt_index, (attempt_cleanup, quality_retry) in enumerate(retry_plan):
                if cancellation_check and cancellation_check():
                    raise TranscriptionCancelled("Transcription cancelled before a section quality retry. Completed sections remain checkpointed.")
                action = "Retrying suspicious section" if attempt_index else "Preparing audio / cleaning audio"
                report(
                    max(20, min(88, round(20 + 68 * (chunk_start / max(duration, 1))))),
                    f"{action} ({attempt_cleanup}) · section {chunk_index + 1} of {len(windows)} · {round(chunk_start)}–{round(chunk_end)} seconds",
                )
                with transcription_window(audio_path, chunk_start, chunk_end, attempt_cleanup, work_root / "derived") as (derived_path, enhancement_metadata):
                    enhancement_records.append({**dict(enhancement_metadata), "section": chunk_index, "quality_retry": quality_retry})
                    if cancellation_check and cancellation_check():
                        raise TranscriptionCancelled("Transcription cancelled after derived audio preparation. Completed sections remain checkpointed.")
                    report(
                        max(20, min(89, round(20 + 68 * (chunk_start / max(duration, 1))))),
                        f"Transcribing · section {chunk_index + 1} of {len(windows)} · attempt {attempt_index + 1} of {len(retry_plan)} · model {model_name} · {device} ({compute_type})",
                    )
                    source_generator, source_info = _transcribe_pass(
                        model,
                        derived_path,
                        task="transcribe",
                        language=None,
                        prompt=context_prompt(terms),
                        hotwords=", ".join(terms[:250]) or None,
                        model_name=model_name,
                        quality_retry=quality_retry,
                    )
                    attempt_language = str(source_info.language or "unknown")
                    attempt_segments: list[dict[str, Any]] = []
                    for segment in source_generator:
                        if cancellation_check and cancellation_check():
                            raise TranscriptionCancelled("Transcription cancelled during the current section. The preceding completed sections remain checkpointed.")
                        payload = _segment_payload(segment, len(source_segments) + len(attempt_segments), attempt_language, offset=chunk_start, translated=False)
                        if payload:
                            attempt_segments.append(payload)
                        audio_position = min(duration, chunk_start + float(segment.end))
                        report(
                            max(20, min(90, round(20 + 70 * (audio_position / max(duration, 1))))),
                            f"Transcribing · section {chunk_index + 1} of {len(windows)} · {round(audio_position)} of {round(duration)} seconds",
                        )
                quality = analyze_section_quality(attempt_segments, chunk_end - chunk_start, chunk_start)
                attempt = {
                    "cleanup_mode": attempt_cleanup,
                    "quality_retry": quality_retry,
                    "language": attempt_language,
                    "segments": attempt_segments,
                    "quality": quality,
                }
                attempts.append(attempt)
                if best_attempt is None or float(quality["score"]) > float(best_attempt["quality"]["score"]):
                    best_attempt = attempt
                if not quality["suspicious"]:
                    break

            selected = best_attempt or {"segments": [], "language": "unknown", "cleanup_mode": cleanup_mode, "quality": {"suspicious": True, "reasons": ["no-result"], "score": -9}}
            selected_segments = [dict(value) for value in selected["segments"]]
            if selected["quality"]["suspicious"]:
                for payload in selected_segments:
                    payload["uncertain"] = True
                    if not str(payload["text"]).startswith("[uncertain]"):
                        payload["text"] = f"[uncertain] {payload['text']}"
            detected_language = str(selected["language"] or "unknown")
            languages.append(detected_language)
            accept_after = -1.0 if chunk_index == 0 else chunk_start + WINDOW_OVERLAP_SECONDS * 0.5
            for payload in selected_segments:
                _append_reconciled(source_segments, payload, accept_after)
            quality_records.append({
                "section": chunk_index,
                "start": round(chunk_start, 3),
                "end": round(chunk_end, 3),
                "attempts": [{"cleanup_mode": value["cleanup_mode"], "quality_retry": value["quality_retry"], **value["quality"]} for value in attempts],
                "selected_cleanup_mode": selected["cleanup_mode"],
                "selected_suspicious": bool(selected["quality"]["suspicious"]),
            })

            completed_chunk = chunk_index
            checkpoint_payload = {
                "schema_version": 1,
                "transcription_version": TRANSCRIPTION_VERSION,
                "source_md5": source_md5_before,
                "engine": "faster-whisper",
                "model": model_name,
                "model_settings": {"beam_size": {"small": 3, "medium": 4, "large-v3": 5}.get(model_name, 4), "best_of": 1},
                "completed_chunk": completed_chunk,
                "completed_audio_seconds": round(chunk_end, 3),
                "total_audio_seconds": round(duration, 3),
                "segments": source_segments,
                "detected_languages": languages,
                "quality_records": quality_records,
                "enhancement": cleanup_mode,
                "cleanup_mode": cleanup_mode,
                "device": device,
                "compute_type": compute_type,
                "total_chunks": len(windows),
                "processing_seconds_accumulated": round(previous_processing_seconds + max(0.0, time.monotonic() - started_at), 3),
            }
            if checkpoint_callback:
                checkpoint_callback(checkpoint_payload)
    finally:
        try:
            derived_directory = work_root / "derived"
            if derived_directory.exists() and not any(derived_directory.iterdir()):
                derived_directory.rmdir()
            if working_directory is None and work_root.exists() and not any(work_root.iterdir()):
                work_root.rmdir()
        except OSError:
            pass

    source_md5_after = file_md5(audio_path)
    if source_md5_after != source_md5_before:
        raise RuntimeError("Original audio integrity changed during transcription; the result was rejected.")

    unique_languages = list(dict.fromkeys(languages))
    detected_language = unique_languages[0] if len(unique_languages) == 1 else "mixed" if unique_languages else "unknown"
    report(92, "Combining transcript · reconciling section overlap and validating timestamps")

    if not source_segments:
        elapsed = previous_processing_seconds + max(0.001, time.monotonic() - started_at)
        report(92, "No intelligible speech was detected")
        return {
            "engine": "faster-whisper",
            "model": model_name,
            "device": device,
            "compute_type": compute_type,
            "detected_language": detected_language,
            "source_language": detected_language,
            "language_probability": None,
            "language_scope": "window-detected",
            "duration": round(duration, 3),
            "segments": [],
            "source_segments": [],
            "english_segments": [],
            "english_translation": "unavailable-no-speech",
            "transcription_version": TRANSCRIPTION_VERSION,
            "source_audio_md5": source_md5_before,
            "chunk_seconds": WINDOW_SECONDS,
            "chunk_overlap_seconds": WINDOW_OVERLAP_SECONDS,
            "enhancement": cleanup_mode,
            "cleanup_mode": cleanup_mode,
            "enhancement_records": enhancement_records,
            "quality_records": quality_records,
            "total_chunks": len(windows),
            "processing_seconds": round(elapsed, 3),
            "real_time_factor": round(elapsed / max(duration, 0.001), 4),
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
        report(94, "Source transcript ready · the source is English, so no translation pass is needed")
    else:
        english_segments: list[dict[str, Any]] = []
        english_method = "deferred-source-ready"

    # Source speech is authoritative and becomes usable before any optional
    # convenience translation. A second full Whisper pass is deliberately avoided.
    current_segments = source_segments
    elapsed = previous_processing_seconds + max(0.001, time.monotonic() - started_at)
    report(96, "SOURCE TRANSCRIPT READY · optional translations can be generated separately")

    return {
        "engine": "faster-whisper",
        "model": model_name,
        "device": device,
        "compute_type": compute_type,
        "detected_language": detected_language,
        "source_language": detected_language,
        "language_probability": None,
        "language_scope": "window-detected",
        "detected_languages": unique_languages,
        "duration": round(duration, 3),
        "segments": current_segments,
        "source_segments": source_segments,
        "english_segments": english_segments,
        "english_translation": english_method,
        "translation_deferred": detected_language != "en",
        "transcription_version": TRANSCRIPTION_VERSION,
        "source_audio_md5": source_md5_before,
        "chunk_seconds": WINDOW_SECONDS,
        "chunk_overlap_seconds": WINDOW_OVERLAP_SECONDS,
        "enhancement": cleanup_mode,
        "cleanup_mode": cleanup_mode,
        "enhancement_records": enhancement_records,
        "quality_records": quality_records,
        "total_chunks": len(windows),
        "processing_seconds": round(elapsed, 3),
        "real_time_factor": round(elapsed / max(duration, 0.001), 4),
        "accuracy_note": (
            "Machine transcription/translation is not guaranteed perfect. Low-confidence segments are marked [uncertain] and should be checked against the original audio."
        ),
    }


def read_context_files(paths: list[Path]) -> list[str]:
    terms: list[str] = []
    common = {
        "about", "after", "again", "also", "because", "before", "between", "course", "during", "example", "from", "have", "into", "lecture", "other", "should", "that", "their", "there", "these", "they", "this", "through", "using", "very", "when", "where", "which", "with", "would",
        "الذي", "التي", "هذا", "هذه", "هناك", "على", "إلى", "الى", "من", "في", "كان", "تكون", "يعني", "عشان", "لكن", "ولا", "وهو", "وهي",
    }
    for path in paths:
        if path.suffix.lower() == ".pdf":
            from pypdf import PdfReader
            text = "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages[:100])
        else:
            text = path.read_text(encoding="utf-8", errors="ignore")
        candidates = re.findall(r"[A-Za-z][A-Za-z0-9+.#_-]{2,}|[\u0600-\u06FF]{3,}", text)
        for term in candidates:
            folded = term.casefold()
            unusual = (
                folded not in common
                and (
                    any(character.isdigit() or character in "+.#_-" for character in term)
                    or term.isupper()
                    or (any(character.isupper() for character in term[1:]) and any(character.islower() for character in term))
                    or len(term) >= 6
                    or bool(re.search(r"[\u0600-\u06FF]", term))
                )
            )
            if unusual:
                terms.append(term)
    seen: set[str] = set()
    return [term for term in terms if not (term.casefold() in seen or seen.add(term.casefold()))][:250]


def hardware_payload() -> dict[str, Any]:
    hardware = detect_hardware()
    return {"hardware": asdict(hardware), "recommendation": recommendation(hardware), "models": MODEL_INFO}
