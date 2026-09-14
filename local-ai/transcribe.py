from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from engine import MODEL_INFO, read_context_files, transcribe_audio


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe a LectureAI recording locally with timestamped multilingual segments.")
    parser.add_argument("audio", type=Path, help="Original audio file; it is never modified")
    parser.add_argument("--model", choices=MODEL_INFO.keys(), default="large-v3")
    parser.add_argument("--output", type=Path, help="Output JSON path")
    parser.add_argument("--glossary", action="append", default=[], help="Course term; repeat as needed")
    parser.add_argument("--context", type=Path, action="append", default=[], help="Local PDF/TXT/MD terminology source")
    parser.add_argument(
        "--enhance",
        choices=("off", "balanced", "strong", "automatic", "original", "enhanced"),
        default="balanced",
        help="Derived transcription audio cleanup: off, balanced (recommended), or strong. Legacy names remain accepted for retained scripts.",
    )
    parser.add_argument("--checkpoint", type=Path, help="Optional resumable checkpoint JSON path")
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
    if output == audio:
        raise SystemExit("Output must be a separate JSON file; the original audio cannot be overwritten.")
    checkpoint_path = args.checkpoint.resolve() if args.checkpoint else output.with_suffix(".checkpoint.json")
    checkpoint = None
    if checkpoint_path.is_file():
        try:
            candidate = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            checkpoint = candidate if isinstance(candidate, dict) else None
        except json.JSONDecodeError as error:
            raise SystemExit(f"Checkpoint is not valid JSON: {checkpoint_path}") from error

    def save_checkpoint(payload: dict) -> None:
        temporary = checkpoint_path.with_suffix(checkpoint_path.suffix + ".partial")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, checkpoint_path)
        completed = float(payload.get("completed_audio_seconds") or 0)
        total = float(payload.get("total_audio_seconds") or 0)
        print(f"Checkpoint saved: {completed:.1f} / {total:.1f} seconds")

    def report(_value: int, message: str) -> None:
        print(message)

    result = transcribe_audio(
        audio,
        args.model,
        models_dir,
        glossary,
        report,
        checkpoint=checkpoint,
        checkpoint_callback=save_checkpoint,
        enhancement=args.enhance,
    )
    temporary_output = output.with_suffix(output.suffix + ".partial")
    temporary_output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary_output, output)
    checkpoint_path.unlink(missing_ok=True)
    print(f"Transcript written to: {output}")
    print(f"Audio duration: {result.get('duration', 0)} seconds")
    print(f"Processing duration: {result.get('processing_seconds', 0)} seconds")
    print(f"Real-time factor (RTF): {result.get('real_time_factor', 0)}")
    print("The original audio was read only. All preprocessing used disposable derived WAV sections.")
    print("Import this JSON from the LectureAI lecture page. Notes will generate automatically.")


if __name__ == "__main__":
    main()
