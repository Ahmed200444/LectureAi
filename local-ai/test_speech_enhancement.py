from __future__ import annotations

import math
import shutil
import wave
from pathlib import Path

import numpy as np

import audio_enhancement
import audio_pipeline
import engine


def rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values), dtype=np.float64)))


def correlation(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.corrcoef(left, right)[0, 1])


def synthetic_classroom() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(20260912)
    count = audio_pipeline.SAMPLE_RATE * 8
    timeline = np.arange(count, dtype=np.float32) / audio_pipeline.SAMPLE_RATE
    envelope = np.zeros(count, dtype=np.float32)
    for center in (1.0, 1.34, 1.82, 2.25, 4.15, 4.52, 5.05, 5.62):
        envelope += np.exp(-0.5 * np.square((timeline - center) / 0.10)).astype(np.float32)
    envelope = np.clip(envelope, 0.0, 1.0)
    speech = envelope * (
        0.0055 * np.sin(2 * math.pi * 185 * timeline)
        + 0.0040 * np.sin(2 * math.pi * 740 * timeline)
        + 0.0025 * np.sin(2 * math.pi * 2_850 * timeline)
    )
    for center in (1.18, 2.42, 4.76, 5.84):
        burst = np.exp(-0.5 * np.square((timeline - center) / 0.018)).astype(np.float32)
        speech += burst * 0.0035 * np.sin(2 * math.pi * 4_200 * timeline)
    noise = (
        0.0080 * np.sin(2 * math.pi * 43 * timeline)
        + 0.0045 * np.sin(2 * math.pi * 100 * timeline)
        + 0.0025 * rng.standard_normal(count).astype(np.float32)
    )
    mixture = speech + noise
    mixture[int(3.25 * audio_pipeline.SAMPLE_RATE)] += 0.65
    pcm = np.asarray(np.clip(mixture * 32767, -32768, 32767), dtype=np.int16)
    return pcm, speech, envelope > 0.15, envelope < 0.01


def previous_balanced_cleanup(samples: np.ndarray) -> np.ndarray:
    """The immediately preceding Balanced DSP, retained only as an A/B fixture."""
    floating = samples.astype(np.float32) / 32768.0
    alpha = math.exp(-2.0 * math.pi * 78.0 / audio_pipeline.SAMPLE_RATE)
    filtered = np.empty_like(floating)
    previous_input = 0.0
    previous_output = 0.0
    for index, value in enumerate(floating):
        output = alpha * (previous_output + float(value) - previous_input)
        filtered[index] = output
        previous_input = float(value)
        previous_output = output
    frame_size = audio_pipeline.SAMPLE_RATE // 10
    frame_count = math.ceil(filtered.size / frame_size)
    frame_rms = np.asarray([
        rms(filtered[index * frame_size:(index + 1) * frame_size])
        for index in range(frame_count)
    ])
    non_silent = frame_rms[frame_rms > 0.0001]
    noise_floor = float(np.percentile(non_silent, 20)) if non_silent.size else 0.0
    speech_gate = max(0.002, noise_floor * 1.55)
    frame_gains = np.ones(frame_count, dtype=np.float32)
    previous_gain = 1.0
    for index, value in enumerate(frame_rms):
        if noise_floor > 0 and value <= noise_floor * 1.05:
            desired = 0.92
        elif value <= speech_gate:
            desired = 1.0
        else:
            desired = min(2.8, max(1.0, 0.050 / max(float(value), 0.0005)))
        desired = min(previous_gain + 0.16, max(previous_gain - 0.16, desired))
        previous_gain += (desired - previous_gain) * (0.28 if desired > previous_gain else 0.12)
        frame_gains[index] = previous_gain
    gained = filtered * np.repeat(frame_gains, frame_size)[:filtered.size]
    ceiling = 10 ** (-1.0 / 20.0)
    return np.tanh(gained / ceiling) * ceiling


