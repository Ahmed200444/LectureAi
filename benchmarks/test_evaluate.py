from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import evaluate  # noqa: E402


class AccuracyEvaluatorTests(unittest.TestCase):
    def test_exact_transcript_has_zero_error(self) -> None:
        reference = "The pointer يعني بيشاور على memory address 42."
        self.assertEqual(evaluate.error_rate(reference, reference), 0.0)
        self.assertEqual(evaluate.error_rate(reference, reference, character_level=True), 0.0)

    def test_arabic_friendly_normalization_handles_common_orthography_and_digits(self) -> None:
        reference = "إلى مدرسة ١٢"
        hypothesis = "الي مدرسة 12"
        self.assertGreater(evaluate.error_rate(reference, hypothesis), 0.0)
        self.assertEqual(evaluate.error_rate(reference, hypothesis, arabic_friendly=True), 0.0)
        self.assertEqual(evaluate.error_rate(reference, hypothesis, character_level=True, arabic_friendly=True), 0.0)

    def test_technical_term_and_number_recall_are_independent_of_global_wer(self) -> None:
        score = evaluate.score_record({
            "reference": "Use pointer arithmetic at address 128 and then call Dijkstra.",
            "hypothesis": "Use pointer arithmetic at address 128 and then call something else.",
            "technical_terms": ["pointer arithmetic", "Dijkstra"],
        })
        self.assertEqual(score.technical_hits, 1)
        self.assertEqual(score.technical_total, 2)
        self.assertEqual(score.number_hits, 1)
        self.assertEqual(score.number_total, 1)
        self.assertGreater(score.wer, 0.0)

    def test_code_switched_technical_phrase_matching_is_case_and_spacing_normalized(self) -> None:
        self.assertTrue(evaluate.phrase_present("Memory Address", "احنا بنستخدم  memory   address هنا"))

    def test_placeholder_hypothesis_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "placeholder"):
            evaluate.validate_record({
                "reference": "Real human reference",
                "hypothesis": "Replace this with the model transcript.",
            }, 1)

    def test_manual_review_and_hallucination_metrics_validate_non_negative_values(self) -> None:
        score = evaluate.score_record({
            "reference": "The derivative is the rate of change.",
            "hypothesis": "The derivative is the rate of change.",
            "manual_review_seconds": 12.5,
            "hallucination_count": 0,
        })
        self.assertEqual(score.manual_review_seconds, 12.5)
        self.assertEqual(score.hallucination_count, 0)
        with self.assertRaises(ValueError):
            evaluate.score_record({
                "reference": "x",
                "hypothesis": "x",
                "hallucination_count": -1,
            })


if __name__ == "__main__":
    unittest.main()
