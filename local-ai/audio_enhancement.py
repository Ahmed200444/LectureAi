from __future__ import annotations

import hashlib
import math
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np


SAMPLE_RATE = 16_000
FRAME_SIZE = 512
FRAME_HOP = 256
MAX_SPECTRAL_BATCH_FRAMES = 256
MAX_NOISE_PROFILE_FRAMES = 384

# Compatibility API retained from the first non-destructive enhancement release.
# The durable helper uses the bounded PCM pipeline below, while older scripts and
# its original regression test can still request a whole-file FFmpeg copy.
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
    """Create the legacy optional FFmpeg copy without ever modifying the source."""
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
        target.unlink(missing_ok=True)
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
        reason="temporary speech-oriented copy created",
        filter_chain=BALANCED_FILTER,
        source_sha256_before=source_hash_before,
        source_sha256_after=source_hash_after,
    )


def _frame_positions(sample_count: int) -> np.ndarray:
    if sample_count <= FRAME_SIZE:
        return np.asarray([0], dtype=np.int64)
    positions = np.arange(0, sample_count - FRAME_SIZE + 1, FRAME_HOP, dtype=np.int64)
    final = sample_count - FRAME_SIZE
    if positions[-1] != final:
        positions = np.append(positions, final)
    return positions


def _frames_at(samples: np.ndarray, positions: np.ndarray) -> np.ndarray:
    offsets = np.arange(FRAME_SIZE, dtype=np.int64)
    return samples[positions[:, None] + offsets[None, :]]


def _noise_profile(samples: np.ndarray, positions: np.ndarray, window: np.ndarray) -> tuple[np.ndarray, float, int]:
    """Estimate stationary noise from a bounded, distributed set of quiet frames."""
    if positions.size > MAX_NOISE_PROFILE_FRAMES:
        selected = np.linspace(0, positions.size - 1, MAX_NOISE_PROFILE_FRAMES, dtype=np.int64)
        candidates = positions[selected]
    else:
        candidates = positions
    frames = _frames_at(samples, candidates)
    rms = np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64)).astype(np.float32)
    quiet_count = min(rms.size, max(8, int(math.ceil(rms.size * 0.20))))
    quiet_indices = np.argsort(rms)[:quiet_count]
    quiet = frames[quiet_indices]
    spectra = np.fft.rfft(quiet * window[None, :], axis=1)
    # A median resists isolated taps/paper movement contaminating the stationary
    # profile. It is deliberately conservative: later gains always have a floor.
    power = np.median(np.square(np.abs(spectra)), axis=0).astype(np.float32)
    noise_rms = float(np.median(rms[quiet_indices])) if quiet_indices.size else 0.0
    return power, noise_rms, int(quiet_indices.size)


