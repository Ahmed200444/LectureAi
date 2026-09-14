from __future__ import annotations

import contextlib
import math
import os
import shutil
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np

import audio_pipeline
import engine
import hardware
from job_store import JobStore


def make_test_wav(path: Path, seconds: float = 2.0) -> None:
    sample_count = int(audio_pipeline.SAMPLE_RATE * seconds)
    timeline = np.arange(sample_count, dtype=np.float32) / audio_pipeline.SAMPLE_RATE
    # Synthetic speech-band tone plus steady low-frequency classroom hum.
    samples = 0.08 * np.sin(2 * math.pi * 440 * timeline) + 0.04 * np.sin(2 * math.pi * 45 * timeline)
    pcm = np.asarray(np.clip(samples * 32767, -32768, 32767), dtype=np.int16)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(audio_pipeline.SAMPLE_RATE)
        output.writeframes(pcm.tobytes())


def test_window_planning() -> None:
    sixty_five_minutes = engine.plan_audio_windows(65 * 60)
    two_hours = engine.plan_audio_windows(2 * 60 * 60)
    assert len(sixty_five_minutes) == 14
    assert len(two_hours) == 25
    for duration, windows in ((65 * 60, sixty_five_minutes), (2 * 60 * 60, two_hours)):
        assert windows[0] == (0.0, 300.0)
        assert windows[-1][1] == duration
        assert all(0 < end - start <= engine.WINDOW_SECONDS for start, end in windows)
        assert all(abs(right[0] - (left[1] - engine.WINDOW_OVERLAP_SECONDS)) < 0.001 for left, right in zip(windows, windows[1:]))


def test_bounded_quality_retry_logic() -> None:
    assert engine.quality_retry_plan("strong") == [("strong", False), ("balanced", True), ("off", True)]
    assert engine.quality_retry_plan("balanced") == [("balanced", False), ("off", True)]
    assert engine.quality_retry_plan("off") == [("off", False), ("off", True)]
    clean = [{
        "start": 0.0,
        "end": 3.0,
        "text": "Dijkstra shortest path",
        "avg_logprob": -0.2,
        "no_speech_probability": 0.01,
        "compression_ratio": 1.1,
        "mean_word_probability": 0.9,
        "uncertain": False,
    }]
    assert engine.analyze_section_quality(clean, 300)["suspicious"] is False
    repeated = [
        {**clean[0], "start": index * 3.0, "end": index * 3.0 + 2.0, "text": "repeat repeat repeat repeat repeat repeat repeat", "compression_ratio": 2.8}
        for index in range(3)
    ]
    suspicious = engine.analyze_section_quality(repeated, 300)
    assert suspicious["suspicious"] is True
    assert "high-compression-ratio" in suspicious["reasons"]
    assert "repeated-text-loop" in suspicious["reasons"]
    assert engine.analyze_section_quality([], 300)["reasons"] == ["no-text"]
    sixteen_gb_laptop = hardware.Hardware("synthetic", 12, 15.7, 100.0, "Synthetic 4 GB GPU", 4.0)
    assert hardware.recommendation(sixteen_gb_laptop)["model"] == "medium"