def test_quiet_distant_speech_and_stationary_noise() -> dict[str, float]:
    pcm, clean_speech, speech_mask, background_mask = synthetic_classroom()
    source = pcm.astype(np.float32) / 32768.0
    previous = previous_balanced_cleanup(pcm)
    balanced, _ = audio_pipeline._enhance_speech_pcm(pcm, "balanced")
    strong, _ = audio_pipeline._enhance_speech_pcm(pcm, "strong")
    balanced_float = balanced.astype(np.float32) / 32768.0
    strong_float = strong.astype(np.float32) / 32768.0
    source_correlation = correlation(source[speech_mask], clean_speech[speech_mask])
    previous_correlation = correlation(previous[speech_mask], clean_speech[speech_mask])
    balanced_correlation = correlation(balanced_float[speech_mask], clean_speech[speech_mask])
    strong_correlation = correlation(strong_float[speech_mask], clean_speech[speech_mask])
    balanced_noise_reduction = 20 * math.log10(rms(source[background_mask]) / rms(balanced_float[background_mask]))
    previous_noise_reduction = 20 * math.log10(rms(source[background_mask]) / rms(previous[background_mask]))
    strong_noise_reduction = 20 * math.log10(rms(source[background_mask]) / rms(strong_float[background_mask]))
    assert balanced_correlation > source_correlation
    assert strong_correlation > 0.45
    assert balanced_noise_reduction > 1.7
    assert balanced_noise_reduction > previous_noise_reduction + 1.0
    assert strong_noise_reduction > balanced_noise_reduction
    assert balanced_correlation >= previous_correlation - 0.05
    assert rms(balanced_float[speech_mask]) > rms(clean_speech[speech_mask]) * 0.60
    return {
        "source_speech_correlation": source_correlation,
        "previous_balanced_speech_correlation": previous_correlation,
        "balanced_speech_correlation": balanced_correlation,
        "strong_speech_correlation": strong_correlation,
        "previous_balanced_background_reduction_db": previous_noise_reduction,
        "balanced_background_reduction_db": balanced_noise_reduction,
        "strong_background_reduction_db": strong_noise_reduction,
    }


def test_safe_transient_handling() -> None:
    count = audio_pipeline.SAMPLE_RATE * 2
    timeline = np.arange(count, dtype=np.float32) / audio_pipeline.SAMPLE_RATE
    isolated = 0.001 * np.sin(2 * math.pi * 100 * timeline)
    isolated[count // 2] = 0.75
    isolated_pcm = np.asarray(isolated * 32767, dtype=np.int16)
    _, isolated_metadata = audio_pipeline._enhance_speech_pcm(isolated_pcm, "strong")
    assert isolated_metadata["transient_events_attenuated"] >= 1

    speech_adjacent = 0.012 * np.sin(2 * math.pi * 240 * timeline)
    speech_adjacent[count // 2] += 0.75
    speech_pcm = np.asarray(np.clip(speech_adjacent * 32767, -32768, 32767), dtype=np.int16)
    _, speech_metadata = audio_pipeline._enhance_speech_pcm(speech_pcm, "strong")
    assert speech_metadata["transient_events_attenuated"] == 0


def test_off_silence_language_and_bounds() -> None:
    silence = np.zeros(audio_pipeline.SAMPLE_RATE, dtype=np.int16)
    off, off_metadata = audio_pipeline._enhance_speech_pcm(silence, "off")
    balanced, balanced_metadata = audio_pipeline._enhance_speech_pcm(silence, "balanced")
    assert np.array_equal(off, silence) and off_metadata["applied"] is False
    assert np.count_nonzero(balanced) == 0
    assert balanced_metadata["vad_guided"] is True and balanced_metadata["vad_trimming"] is False
    assert audio_enhancement.MAX_SPECTRAL_BATCH_FRAMES == 256
    assert len(engine.plan_audio_windows(120 * 60)) == 25
    prompt = engine.context_prompt(["pointer", "الانحدار الخطي"])
    assert "Egyptian Arabic" in prompt and "Modern Standard Arabic" in prompt
    assert "Keep English technical terms in English" in prompt and "الانحدار الخطي" in prompt


def test_generated_source_hash_is_unchanged(root: Path) -> None:
    pcm, _, _, _ = synthetic_classroom()
    source = root / "generated-original.wav"
    derived = root / "generated-derived.wav"
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(audio_pipeline.SAMPLE_RATE)
        output.writeframes(pcm.tobytes())
    before = audio_pipeline.file_md5(source)
    audio_pipeline.write_transcription_window(source, derived, 0.0, 8.0, "balanced")
    assert derived.is_file() and derived.resolve() != source.resolve()
    assert audio_pipeline.file_md5(source) == before


def run() -> None:
    root = Path.cwd() / ".lectureai-runtime" / "speech-enhancement-test"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=False)
    try:
        metrics = test_quiet_distant_speech_and_stationary_noise()
        test_safe_transient_handling()
        test_off_silence_language_and_bounds()
        test_generated_source_hash_is_unchanged(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("[PASS] generated quiet/distant speech, stationary noise, safe transients, silence, mixed-language context, bounded long windows, and source hashes")
    for key, value in metrics.items():
        print(f"{key}={value:.4f}")


if __name__ == "__main__":
    run()