def _spectral_speech_enhance(samples: np.ndarray, mode: str) -> tuple[np.ndarray, dict[str, Any]]:
    """Soft speech-aware suppression; no frame is cut and no timeline is changed."""
    pad = FRAME_SIZE // 2
    padded = np.pad(samples, (pad, pad), mode="reflect" if samples.size > pad else "edge")
    positions = _frame_positions(padded.size)
    window = np.sqrt(np.hanning(FRAME_SIZE).astype(np.float32) + 1e-8)
    noise_power, noise_rms, profile_frames = _noise_profile(padded, positions, window)
    frequencies = np.fft.rfftfreq(FRAME_SIZE, 1.0 / SAMPLE_RATE).astype(np.float32)

    if mode == "balanced":
        cutoff_hz = 72.0
        speech_floor = 0.74
        non_speech_floor = 0.56
        outside_floor = 0.48
        presence_high = 3.0
    else:
        cutoff_hz = 78.0
        speech_floor = 0.60
        non_speech_floor = 0.38
        outside_floor = 0.30
        presence_high = 3.6

    speech_band = (frequencies >= 110.0) & (frequencies <= 7_200.0)
    minimum_gain = np.where(speech_band, non_speech_floor, outside_floor).astype(np.float32)
    # The smooth high-pass removes vibration/rumble without a sample-by-sample
    # Python loop. A very gentle Nyquist roll-off reduces hiss without touching
    # the consonant-heavy 2–7 kHz range.
    safe_frequency = np.maximum(frequencies, 1.0)
    high_pass = 1.0 / np.sqrt(1.0 + np.power(cutoff_hz / safe_frequency, 4.0))
    high_pass[0] = 0.0
    nyquist_rolloff = np.ones_like(frequencies)
    high = frequencies > 7_200.0
    nyquist_rolloff[high] = np.cos(((frequencies[high] - 7_200.0) / 800.0) * (math.pi / 2.0)) ** 2
    spectral_shape = (high_pass * nyquist_rolloff).astype(np.float32)

    output = np.zeros(padded.size, dtype=np.float32)
    weights = np.zeros(padded.size, dtype=np.float32)
    previous_gain = np.ones(noise_power.size, dtype=np.float32)
    speech_probabilities: list[float] = []
    epsilon = 1e-10

    for batch_start in range(0, positions.size, MAX_SPECTRAL_BATCH_FRAMES):
        batch_positions = positions[batch_start:batch_start + MAX_SPECTRAL_BATCH_FRAMES]
        frames = _frames_at(padded, batch_positions)
        spectra = np.fft.rfft(frames * window[None, :], axis=1)
        power = np.square(np.abs(spectra)).astype(np.float32)
        posterior_snr = np.maximum(power - noise_power[None, :], 0.0) / (noise_power[None, :] + epsilon)
        wiener = np.sqrt(posterior_snr / (posterior_snr + 1.0)).astype(np.float32)
        frame_rms = np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64))
        energy_ratio = frame_rms / max(noise_rms, 1e-5)
        speech_probability = np.clip((energy_ratio - 1.08) / (presence_high - 1.08), 0.0, 1.0).astype(np.float32)
        speech_probabilities.extend(float(value) for value in speech_probability)

        raw_gain = np.maximum(wiener, minimum_gain[None, :])
        # Likely speech receives substantially less attenuation. Quiet speech that
        # is not confidently detected is still protected by the per-bin floor.
        raw_gain = 1.0 - (1.0 - raw_gain) * (1.0 - 0.82 * speech_probability[:, None])
        raw_gain[:, speech_band] = np.maximum(
            raw_gain[:, speech_band],
            speech_floor * (0.82 + 0.18 * speech_probability[:, None]),
        )
        # Light frequency smoothing avoids musical-noise holes.
        raw_gain[:, 1:-1] = (
            0.20 * raw_gain[:, :-2]
            + 0.60 * raw_gain[:, 1:-1]
            + 0.20 * raw_gain[:, 2:]
        )

        smoothed = np.empty_like(raw_gain)
        for frame_index in range(raw_gain.shape[0]):
            target = raw_gain[frame_index]
            # Attenuation arrives slowly; recovery is faster. This favors speech
            # onsets/endings and prevents pumping when a distant voice begins.
            coefficient = np.where(target < previous_gain, 0.18, 0.62)
            previous_gain = previous_gain + coefficient * (target - previous_gain)
            smoothed[frame_index] = previous_gain

        reconstructed = np.fft.irfft(spectra * smoothed * spectral_shape[None, :], n=FRAME_SIZE, axis=1).astype(np.float32)
        reconstructed *= window[None, :]
        window_weight = np.square(window)
        for frame_index, position in enumerate(batch_positions):
            start = int(position)
            output[start:start + FRAME_SIZE] += reconstructed[frame_index]
            weights[start:start + FRAME_SIZE] += window_weight

    valid = weights > 1e-7
    output[valid] /= weights[valid]
    output = output[pad:pad + samples.size]
    return output, {
        "technology": "speech-aware-spectral-v1",
        "speech_activity_method": "soft-energy-plus-spectral-snr",
        "vad_guided": True,
        "vad_trimming": False,
        "noise_profile_frames": profile_frames,
        "noise_profile_rms": round(noise_rms, 7),
        "speech_preservation_floor": speech_floor,
        "non_speech_spectral_floor": non_speech_floor,
        "stationary_noise_attenuation_db": round(-20.0 * math.log10(non_speech_floor), 2),
        "average_speech_probability": round(float(np.mean(speech_probabilities)) if speech_probabilities else 0.0, 4),
        "high_pass_hz": cutoff_hz,
        "spectral_batch_frames": MAX_SPECTRAL_BATCH_FRAMES,
    }


def _attenuate_isolated_transients(samples: np.ndarray, mode: str, noise_rms: float) -> tuple[np.ndarray, int]:
    """Reduce isolated non-speech taps; preserve transients beside sustained speech."""
    block_size = SAMPLE_RATE // 100  # 10 ms
    block_count = int(math.ceil(samples.size / block_size))
    if block_count < 5:
        return samples, 0
    padded = np.pad(samples, (0, block_count * block_size - samples.size))
    blocks = padded.reshape(block_count, block_size)
    rms = np.sqrt(np.mean(np.square(blocks), axis=1, dtype=np.float64))
    peak = np.max(np.abs(blocks), axis=1)
    crest = peak / np.maximum(rms, 1e-6)
    envelope = np.ones(samples.size, dtype=np.float32)
    count = 0
    minimum_peak = max(0.035, noise_rms * 7.0)
    target = 0.82 if mode == "balanced" else 0.64

    for index in range(2, block_count - 2):
        neighbors = np.asarray([rms[index - 2], rms[index - 1], rms[index + 1], rms[index + 2]])
        surrounding = float(np.median(neighbors))
        # A continuously quiet/tonal voice can contaminate the conservative noise
        # profile. Treat stable surrounding energy as speech-like even in that
        # case; missing a tap is safer than damaging a nearby consonant.
        sustained_speech = surrounding > max(0.0035, noise_rms * 0.80)
        isolated = peak[index] > minimum_peak and crest[index] > 5.5 and rms[index] > max(surrounding * 2.8, noise_rms * 2.5)
        if sustained_speech or not isolated:
            continue
        start = max(0, index * block_size - block_size)
        end = min(samples.size, (index + 2) * block_size)
        length = end - start
        phase = np.linspace(-math.pi, math.pi, length, endpoint=False, dtype=np.float32)
        dip = target + (1.0 - target) * (0.5 - 0.5 * np.cos(phase))
        envelope[start:end] = np.minimum(envelope[start:end], dip)
        count += 1
    return samples * envelope, count