def test_cleanup_profiles() -> None:
    seconds = 4
    sample_count = audio_pipeline.SAMPLE_RATE * seconds
    timeline = np.arange(sample_count, dtype=np.float32) / audio_pipeline.SAMPLE_RATE
    speech_mask = ((timeline % 1.0) >= 0.25) & ((timeline % 1.0) < 0.75)
    floating = 0.003 * np.sin(2 * math.pi * 45 * timeline)
    floating += speech_mask * 0.010 * np.sin(2 * math.pi * 440 * timeline)
    floating[sample_count // 2] = 0.95  # Synthetic handling tap/impulse.
    samples = np.asarray(np.clip(floating * 32767, -32768, 32767), dtype=np.int16)

    off, off_metadata = audio_pipeline._enhance_speech_pcm(samples, "off")
    balanced, balanced_metadata = audio_pipeline._enhance_speech_pcm(samples, "balanced")
    strong, strong_metadata = audio_pipeline._enhance_speech_pcm(samples, "strong")
    assert np.array_equal(off, samples)
    assert off_metadata["applied"] is False
    assert balanced_metadata["mode"] == "balanced" and strong_metadata["mode"] == "strong"
    assert balanced_metadata["high_pass_hz"] == 72.0 and strong_metadata["high_pass_hz"] == 78.0
    assert strong_metadata["maximum_gain"] > balanced_metadata["maximum_gain"]
    assert strong_metadata["stationary_noise_attenuation_db"] > balanced_metadata["stationary_noise_attenuation_db"]
    assert balanced_metadata["technology"] == "speech-aware-spectral-v1"
    assert balanced_metadata["vad_guided"] is True and balanced_metadata["vad_trimming"] is False
    assert balanced_metadata["speech_preservation_floor"] > balanced_metadata["non_speech_spectral_floor"]
    assert balanced_metadata["spectral_batch_frames"] <= 256
    assert np.max(np.abs(balanced.astype(np.float32) / 32768.0)) <= 10 ** (-1.0 / 20.0) + 0.001
    assert np.max(np.abs(strong.astype(np.float32) / 32768.0)) <= 10 ** (-1.0 / 20.0) + 0.001
    assert np.sqrt(np.mean(np.square(balanced[speech_mask].astype(np.float64)))) > np.sqrt(np.mean(np.square(samples[speech_mask].astype(np.float64))))
    alias, alias_metadata = audio_pipeline._enhance_speech_pcm(samples, "automatic")
    assert np.array_equal(alias, balanced) and alias_metadata["mode"] == "balanced"


def test_speech_focused_enhancement() -> None:
    """Synthetic DSP checks never use private recordings or claim speech-recognition accuracy."""
    rng = np.random.default_rng(20260912)
    seconds = 8
    count = audio_pipeline.SAMPLE_RATE * seconds
    timeline = np.arange(count, dtype=np.float32) / audio_pipeline.SAMPLE_RATE
    envelope = np.zeros(count, dtype=np.float32)
    for center in (1.0, 1.34, 1.82, 2.25, 4.15, 4.52, 5.05, 5.62):
        envelope += np.exp(-0.5 * np.square((timeline - center) / 0.10)).astype(np.float32)
    envelope = np.clip(envelope, 0.0, 1.0)
    # Harmonic/formant-like energy and brief high-frequency consonant bursts.
    speech = envelope * (
        0.0055 * np.sin(2 * math.pi * 185 * timeline)
        + 0.0040 * np.sin(2 * math.pi * 740 * timeline)
        + 0.0025 * np.sin(2 * math.pi * 2_850 * timeline)
    )
    consonants = np.zeros(count, dtype=np.float32)
    for center in (1.18, 2.42, 4.76, 5.84):
        burst = np.exp(-0.5 * np.square((timeline - center) / 0.018)).astype(np.float32)
        consonants += burst * 0.0035 * np.sin(2 * math.pi * 4_200 * timeline)
    clean_speech = speech + consonants
    stationary = (
        0.0080 * np.sin(2 * math.pi * 43 * timeline)
        + 0.0045 * np.sin(2 * math.pi * 100 * timeline)
        + 0.0025 * rng.standard_normal(count).astype(np.float32)
    )
    mixture = clean_speech + stationary
    # One tap in background and one beside speech. Only the isolated one is safe
    # to target; nearby speech must remain protected.
    mixture[int(3.25 * audio_pipeline.SAMPLE_RATE)] += 0.65
    mixture[int(4.52 * audio_pipeline.SAMPLE_RATE)] += 0.65
    pcm = np.asarray(np.clip(mixture * 32767, -32768, 32767), dtype=np.int16)
    balanced, balanced_metadata = audio_pipeline._enhance_speech_pcm(pcm, "balanced")
    strong, strong_metadata = audio_pipeline._enhance_speech_pcm(pcm, "strong")
    source = pcm.astype(np.float32) / 32768.0
    balanced_float = balanced.astype(np.float32) / 32768.0
    strong_float = strong.astype(np.float32) / 32768.0
    speech_mask = envelope > 0.15
    background_mask = envelope < 0.01

    def rms(values: np.ndarray) -> float:
        return float(np.sqrt(np.mean(np.square(values), dtype=np.float64)))

    def correlation(left: np.ndarray, right: np.ndarray) -> float:
        return float(np.corrcoef(left, right)[0, 1])

    # Stationary background falls, Strong is stronger, while the quiet synthetic
    # speech becomes more correlated with the clean reference rather than erased.
    assert rms(balanced_float[background_mask]) < rms(source[background_mask]) * 0.82
    assert rms(strong_float[background_mask]) < rms(balanced_float[background_mask])
    assert correlation(balanced_float[speech_mask], clean_speech[speech_mask]) > correlation(source[speech_mask], clean_speech[speech_mask])
    assert correlation(strong_float[speech_mask], clean_speech[speech_mask]) > 0.45
    assert rms(balanced_float[speech_mask]) > rms(clean_speech[speech_mask]) * 0.60
    assert balanced_metadata["transient_events_attenuated"] >= 1
    assert strong_metadata["stationary_noise_attenuation_db"] > balanced_metadata["stationary_noise_attenuation_db"]

    silence = np.zeros(audio_pipeline.SAMPLE_RATE, dtype=np.int16)
    enhanced_silence, silence_metadata = audio_pipeline._enhance_speech_pcm(silence, "balanced")
    assert np.count_nonzero(enhanced_silence) == 0
    assert silence_metadata["vad_trimming"] is False


def test_audio_pipeline(root: Path) -> None:
    source = root / "original.wav"
    derived = root / "derived.wav"
    fallback = root / "fallback.wav"
    retained_balanced = root / "retained-balanced.wav"
    retained_strong = root / "retained-strong.wav"
    make_test_wav(source)
    before = audio_pipeline.file_md5(source)
    assert 1.9 <= audio_pipeline.audio_duration_seconds(source) <= 2.1
    metadata = audio_pipeline.write_transcription_window(source, derived, 0, 1.5, "automatic")
    assert derived.is_file() and derived != source and metadata["derived"] is True
    assert audio_pipeline.file_md5(source) == before

    balanced_metadata = audio_pipeline.write_enhanced_copy(source, retained_balanced, "balanced")
    assert retained_balanced.is_file() and retained_balanced != source
    assert balanced_metadata["source_md5"] == before
    assert balanced_metadata["enhanced_size"] == retained_balanced.stat().st_size
    assert balanced_metadata["timestamp_reference"] == "original"
    assert audio_pipeline.file_md5(source) == before
    strong_metadata = audio_pipeline.write_enhanced_copy(source, retained_strong, "strong")
    assert retained_strong.is_file() and strong_metadata["mode"] == "strong"
    assert audio_pipeline.file_md5(source) == before
    retained_balanced.unlink()
    assert source.is_file() and audio_pipeline.file_md5(source) == before

    real_enhancer = audio_pipeline._enhance_speech_pcm
    try:
        def broken_enhancer(samples, mode):
            if audio_pipeline.normalize_cleanup_mode(mode) != "off":
                raise RuntimeError("simulated enhancement failure")
            return real_enhancer(samples, mode)

        audio_pipeline._enhance_speech_pcm = broken_enhancer
        with audio_pipeline.transcription_window(source, 0, 1, "automatic", root) as (path, result):
            assert path.is_file() and result["fallback_from"] == "automatic"
        assert not path.exists()
    finally:
        audio_pipeline._enhance_speech_pcm = real_enhancer
    assert audio_pipeline.file_md5(source) == before

    try:
        audio_pipeline.write_transcription_window(source, source, 0, 1, "original")
    except ValueError as error:
        assert "never overwrite" in str(error)
    else:
        raise AssertionError("in-place preprocessing was not rejected")


def test_job_store(root: Path) -> None:
    store = JobStore(root / "jobs")
    job_id = "a" * 32
    original = store.directory(job_id) / "original.m4a"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"protected-copy")
    store.write({
        "id": job_id,
        "status": "transcribing",
        "audio_path": str(original),
        "checkpoint": {"completed_chunk": 1, "segments": [{"text": "safe"}]},
        "created_at": time.time(),
    })
    recovered = JobStore(root / "jobs").mark_unfinished_interrupted()[job_id]
    assert recovered["status"] == "interrupted"
    assert recovered["checkpoint"]["completed_chunk"] == 1
    assert original.read_bytes() == b"protected-copy"
    serialized = store.state_path(job_id).read_text(encoding="utf-8").casefold()
    assert "bearer" not in serialized and "pairing_code" not in serialized
    try:
        store.write({"id": "b" * 32, "status": "queued", "bearer_token": "secret"})
    except ValueError:
        pass
    else:
        raise AssertionError("job store accepted an authentication secret")
    try:
        store.write({"id": "c" * 32, "status": "queued", "checkpoint": {"authorization": "nested-secret"}})
    except ValueError:
        pass
    else:
        raise AssertionError("job store accepted a nested authentication secret")


