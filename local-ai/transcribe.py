from __future__ import annotations

import argparse
import json
from pathlib import Path

from engine import MODEL_INFO, read_context_files, transcribe_audio


def progress_line(value: int, message: str) -> None:
    print(f"[{max(0, min(100, int(value))):3d}%] {message}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe a LectureAI recording locally with timestamped multilingual segments.")
    parser.add_argument("audio", type=Path, help="Original audio file; it is never modified")
    parser.add_argument("--model", choices=MODEL_INFO.keys(), default="large-v3", help="Whisper model; large-v3 is the strongest configured option but needs more RAM/VRAM")
    parser.add_argument("--output", type=Path, help="Output JSON path")
    parser.add_argument("--glossary", action="append", default=[], help="Course term; repeat as needed")
    parser.add_argument("--context", type=Path, action="append", default=[], help="Local PDF/TXT/MD terminology source")
    parser.add_argument(
        "--enhancement",
        choices=("balanced", "off"),
        default="balanced",
        help="Use a temporary speech-oriented copy with gentle stationary-noise reduction when FFmpeg is available; original audio is never modified",
    )
    parser.add_argument(
        "--source-only",
        action="store_true",
        help="Skip the second full English-translation pass. This is faster for Arabic/mixed lectures and preserves the original multilingual transcript as the editable result.",
    )
    args = parser.parse_args()

    audio = args.audio.resolve()
    if not audio.is_file():
        raise SystemExit(f"Audio file not found: {audio}")
    context_paths = [path.resolve() for path in args.context]
    if any(not path.is_file() for path in context_paths):
        raise SystemExit("One or more context files do not exist.")

    glossary = [*args.glossary, *read_context_files(context_paths)]
    models_dir = Path(__file__).resolve().parent.parent / "models"
    models_dir.mkdir(exist_ok=True)
    output = args.output.resolve() if args.output else audio.with_suffix(".lectureai.json")

    print(f"Original audio: {audio}")
    print(f"Model: {args.model}")
    print(f"Audio enhancement: {args.enhancement} (derived transcription copy only)")
    print(f"English translation pass: {'off' if args.source_only else 'on'}")
    if glossary:
        print(f"Recognition context: {len(glossary)} course term(s)")

    result = transcribe_audio(
        audio,
        args.model,
        models_dir,
        glossary,
        progress_line,
        enhancement=args.enhancement,
        translate_to_english=not args.source_only,
    )
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    preparation = result.get("audio_preparation") or {}
    if preparation.get("applied"):
        print("Audio preparation: temporary noise-reduced speech copy used; original hash verified unchanged.")
    else:
        print(f"Audio preparation: original used ({preparation.get('reason', 'no preprocessing metadata')}).")
    print(f"Runtime: {result.get('device', 'unknown')} / {result.get('compute_type', 'unknown')}")
    if result.get("processing_seconds") is not None:
        print(f"Processing time: {result['processing_seconds']} seconds")
    if result.get("real_time_factor") is not None:
        print(f"Measured real-time factor (RTF): {result['real_time_factor']}")
    print(f"Transcript written to: {output}")
    print("Import this JSON from the LectureAI lecture page. The protected original recording was not modified.")


if __name__ == "__main__":
    main()
