from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


def normalize(text: str) -> list[str]:
    text = text.casefold().replace("ـ", "")
    text = re.sub(r"[^\w\u0600-\u06ff+#.]+", " ", text)
    return text.split()


def levenshtein(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row, reference_item in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_item in enumerate(hypothesis, start=1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (reference_item != hypothesis_item)))
        previous = current
    return previous[-1]


def metric(reference: str, hypothesis: str, characters: bool = False) -> float:
    ref = list("".join(normalize(reference))) if characters else normalize(reference)
    hyp = list("".join(normalize(hypothesis))) if characters else normalize(hypothesis)
    return levenshtein(ref, hyp) / max(1, len(ref))


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure LectureAI WER/CER from a benchmark manifest.")
    parser.add_argument("manifest", type=Path, help="JSON list with reference, hypothesis, language, condition, model")
    args = parser.parse_args()
    records = json.loads(args.manifest.read_text(encoding="utf-8"))
    groups: dict[tuple[str, str, str], list[tuple[float, float]]] = defaultdict(list)
    for record in records:
        wer = metric(record["reference"], record["hypothesis"])
        cer = metric(record["reference"], record["hypothesis"], characters=True)
        groups[(record.get("model", "unknown"), record.get("language", "unknown"), record.get("condition", "unknown"))].append((wer, cer))
    print("model\tlanguage\tcondition\tclips\tWER\tCER")
    for (model, language, condition), scores in sorted(groups.items()):
        print(f"{model}\t{language}\t{condition}\t{len(scores)}\t{sum(score[0] for score in scores)/len(scores):.3f}\t{sum(score[1] for score in scores)/len(scores):.3f}")


if __name__ == "__main__":
    main()