def test_chunk_resume(root: Path) -> None:
    source = root / "source.bin"
    source.write_bytes(b"immutable original")
    source_hash_before = engine.file_md5(source)
    real = {
        "load_model": engine.load_model,
        "duration": engine.audio_duration_seconds,
        "window": engine.transcription_window,
        "pass": engine._transcribe_pass,
    }
    calls: list[int] = []

    @contextlib.contextmanager
    def fake_window(_source, start, end, _enhancement, directory):
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"section-{int(start)}.wav"
        target.write_bytes(b"derived")
        try:
            yield target, {"derived": True, "start_seconds": start, "end_seconds": end}
        finally:
            target.unlink(missing_ok=True)

    def fake_pass(_model, path, **_kwargs):
        start = int(path.stem.split("-")[1])
        calls.append(start)
        text = {0: "alpha", 295: "beta", 590: "gamma"}[start]
        segment = SimpleNamespace(start=0.0 if start == 0 else 3.0, end=10.0, text=text, avg_logprob=-0.2, no_speech_prob=0.01, words=[])
        return iter([segment]), SimpleNamespace(language="en")

    try:
        engine.load_model = lambda *_args, **_kwargs: (object(), "cpu", "int8")
        engine.audio_duration_seconds = lambda _path: 605.0
        engine.transcription_window = fake_window
        engine._transcribe_pass = fake_pass
        saved = None

        def interrupt_after_second(payload):
            nonlocal saved
            saved = payload
            if payload["completed_chunk"] == 1:
                raise RuntimeError("simulated helper interruption")

        try:
            engine.transcribe_audio(source, "small", root / "models", checkpoint_callback=interrupt_after_second, working_directory=root / "work")
        except RuntimeError as error:
            assert "simulated helper interruption" in str(error)
        else:
            raise AssertionError("simulated interruption did not stop the first run")
        assert saved and saved["completed_chunk"] == 1
        assert calls == [0, 295]

        calls.clear()
        result = engine.transcribe_audio(source, "small", root / "models", checkpoint=saved, working_directory=root / "work")
        assert calls == [590], "resume must start at the first unfinished window"
        assert [segment["text"] for segment in result["segments"]] == ["alpha", "beta", "gamma"]
        assert all(left["end"] <= right["start"] for left, right in zip(result["segments"], result["segments"][1:]))
        assert engine.file_md5(source) == source_hash_before
    finally:
        engine.load_model = real["load_model"]
        engine.audio_duration_seconds = real["duration"]
        engine.transcription_window = real["window"]
        engine._transcribe_pass = real["pass"]


