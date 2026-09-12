from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from audio_enhancement import prepare_audio_copy


def make_source(directory: Path) -> Path:
    source = directory / "lecture.m4a"
    source.write_bytes((b"LectureAI-original-audio" * 200) + b"end")
    return source


def test_disabled_uses_original() -> None:
    with tempfile.TemporaryDirectory() as raw:
        directory = Path(raw)
        source = make_source(directory)
        before = source.read_bytes()
        result = prepare_audio_copy(source, directory / "work", "off")
        assert result.applied is False
        assert Path(result.transcription_path) == source.resolve()
        assert source.read_bytes() == before
        assert result.source_sha256_before == result.source_sha256_after


def test_missing_ffmpeg_falls_back_without_touching_source() -> None:
    with tempfile.TemporaryDirectory() as raw:
        directory = Path(raw)
        source = make_source(directory)
        before = source.read_bytes()
        with patch("audio_enhancement.shutil.which", return_value=None):
            result = prepare_audio_copy(source, directory / "work", "balanced")
        assert result.applied is False
        assert "ffmpeg-not-found" in result.reason
        assert Path(result.transcription_path) == source.resolve()
        assert source.read_bytes() == before
        assert result.source_sha256_before == result.source_sha256_after


def test_successful_preparation_is_separate_and_source_is_unchanged() -> None:
    with tempfile.TemporaryDirectory() as raw:
        directory = Path(raw)
        source = make_source(directory)
        before = source.read_bytes()

        def fake_run(command, **_kwargs):
            target = Path(command[-1])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"RIFF" + (b"derived-speech-copy" * 100))

            class Completed:
                returncode = 0
                stderr = ""

            return Completed()

        with patch("audio_enhancement.shutil.which", return_value="ffmpeg"), patch("audio_enhancement.subprocess.run", side_effect=fake_run):
            result = prepare_audio_copy(source, directory / "work", "balanced")

        prepared = Path(result.transcription_path)
        assert result.applied is True
        assert prepared != source.resolve()
        assert prepared.exists() and prepared.stat().st_size >= 1024
        assert source.read_bytes() == before
        assert result.source_sha256_before == result.source_sha256_after


def test_failed_preparation_falls_back_without_touching_source() -> None:
    with tempfile.TemporaryDirectory() as raw:
        directory = Path(raw)
        source = make_source(directory)
        before = source.read_bytes()

        class Completed:
            returncode = 1
            stderr = "simulated ffmpeg failure"

        with patch("audio_enhancement.shutil.which", return_value="ffmpeg"), patch("audio_enhancement.subprocess.run", return_value=Completed()):
            result = prepare_audio_copy(source, directory / "work", "balanced")

        assert result.applied is False
        assert "preprocessing-failed" in result.reason
        assert Path(result.transcription_path) == source.resolve()
        assert source.read_bytes() == before
        assert result.source_sha256_before == result.source_sha256_after


if __name__ == "__main__":
    test_disabled_uses_original()
    test_missing_ffmpeg_falls_back_without_touching_source()
    test_successful_preparation_is_separate_and_source_is_unchanged()
    test_failed_preparation_falls_back_without_touching_source()
    print("audio enhancement tests passed")
