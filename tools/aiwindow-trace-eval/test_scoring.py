# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from scoring import (
    OFFICEQA_SCORER_SHA256,
    OfficeQAScorer,
    extraction_coverage,
    metric_summary,
)
from server import EvaluationServer


class ScoringTests(unittest.TestCase):
    def test_trace_from_another_run_is_rejected_before_ingestion(self):
        server = object.__new__(EvaluationServer)
        server.run_id = "current-run"
        with self.assertRaisesRegex(ValueError, "another evaluation run"):
            server.ingest({
                "resourceSpans": [
                    {
                        "scopeSpans": [
                            {
                                "spans": [
                                    {
                                        "attributes": [
                                            {
                                                "key": "smartwindow.run_id",
                                                "value": {
                                                    "stringValue": "previous-run"
                                                },
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ],
            })

    def test_untrusted_scorer_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reward.py"
            path.write_text("raise RuntimeError('must not execute')\n")
            with self.assertRaisesRegex(ValueError, "SHA256"):
                OfficeQAScorer(path, hashlib.sha256(path.read_bytes()).hexdigest())

    def test_official_scoring(self):
        path = Path(
            os.environ.get(
                "OFFICEQA_SCORER",
                "artifacts/aiwindow-trace-eval/officeqa/scorer/reward.py",
            )
        )
        if not path.exists():
            self.skipTest("Download the pinned official scorer with officeqa.py first")
        exact = OfficeQAScorer(path, OFFICEQA_SCORER_SHA256)
        tolerant = OfficeQAScorer(path, OFFICEQA_SCORER_SHA256, 0.01)
        self.assertEqual(exact.score("123.45", "123.45")["score"], 1)
        self.assertEqual(exact.score("123.45", "123.46")["score"], 0)
        self.assertEqual(tolerant.score("123.45", "123.46")["score"], 1)
        self.assertEqual(exact.score("123.45", "123.45 or 200")["score"], 0)
        self.assertEqual(exact.score("12 million", "12 billion")["score"], 0)
        self.assertEqual(exact.score("0", "")["score"], 0)
        self.assertEqual(
            exact.score(
                "mochi",
                "Because of a Japanese treat. <FINAL_ANSWER>mochi</FINAL_ANSWER>",
            )["score"],
            1,
        )

    def test_runtime_excludes_answer_key(self):
        server = object.__new__(EvaluationServer)
        server.mode = "replay"
        server.fixture_files = {}
        server.dataset_path = Path("unused.json")
        result = server.runtime_case({
            "id": "actual-uid",
            "prompt": "Question",
            "reference": "secret-answer",
            "officeqa": {"answer": "secret-answer"},
            "requiredSources": [0],
            "checks": [{"answer": "secret-answer"}],
            "tabs": [
                {"title": "Source", "body": "Document", "answer": "secret-answer"}
            ],
            "turns": [{"prompt": "Followup", "reference": "secret-answer"}],
        })
        self.assertNotIn("secret-answer", json.dumps(result))
        self.assertEqual(result["turns"], [{"prompt": "Followup"}])

    def test_extraction_requires_execution_and_actual_source_read(self):
        result = {
            "tabs": [{"index": 0, "url": "http://127.0.0.1/doc.pdf"}],
            "extractions": [
                {
                    "url": "http://127.0.0.1/doc.pdf#page=2",
                    "success": True,
                    "textLength": 50,
                }
            ],
        }
        self.assertEqual(extraction_coverage(result, [0], True)["score"], 1)
        self.assertEqual(extraction_coverage(result, [0], False)["score"], 0)
        result["extractions"][0]["textLength"] = 0
        self.assertEqual(extraction_coverage(result, [0], True)["score"], 0)

    def test_summary_exposes_missing_and_unavailable_scores(self):
        summary = metric_summary(
            [
                {
                    "scores": [{"name": "accuracy", "score": 1}],
                    "unavailableScores": [
                        {"name": "groundedness", "reason": "No evidence"}
                    ],
                },
                {
                    "scores": [
                        {"name": "accuracy", "score": 0},
                        {"name": "groundedness", "error": "Judge unavailable"},
                    ]
                },
            ],
            3,
        )
        self.assertEqual(summary["accuracy"]["mean"], 0.5)
        self.assertEqual(summary["accuracy"]["scored"], 2)
        self.assertEqual(summary["accuracy"]["total"], 3)
        self.assertIsNone(summary["groundedness"]["mean"])
        self.assertEqual(summary["groundedness"]["errors"], 1)
        self.assertEqual(summary["groundedness"]["unavailable"], 1)


if __name__ == "__main__":
    unittest.main()