def test_quality_retry_integration(root: Path) -> None:
    source = root / "quality-source.bin"
    source.write_bytes(b"immutable quality source")
    before = engine.file_md5(source)
    real = {
        "load_model": engine.load_model,
        "duration": engine.audio_duration_seconds,
        "window": engine.transcription_window,
        "pass": engine._transcribe_pass,
    }
    cleanup_attempts: list[str] = []

    @contextlib.contextmanager
    def fake_window(_source, start, _end, enhancement, directory):
        cleanup_attempts.append(enhancement)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"section-{int(start)}-{enhancement}.wav"
        target.write_bytes(b"derived only")
        try:
            yield target, {"derived": True, "mode": enhancement}
        finally:
            target.unlink(missing_ok=True)

    def fake_pass(_model, path, **_kwargs):
        mode = path.stem.rsplit("-", 1)[-1]
        suspicious = mode == "strong"
        segment = SimpleNamespace(
            start=0.0,
            end=8.0,
            text="repeat repeat repeat repeat repeat repeat repeat" if suspicious else "clear synthetic lecture speech",
            avg_logprob=-1.2 if suspicious else -0.15,
            no_speech_prob=0.7 if suspicious else 0.01,
            compression_ratio=2.9 if suspicious else 1.1,
            words=[],
        )
        return iter([segment]), SimpleNamespace(language="en")

    try:
        engine.load_model = lambda *_args, **_kwargs: (object(), "cpu", "int8")
        engine.audio_duration_seconds = lambda _path: 60.0
        engine.transcription_window = fake_window
        engine._transcribe_pass = fake_pass
        result = engine.transcribe_audio(source, "small", root / "models", enhancement="strong", working_directory=root / "quality-work")
        assert cleanup_attempts == ["strong", "balanced"]
        assert result["quality_records"][0]["selected_cleanup_mode"] == "balanced"
        assert result["quality_records"][0]["selected_suspicious"] is False
        assert result["segments"][0]["text"] == "clear synthetic lecture speech"
        assert engine.file_md5(source) == before
    finally:
        engine.load_model = real["load_model"]
        engine.audio_duration_seconds = real["duration"]
        engine.transcription_window = real["window"]
        engine._transcribe_pass = real["pass"]