def _bounded_speech_gain(samples: np.ndarray, mode: str, noise_rms: float) -> tuple[np.ndarray, float]:
    frame_size = SAMPLE_RATE // 10
    frame_count = int(math.ceil(samples.size / frame_size))
    padded = np.pad(samples, (0, frame_count * frame_size - samples.size))
    frames = padded.reshape(frame_count, frame_size)
    rms = np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64))
    target_rms = 0.050 if mode == "balanced" else 0.058
    maximum_gain = 2.6 if mode == "balanced" else 3.2
    speech_gate = max(0.0018, noise_rms * (1.35 if mode == "balanced" else 1.25))
    noise_ceiling = max(noise_rms * 1.05, 0.0005)
    gains = np.ones(frame_count, dtype=np.float32)
    previous = 1.0
    for index, value in enumerate(rms):
        if value <= noise_ceiling:
            desired = 0.94 if mode == "balanced" else 0.86
        elif value < speech_gate:
            desired = 1.0
        else:
            desired = min(maximum_gain, max(1.0, target_rms / max(float(value), 0.0005)))
        step = 0.14 if mode == "balanced" else 0.18
        desired = min(previous + step, max(previous - step, desired))
        previous += (desired - previous) * (0.24 if desired > previous else 0.10)
        gains[index] = previous
    centers = np.minimum(np.arange(frame_count, dtype=np.float32) * frame_size + frame_size / 2, samples.size - 1)
    sample_positions = np.arange(samples.size, dtype=np.float32)
    smooth_gain = np.interp(sample_positions, centers, gains, left=gains[0], right=gains[-1]).astype(np.float32)
    return samples * smooth_gain, float(np.max(gains))


def enhance_speech_pcm(samples: np.ndarray, mode: str) -> tuple[np.ndarray, dict[str, Any]]:
    """Prioritize intelligible speech on a derived PCM copy only."""
    requested_mode = str(mode or "balanced").strip().lower()
    if requested_mode not in {"balanced", "strong"}:
        raise ValueError("Speech enhancement mode must be balanced or strong.")
    floating = samples.astype(np.float32) / 32768.0
    input_rms = float(np.sqrt(np.mean(np.square(floating), dtype=np.float64))) if floating.size else 0.0
    input_peak = float(np.max(np.abs(floating))) if floating.size else 0.0
    if not floating.size:
        return samples.copy(), {
            "mode": requested_mode,
            "requested_mode": requested_mode,
            "applied": True,
            "technology": "speech-aware-spectral-v1",
            "vad_guided": True,
            "vad_trimming": False,
            "input_rms": 0.0,
            "input_peak": 0.0,
            "maximum_gain": 1.0,
            "maximum_applied_gain": 1.0,
            "transient_suppression": False,
            "transient_events_attenuated": 0,
        }

    enhanced, metadata = _spectral_speech_enhance(floating, requested_mode)
    enhanced, transient_count = _attenuate_isolated_transients(
        enhanced,
        requested_mode,
        float(metadata.get("noise_profile_rms") or 0.0),
    )
    enhanced, maximum_applied_gain = _bounded_speech_gain(
        enhanced,
        requested_mode,
        float(metadata.get("noise_profile_rms") or 0.0),
    )
    limiter_ceiling = 10 ** (-1.0 / 20.0)
    enhanced = np.tanh(enhanced / limiter_ceiling) * limiter_ceiling
    result = np.asarray(np.clip(enhanced * 32767.0, -32768, 32767), dtype=np.int16)
    output_peak = float(np.max(np.abs(result.astype(np.float32) / 32768.0))) if result.size else 0.0
    maximum_gain = 2.6 if requested_mode == "balanced" else 3.2
    return result, {
        **metadata,
        "mode": requested_mode,
        "requested_mode": requested_mode,
        "applied": True,
        "input_rms": round(input_rms, 7),
        "input_peak": round(input_peak, 7),
        "maximum_gain": maximum_gain,
        "maximum_applied_gain": round(maximum_applied_gain, 3),
        "output_peak": round(output_peak, 7),
        "transient_suppression": transient_count > 0,
        "transient_events_attenuated": transient_count,
        "warning": "Strong cleanup can affect difficult or overlapping speech; compare against the protected original." if requested_mode == "strong" else "",
    }
