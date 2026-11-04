# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import copy
import json
import tempfile
import unittest
from pathlib import Path

import mozunit
from salience_report import MARKER, read_records, render, score


def record(corpus, budgets, case_id="page", case_count=1):
    return {
        "corpus": corpus,
        "caseCount": case_count,
        "sufficientLengths": budgets,
        "firefox": {"version": "test"},
        "reference": {
            "id": case_id,
            "type": "article",
            "difficulty": "unrated",
            "source": "https://example.com/",
            "license": "test",
            "expected": "Battery lasts eighteen hours. Waterproof.",
            "qa": [
                {"question": "Battery life?", "evidence": ["eighteen hours"]},
                {"question": "Waterproof?", "evidence": ["Waterproof"]},
            ],
            "required": ["eighteen hours", "Waterproof"],
            "unwanted": ["Subscribe"],
        },
        "outputs": [
            {
                "mode": mode,
                "sufficientLength": budget,
                "text": "Battery lasts eighteen hours. Subscribe <script>bad()</script>",
                "times": [3, 1, 2],
            }
            for mode in ("dom", "reader", "salience")
            for budget in budgets
        ],
    }


class SalienceReportTests(unittest.TestCase):
    def read(self, records):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.jsonl"
            path.write_text(
                "\n".join(
                    json.dumps({"message": MARKER + json.dumps(r)}) for r in records
                ),
                encoding="utf-8",
            )
            return read_records(path)

    def test_separate_corpora_and_different_budgets(self):
        records = self.read([
            record("authored", [None, 1000]),
            record("real", [None, 1000, 10000]),
        ])
        self.assertEqual(len(score(records)), 15)
        report = render(records, score(records))
        self.assertIn("2 pages across 2 corpora", report)
        self.assertIn("&lt;script&gt;bad()&lt;/script&gt;", report)
        self.assertNotIn("<script>bad()</script>", report)

    def test_incomplete_corpus_cannot_hide_behind_another_corpus(self):
        with self.assertRaisesRegex(ValueError, "Incomplete benchmark"):
            self.read([
                record("authored", [None, 1000]),
                record("real", [None, 1000, 10000], case_count=2),
            ])

    def test_duplicate_and_missing_variants_rejected(self):
        original = record("real", [None, 1000, 10000])
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate):
                page = copy.deepcopy(original)
                page["outputs"].pop()
                if duplicate:
                    page["outputs"].append(page["outputs"][0])
                with self.assertRaisesRegex(ValueError, "variants"):
                    self.read([page])

    def test_duplicate_case_rejected(self):
        page = record("real", [None, 1000])
        with self.assertRaisesRegex(ValueError, "Duplicate case"):
            self.read([page, page])

    def test_failed_browser_run_rejected_even_with_complete_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.jsonl"
            path.write_text(
                json.dumps({"message": MARKER + json.dumps(record("real", [None]))})
                + "\n"
                + json.dumps({
                    "action": "test_end",
                    "test": "browser_salience_real_benchmark.js",
                    "status": "FAIL",
                }),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "Benchmark test failed"):
                read_records(path)

    def test_partial_evidence_and_boilerplate_are_reported(self):
        row = score([record("real", [1000])])[0]
        self.assertEqual(row["evidence_recall"], 0.5)
        self.assertEqual(row["missing_questions"], ["Waterproof?"])
        self.assertEqual(row["required_recall"], 0.5)
        self.assertEqual(row["missing_required"], ["Waterproof"])
        self.assertEqual(row["unwanted_hits"], ["Subscribe"])
        self.assertEqual(row["median_ms"], 2)


if __name__ == "__main__":
    mozunit.main()
