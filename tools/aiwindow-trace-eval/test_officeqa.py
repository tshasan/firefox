# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import csv
import hashlib
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import officeqa
from run import collect_eval_artifacts, harness_command
from server import EvaluationServer


class OfficeQAImporterTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="officeqa-importer-unit-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.row = {
            "uid": "synthetic-unit-test",
            "question": "Temporary importer test question?",
            "answer": "PRIVATE_UNIT_TEST_GOLD",
            "source_docs": "Synthetic parser fixture, not an OfficeQA example",
            "source_files": "unit.txt",
            "difficulty": "easy",
        }
        self.csv = self.root / "unit.csv"
        with self.csv.open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=self.row)
            writer.writeheader()
            writer.writerow(self.row)
        scorer = patch.object(officeqa, "install_scorer", return_value={})
        scorer.start()
        self.addCleanup(scorer.stop)

    def manifest(self, representation, content):
        source = self.root / "source"
        source.write_bytes(content)
        output = self.root / representation
        manifest = officeqa.build_manifest(
            [self.row], self.csv, {"unit.txt": source}, output, "full", representation
        )
        tab = manifest["scenarios"][0]["tabs"][0]
        return manifest, tab, output / tab["fixture"]

    def test_source_files_rejects_paths(self):
        for entry in (
            "../unit.txt",
            "/unit.txt",
            "folder/unit.txt",
            "folder\\unit.txt",
        ):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                officeqa.source_files(entry)
        self.assertEqual(
            officeqa.source_files("unit.txt;second.txt;unit.txt"),
            ["unit.txt", "second.txt"],
        )

    def test_pdf_bytes_hashes_and_private_gold(self):
        content = b"%PDF-1.7\n% Synthetic importer fixture only\n"
        manifest, tab, document = self.manifest("pdf", content)
        self.assertEqual(document.read_bytes(), content)
        digest = hashlib.sha256(content).hexdigest()
        self.assertEqual(tab["source"]["sha256"], digest)
        self.assertEqual(tab["source"]["fixtureSha256"], digest)
        self.assertEqual(tab["mediaType"], "application/pdf")
        scenario = manifest["scenarios"][0]
        self.assertEqual(scenario["prompt"], self.row["question"])
        self.assertEqual(scenario["reference"], self.row["answer"])
        self.assertNotIn(self.row["answer"].encode(), document.read_bytes())
        self.assertEqual(manifest["metadata"]["sourceRepresentation"], "pdf")
        self.assertEqual(
            manifest["metadata"]["retrievalMode"], "oracle-source-documents"
        )

    def test_default_import_runs_local_sources_through_mach_eval(self):
        manifest, _, document = self.manifest("pdf", b"%PDF-1.7\n")
        self.assertEqual(manifest["metadata"]["driver"], "mochitest")
        self.assertTrue(manifest["metadata"]["offline"])
        self.assertEqual(
            manifest["metadata"]["allowedTools"], ["get_open_tabs", "get_page_content"]
        )
        server = object.__new__(EvaluationServer)
        server.base_dir = document.parent.parent
        server.fixture_files = {}
        runtime = server.runtime_case(manifest["scenarios"][0])
        self.assertEqual(list(server.fixture_files.values()), [document.resolve()])
        self.assertTrue(
            runtime["tabs"][0]["url"].startswith("http://127.0.0.1:4318/fixtures/")
        )
        self.assertNotIn(self.row["answer"], str(runtime))
        command = harness_command(True)
        self.assertIn("eval", command)
        self.assertIn("--headless", command)

    def test_eval_artifacts_exclude_stale_scores(self):
        source = self.root / "eval-output"
        source.mkdir()
        for name in (
            "browser_eval_trace-eval-data.json",
            "eval-accuracy.json",
            "eval-groundedness.json",
            "perfherder-data-current.json",
        ):
            (source / name).write_text("[]")
        os.utime(source / "eval-groundedness.json", (0, 0))
        target = self.root / "run"
        target.mkdir()
        (target / "browser.log").write_text(
            f"Evaluation data written to {source}/browser_eval_trace-eval-data.json\n"
        )
        with patch("run.EVAL_OUTPUT", self.root / "wrong-output"):
            collect_eval_artifacts(
                {"metrics": {"accuracy": {}, "groundedness": {}}},
                target,
                time.time() - 1,
            )
        self.assertEqual(
            sorted(path.name for path in (target / "eval").iterdir()),
            [
                "browser_eval_trace-eval-data.json",
                "eval-accuracy.json",
                "perfherder-data-current.json",
            ],
        )

    def test_parsed_text_escapes_html_and_records_representation(self):
        content = b'<script>alert("unit")</script>\nEvidence & value 42'
        manifest, tab, document = self.manifest("parsed-text", content)
        rendered = document.read_text(encoding="utf-8")
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("Evidence &amp; value 42", rendered)
        self.assertNotIn(self.row["answer"], rendered)
        self.assertEqual(tab["source"]["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(tab["mediaType"], "text/html")
        self.assertEqual(manifest["metadata"]["sourceRepresentation"], "parsed-text")
        self.assertEqual(
            manifest["metadata"]["retrievalMode"], "oracle-source-documents"
        )

    def test_pdf_mode_never_falls_back_to_text(self):
        with self.assertRaisesRegex(ValueError, "not a PDF"):
            self.manifest("pdf", b"Plain text is not a native PDF")
        with self.assertRaisesRegex(ValueError, "does not publish transformed text"):
            officeqa.corpus_filename("unit.txt", "pro-v2", "parsed-text")

    def test_csv_preserves_question_and_answer_and_rejects_duplicate_ids(self):
        self.assertEqual(officeqa.read_rows(self.csv), [self.row])
        with self.csv.open("a", newline="", encoding="utf-8") as target:
            csv.DictWriter(target, fieldnames=self.row).writerow(self.row)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            officeqa.read_rows(self.csv)


if __name__ == "__main__":
    unittest.main()
