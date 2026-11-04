#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import argparse
import hashlib
import json
import shutil
from pathlib import Path

from salience_report import normalize


def main():
    tests = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Import the local WCXB salience cases")
    parser.add_argument("dataset", type=Path)
    parser.add_argument(
        "--cases", type=Path, default=tests / "salience_real_cases.json"
    )
    parser.add_argument("--output", type=Path, default=tests / "browser/salience_real")
    args = parser.parse_args()
    questions = json.loads(args.cases.read_text(encoding="utf-8"))
    metadata = json.loads((args.dataset / "metadata.json").read_text(encoding="utf-8"))
    cases = []
    for case_id, selection in questions.items():
        qa = selection if isinstance(selection, list) else selection["qa"]
        label_path = args.dataset / "dev/ground-truth" / f"{case_id}.json"
        label_bytes = label_path.read_bytes()
        label = json.loads(label_bytes)
        reference = label["ground_truth"]
        expected = reference["main_content"]
        for question in qa:
            if not question["evidence"] or not all(
                normalize(part) in normalize(expected) for part in question["evidence"]
            ):
                raise ValueError(
                    f"{case_id}: evidence absent from reference: {question}"
                )
        kind = label["_internal"]["page_type"]
        kind = kind["primary"] if isinstance(kind, dict) else kind
        snapshot = args.dataset / "dev/html" / f"{case_id}.html.gz"
        cases.append({
            "id": f"wcxb-{case_id}",
            "type": "collection" if kind == "category" else kind,
            "difficulty": "unrated",
            "title": reference.get("title") or case_id,
            "notes": selection.get("notes", "") if isinstance(selection, dict) else "",
            "htmlFile": snapshot.name,
            "sha256": hashlib.sha256(snapshot.read_bytes()).hexdigest(),
            "annotationSha256": hashlib.sha256(label_bytes).hexdigest(),
            "sourceUrl": label["url"],
            "source": label["url"],
            "license": "Original publisher rights; WCXB annotations CC-BY-4.0",
            "capturedAt": label.get("downloaded_at")
            or metadata["files"][case_id].get("downloaded_at"),
            "expected": expected,
            "qa": qa,
            "required": reference.get("with", []),
            "unwanted": reference.get("without", []),
        })
    args.output.mkdir(parents=True, exist_ok=True)
    for case in cases:
        shutil.copyfile(
            args.dataset / "dev/html" / case["htmlFile"], args.output / case["htmlFile"]
        )
    shutil.copyfile(args.dataset / "LICENSE", args.output / "WCXB-LICENSE")
    corpus = {
        "version": 2,
        "id": "wcxb-static-dev",
        "dataset": "WCXB development split, Murrough Foley",
        "datasetUrl": "https://github.com/Murrough-Foley/web-content-extraction-benchmark",
        "sourceSnapshot": args.dataset.name,
        "condition": "Saved HTML with inline CSS; scripts, external resources and frames disabled. Not a captured rendered layout.",
        "assertEvidence": False,
        "sufficientLengths": [None, 1000, 10000],
        "cases": cases,
    }
    (args.output / "corpus.json").write_text(
        json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Imported {len(cases)} real pages into {args.output}")


if __name__ == "__main__":
    main()