def test_cooperative_cancel(root: Path) -> None:
    source = root / "cancel-source.bin"
    source.write_bytes(b"immutable cancellation source")
    before = engine.file_md5(source)
    real = {
        "load_model": engine.load_model,
        "duration": engine.audio_duration_seconds,
        "window": engine.transcription_window,
        "pass": engine._transcribe_pass,
    }
    calls: list[int] = []
    checkpoint: dict | None = None
    cancel_requested = False

    @contextlib.contextmanager
    def fake_window(_source, start, _end, _enhancement, directory):
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"section-{int(start)}.wav"
        target.write_bytes(b"derived")
        try:
            yield target, {"derived": True}
        finally:
            target.unlink(missing_ok=True)

    def fake_pass(_model, path, **_kwargs):
        start = int(path.stem.split("-")[1])
        calls.append(start)
        segment = SimpleNamespace(start=0.0, end=8.0, text=f"section {start}", avg_logprob=-0.2, no_speech_prob=0.01, words=[])
        return iter([segment]), SimpleNamespace(language="en")

    def save_then_cancel(payload):
        nonlocal checkpoint, cancel_requested
        checkpoint = payload
        cancel_requested = True

    try:
        engine.load_model = lambda *_args, **_kwargs: (object(), "cpu", "int8")
        engine.audio_duration_seconds = lambda _path: 605.0
        engine.transcription_window = fake_window
        engine._transcribe_pass = fake_pass
        try:
            engine.transcribe_audio(
                source,
                "small",
                root / "models",
                checkpoint_callback=save_then_cancel,
                working_directory=root / "cancel-work",
                cancellation_check=lambda: cancel_requested,
            )
        except engine.TranscriptionCancelled:
            pass
        else:
            raise AssertionError("cooperative cancellation did not stop before the second window")
        assert checkpoint and checkpoint["completed_chunk"] == 0
        assert calls == [0]
        assert engine.file_md5(source) == before
    finally:
        engine.load_model = real["load_model"]
        engine.audio_duration_seconds = real["duration"]
        engine.transcription_window = real["window"]
        engine._transcribe_pass = real["pass"]


def test_corrupt_audio(root: Path) -> None:
    corrupt = root / "corrupt.m4a"
    corrupt.write_bytes(b"not an audio container")
    try:
        audio_pipeline.audio_duration_seconds(corrupt)
    except Exception:
        pass
    else:
        raise AssertionError("corrupt audio was accepted as a valid recording")


