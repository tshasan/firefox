# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import graders
import pytest
import scoring

import config

FAKE_REWARD = """
def score_answer(ground_truth, predicted, tolerance=0.0):
    return int(ground_truth.strip() == predicted.strip())
"""


def record(**changes):
    base = {
        "turnIndex": 0,
        "answer": "42",
        "reference": "42",
        "toolCalls": [],
        "tabs": [{"index": 0, "url": "http://x/doc"}],
        "extractions": [],
        "traceIncomplete": False,
    }
    base.update(changes)
    return base


def call(name="get_page_content", executed=True):
    return {
        "name": name,
        "arguments": {},
        "executed": executed,
        "rejected": not executed,
    }


def build_officeqa(tmp_path, monkeypatch, revision=None):
    scorer_dir = tmp_path / "scorer"
    scorer_dir.mkdir()
    reward = scorer_dir / "reward.py"
    reward.write_text(FAKE_REWARD)
    sha = hashlib.sha256(reward.read_bytes()).hexdigest()
    monkeypatch.setattr(scoring, "OFFICEQA_SCORER_SHA256", sha)
    scorer = {
        "path": "scorer/reward.py",
        "sha256": sha,
        "revision": revision or scoring.OFFICEQA_REVISION,
    }
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps({
            "metadata": {"name": "oqa", "scorer": scorer},
            "scenarios": [{"id": "a"}],
        })
    )
    snapshot = SimpleNamespace(scorer=scorer, manifest_path=manifest)
    return graders.build(SimpleNamespace(grader="officeqa"), snapshot)


CASE = {"id": "a", "requiredSources": [0]}


def by_name(scores):
    return {score["name"]: score for score in scores}


def test_officeqa_correct_with_coverage(tmp_path, monkeypatch):
    grader = build_officeqa(tmp_path, monkeypatch)
    rec = record(
        toolCalls=[call()],
        extractions=[{"url": "http://x/doc", "success": True, "textLength": 10}],
    )
    scores = by_name(grader.score(rec, CASE))
    assert scores["officeqa_accuracy"]["status"] == "scored"
    assert scores["officeqa_accuracy"]["value"] == 1
    assert scores["officeqa_accuracy"]["label"] == "correct"
    assert scores["extraction_coverage"]["value"] == 1


def test_officeqa_wrong_answer_and_no_read(tmp_path, monkeypatch):
    grader = build_officeqa(tmp_path, monkeypatch)
    scores = by_name(grader.score(record(answer="7"), CASE))
    assert scores["officeqa_accuracy"]["value"] == 0
    assert scores["extraction_coverage"]["value"] == 0
    assert scores["extraction_coverage"]["status"] == "scored"


def test_officeqa_missing_answer_unavailable(tmp_path, monkeypatch):
    grader = build_officeqa(tmp_path, monkeypatch)
    scores = by_name(grader.score(record(answer="  "), CASE))
    assert scores["officeqa_accuracy"]["status"] == "unavailable"
    assert "value" not in scores["officeqa_accuracy"]


def test_officeqa_truncated_trace(tmp_path, monkeypatch):
    grader = build_officeqa(tmp_path, monkeypatch)
    scores = by_name(grader.score(record(traceIncomplete=True), CASE))
    assert scores["extraction_coverage"]["status"] == "error"
    assert scores["officeqa_accuracy"]["status"] == "scored"


def test_officeqa_rejects_wrong_revision(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="revision"):
        build_officeqa(tmp_path, monkeypatch, revision="deadbeef")


def test_officeqa_rejects_tampered_scorer(tmp_path, monkeypatch):
    build_officeqa(tmp_path, monkeypatch)
    (tmp_path / "scorer" / "reward.py").write_text(FAKE_REWARD + "\n# changed\n")
    with pytest.raises(ValueError, match="SHA256"):
        graders.build(
            SimpleNamespace(grader="officeqa"),
            SimpleNamespace(
                scorer=json.loads((tmp_path / "manifest.json").read_text())["metadata"][
                    "scorer"
                ],
                manifest_path=tmp_path / "manifest.json",
            ),
        )


def test_officeqa_requires_scorer():
    with pytest.raises(ValueError, match="scorer"):
        graders.build(
            SimpleNamespace(grader="officeqa"),
            SimpleNamespace(scorer=None, manifest_path="m.json"),
        )


def test_score_never_raises(tmp_path, monkeypatch):
    grader = build_officeqa(tmp_path, monkeypatch)
    scores = grader.score({}, CASE)
    assert {score["status"] for score in scores} == {"error"}
    assert graders.ExpectedToolGrader().score({}, {})[0]["status"] == "error"


EXPECTED = {"id": "a", "expectedTool": {"name": "get_page_content", "count": 1}}


def expected_tool(rec, case=EXPECTED):
    return graders.build(
        SimpleNamespace(grader="expected_tool"), SimpleNamespace()
    ).score(rec, case)[0]


def test_expected_tool_pass_and_fail():
    ok = expected_tool(record(toolCalls=[call(), call(executed=False)]))
    assert (
        ok["status"] == "scored"
        and ok["value"] == 1
        and ok["name"] == "expected_tool_once"
    )
    twice = expected_tool(record(toolCalls=[call(), call()]))
    assert twice["value"] == 0 and twice["label"] == "fail"
    assert expected_tool(record(toolCalls=[call("get_open_tabs")]))["value"] == 0


def test_expected_tool_truncated_trace_errors():
    score = expected_tool(record(toolCalls=[call()], traceIncomplete=True))
    assert score["status"] == "error"
    assert "value" not in score


def test_build_from_shipped_example():
    path = Path(__file__).parent / "evals" / "example.yaml"
    cfg = config.load(path)
    grader = graders.build(cfg, config.load_dataset(cfg))
    assert isinstance(grader, graders.ExpectedToolGrader)
