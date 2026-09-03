from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ARABIC_DIACRITICS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")
ARABIC_NORMALIZATION = str.maketrans({
    "أ": "ا",
    "إ": "ا",
    "آ": "ا",
    "ٱ": "ا",
    "ى": "ي",
    "ؤ": "و",
    "ئ": "ي",
})
DIGIT_NORMALIZATION = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
PLACEHOLDER_PATTERNS = (
    "replace this with the model transcript",
    "todo",
    "placeholder",
)


@dataclass
class Score:
    wer: float
    cer: float
    arabic_wer: float
    arabic_cer: float
    technical_hits: int
    technical_total: int
    number_hits: int
    number_total: int
    manual_review_seconds: float | None
    hallucination_count: int | None


def normalize_text(text: str, *, arabic_friendly: bool = False) -> str:
    value = str(text).casefold().replace("ـ", "").translate(DIGIT_NORMALIZATION)
    if arabic_friendly:
        value = ARABIC_DIACRITICS.sub("", value).translate(ARABIC_NORMALIZATION)
    value = re.sub(r"[^\w\u0600-\u06ff+#.]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def tokens(text: str, *, arabic_friendly: bool = False) -> list[str]:
    normalized = normalize_text(text, arabic_friendly=arabic_friendly)
    return normalized.split() if normalized else []


def characters(text: str, *, arabic_friendly: bool = False) -> list[str]:
    return list("".join(tokens(text, arabic_friendly=arabic_friendly)))


def levenshtein(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row, reference_item in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_item in enumerate(hypothesis, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (reference_item != hypothesis_item),
            ))
        previous = current
    return previous[-1]


def error_rate(reference: str, hypothesis: str, *, character_level: bool = False, arabic_friendly: bool = False) -> float:
    ref = characters(reference, arabic_friendly=arabic_friendly) if character_level else tokens(reference, arabic_friendly=arabic_friendly)
    hyp = characters(hypothesis, arabic_friendly=arabic_friendly) if character_level else tokens(hypothesis, arabic_friendly=arabic_friendly)
    return levenshtein(ref, hyp) / max(1, len(ref))


def phrase_present(phrase: str, text: str) -> bool:
    needle = normalize_text(phrase, arabic_friendly=True)
    haystack = normalize_text(text, arabic_friendly=True)
    if not needle:
        return False
    return f" {needle} " in f" {haystack} "


def normalized_numbers(text: str) -> list[str]:
    value = str(text).translate(DIGIT_NORMALIZATION)
    return re.findall(r"(?<!\w)[+-]?(?:\d+(?:[.,]\d+)?)(?!\w)", value)


def multiset_hits(expected: Iterable[str], actual: Iterable[str]) -> tuple[int, int]:
    remaining = list(actual)
    hits = 0
    total = 0
    for item in expected:
        total += 1
        try:
            index = remaining.index(item)
        except ValueError:
            continue
        hits += 1
        remaining.pop(index)
    return hits, total


def optional_float(record: dict, key: str) -> float | None:
    value = record.get(key)
    if value is None or value == "":
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a non-negative number when provided")


def optional_int(record: dict, key: str) -> int | None:
    value = record.get(key)
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a non-negative integer when provided")
    if parsed < 0:
        raise ValueError(f"{key} must be a non-negative integer when provided")
    return parsed


def validate_record(record: dict, index: int) -> None:
    for field in ("reference", "hypothesis"):
        if not isinstance(record.get(field), str) or not record[field].strip():
            raise ValueError(f"Record {index}: {field} must be non-empty text")
    hypothesis = record["hypothesis"].casefold()
    if any(marker in hypothesis for marker in PLACEHOLDER_PATTERNS):
        raise ValueError(f"Record {index}: hypothesis still looks like placeholder text; insert real model output before scoring")
    terms = record.get("technical_terms", [])
    if terms is not None and not isinstance(terms, list):
        raise ValueError(f"Record {index}: technical_terms must be a JSON array")


def score_record(record: dict) -> Score:
    reference = record["reference"]
    hypothesis = record["hypothesis"]
    technical_terms = [str(term).strip() for term in (record.get("technical_terms") or []) if str(term).strip()]
    technical_hits = sum(1 for term in technical_terms if phrase_present(term, hypothesis))
    reference_numbers = normalized_numbers(reference)
    hypothesis_numbers = normalized_numbers(hypothesis)
    number_hits, number_total = multiset_hits(reference_numbers, hypothesis_numbers)

    return Score(
        wer=error_rate(reference, hypothesis),
        cer=error_rate(reference, hypothesis, character_level=True),
        arabic_wer=error_rate(reference, hypothesis, arabic_friendly=True),
        arabic_cer=error_rate(reference, hypothesis, character_level=True, arabic_friendly=True),
        technical_hits=technical_hits,
        technical_total=len(technical_terms),
        number_hits=number_hits,
        number_total=number_total,
        manual_review_seconds=optional_float(record, "manual_review_seconds"),
        hallucination_count=optional_int(record, "hallucination_count"),
    )


def ratio(hits: int, total: int) -> str:
    return "-" if not total else f"{hits / total:.3f}"


def mean_optional(values: list[float | int | None]) -> str:
    present = [float(value) for value in values if value is not None]
    return "-" if not present else f"{sum(present) / len(present):.1f}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Measure LectureAI strict and Arabic-normalized WER/CER plus classroom review metrics."
    )
    parser.add_argument("manifest", type=Path, help="Private JSON list of human references and real model hypotheses")
    args = parser.parse_args()

    records = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not records:
        raise SystemExit("Benchmark manifest must be a non-empty JSON array.")

    groups: dict[tuple[str, str, str], list[Score]] = defaultdict(list)
    for index, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            raise SystemExit(f"Record {index} must be a JSON object.")
        validate_record(record, index)
        score = score_record(record)
        groups[(
            str(record.get("model", "unknown")),
            str(record.get("language", "unknown")),
            str(record.get("condition", "unknown")),
        )].append(score)

    columns = [
        "model", "language", "condition", "clips",
        "WER", "CER", "ArabicNormWER", "ArabicNormCER",
        "TechTermRecall", "NumberRecall", "AvgReviewSec", "AvgHallucinations",
    ]
    print("\t".join(columns))
    for (model, language, condition), scores in sorted(groups.items()):
        technical_hits = sum(score.technical_hits for score in scores)
        technical_total = sum(score.technical_total for score in scores)
        number_hits = sum(score.number_hits for score in scores)
        number_total = sum(score.number_total for score in scores)
        values = [
            model,
            language,
            condition,
            str(len(scores)),
            f"{sum(score.wer for score in scores) / len(scores):.3f}",
            f"{sum(score.cer for score in scores) / len(scores):.3f}",
            f"{sum(score.arabic_wer for score in scores) / len(scores):.3f}",
            f"{sum(score.arabic_cer for score in scores) / len(scores):.3f}",
            ratio(technical_hits, technical_total),
            ratio(number_hits, number_total),
            mean_optional([score.manual_review_seconds for score in scores]),
            mean_optional([score.hallucination_count for score in scores]),
        ]
        print("\t".join(values))


if __name__ == "__main__":
    main()