def test_job_control_and_low_storage(root: Path) -> None:
    os.environ["LECTUREAI_RUNTIME_DIR"] = str(root / "api-runtime")
    import server
    from fastapi import BackgroundTasks, HTTPException

    server.LAN_MODE = False
    server.jobs.clear()
    server.active_job_ids.clear()
    job_id = "d" * 32
    directory = server.JOB_STORE.directory(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    audio = directory / "original.m4a"
    audio.write_bytes(b"retained Windows upload")
    now = time.time()
    server.jobs[job_id] = server.JOB_STORE.write({
        "id": job_id,
        "status": "transcribing",
        "audio_path": str(audio),
        "owner_host": "127.0.0.1",
        "created_at": now,
        "last_progress_at": now,
        "completed_audio_seconds": 300,
        "total_audio_seconds": 600,
        "checkpoint": {"completed_chunk": 0, "segments": [{"text": "safe"}], "processing_seconds_accumulated": 60},
    })
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))

    assert server.public_job(dict(server.jobs[job_id]))["eta_seconds"] == 60
    assert server.protected_path("/enhancements") and server.protected_path("/enhancements/example/audio")

    enhancement_id = "e" * 32
    enhancement_directory = server.ENHANCEMENT_STORE.directory(enhancement_id)
    enhancement_directory.mkdir(parents=True, exist_ok=True)
    enhancement_source = enhancement_directory / "original.m4a"
    enhancement_output = enhancement_directory / "enhanced-balanced.wav"
    enhancement_source.write_bytes(b"temporary uploaded source")
    enhancement_output.write_bytes(b"temporary derived audio")
    server.enhancement_jobs[enhancement_id] = server.ENHANCEMENT_STORE.write({
        "id": enhancement_id,
        "status": "complete",
        "owner_host": "127.0.0.1",
        "audio_path": str(enhancement_source),
        "output_path": str(enhancement_output),
        "cleanup_mode": "balanced",
        "created_at": now,
        "result": {"source_md5": "a" * 32, "enhanced_md5": "b" * 32},
    })
    public_enhancement = server.public_enhancement_job(dict(server.enhancement_jobs[enhancement_id]))
    assert public_enhancement["download_ready"] is True
    assert "audio_path" not in public_enhancement and "output_path" not in public_enhancement and "owner_host" not in public_enhancement
    released = server.release_enhancement(enhancement_id, request)
    assert released["released"] is True and not enhancement_directory.exists()

    requested = server.cancel_job(job_id, request)
    assert "cancel_requested" not in requested
    assert server.jobs[job_id]["cancel_requested"] is True

    server.set_job(job_id, status="cancelled", cancel_requested=False)
    assert server.public_job(dict(server.jobs[job_id]))["eta_seconds"] is None
    resume_tasks = BackgroundTasks()
    resumed = server.resume_job(job_id, resume_tasks, request)
    assert resumed["status"] == "queued" and len(resume_tasks.tasks) == 1

    server.set_job(job_id, status="failed")
    retry_tasks = BackgroundTasks()
    retried = server.retry_current_section(job_id, retry_tasks, request)
    assert retried["status"] == "queued" and len(retry_tasks.tasks) == 1
    assert server.jobs[job_id]["checkpoint"]["completed_chunk"] == 0

    real_disk_usage = server.shutil.disk_usage
    try:
        server.shutil.disk_usage = lambda _path: SimpleNamespace(free=1)
        try:
            server.ensure_upload_space(directory)
        except HTTPException as error:
            assert error.status_code == 507
        else:
            raise AssertionError("low disk space did not stop a new upload")
    finally:
        server.shutil.disk_usage = real_disk_usage
        server.jobs.clear()
        server.enhancement_jobs.clear()


def run() -> None:
    test_root = Path.cwd() / ".lectureai-runtime" / "test-temp"
    test_root.mkdir(parents=True, exist_ok=True)
    root = test_root / "active"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=False)
    try:
        test_window_planning()
        test_bounded_quality_retry_logic()
        test_cleanup_profiles()
        test_speech_focused_enhancement()
        test_audio_pipeline(root)
        test_job_store(root)
        test_chunk_resume(root)
        test_quality_retry_integration(root)
        test_cooperative_cancel(root)
        test_corrupt_audio(root)
        test_job_control_and_low_storage(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("[PASS] 65-minute/2-hour planning, speech-focused cleanup, bounded quality fallback, derived-audio integrity, cancellation, durable jobs, deterministic overlap, failure, and checkpoint resume passed")


if __name__ == "__main__":
    run()
