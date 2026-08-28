from __future__ import annotations

import argparse
import json
from pathlib import Path

from engine import MODEL_INFO, read_context_files, transcribe_audio


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe a LectureAI recording locally with timestamped multilingual segments.")
    parser.add_argument("audio", type=Path, help="Original audio file; it is never modified")
    parser.add_argument("--model", choices=MODEL_INFO.keys(), default="large-v3")
    parser.add_argument("--output", type=Path, help="Output JSON path")
    parser.add_argument("--glossary", action="append", default=[], help="Course term; repeat as needed")
    parser.add_argument("--context", type=Path, action="append", default=[], help="Local PDF/TXT/MD terminology source")
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
    result = transcribe_audio(audio, args.model, models_dir, glossary)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Transcript written to: {output}")
    print("Import this JSON from the LectureAI lecture page. Notes will generate automatically.")


if __name__ == "__main__":
    main()
