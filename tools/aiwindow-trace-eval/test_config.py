# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import hashlib
import json
from pathlib import Path

import pytest
import yaml

import config

EVALS = Path(__file__).parent / "evals"

BASE = {
    "schemaVersion": 1,
    "name": "suite",
    "dataset": {"manifest": "manifest.json"},
    "model": {"kind": "custom", "endpoint": "http://127.0.0.1:8080/v1"},
    "grader": "expected_tool",
}


def manifest(tmp_path, count=4, turns=False):
    scenarios = []
    for index in range(count):
        case = {"id": f"case-{index}", "prompt": "q", "tabs": [], "reference": "r"}
        if turns and index == 0:
            case["turns"] = [{"prompt": "a"}, {"prompt": "b"}]
        scenarios.append(case)
    (tmp_path / "manifest.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "metadata": {"name": "ds"},
            "scenarios": scenarios,
        })
    )


def write(tmp_path, **changes):
    data = json.loads(json.dumps(BASE))
    for key, value in changes.items():
        if value is None:
            data.pop(key, None)
        elif isinstance(value, dict) and isinstance(data.get(key), dict):
            data[key].update(value)
        else:
            data[key] = value
    path = tmp_path / "run.yaml"
    path.write_text(yaml.safe_dump(data))
    manifest(tmp_path)
    return path


def test_load_defaults_and_resolved(tmp_path):
    cfg = config.load(write(tmp_path))
    assert cfg.manifest == (tmp_path / "manifest.json").resolve()
    assert cfg.langfuse == "auto"
    resolved = cfg.resolved()
    json.dumps(resolved)
    assert resolved["dataset"]["manifest"] == str(cfg.manifest)
    assert resolved["limits"]["modelCallsPerCase"] == 8


def test_api_key_env_name_only(tmp_path, monkeypatch):
    monkeypatch.setenv("MY_KEY", "sekret-value")
    cfg = config.load(write(tmp_path, model={"apiKeyEnv": "MY_KEY"}))
    assert "sekret-value" not in json.dumps(cfg.resolved())
    assert cfg.resolved()["model"]["apiKeyEnv"] == "MY_KEY"


@pytest.mark.parametrize(
    "changes, field",
    [
        ({"schemaVersion": 2}, "schemaVersion"),
        ({"model": {"kind": "other"}}, "model.kind"),
        ({"model": {"kind": "firefox"}}, "model.choice"),
        ({"model": {"endpoint": "ftp://x"}}, "model.endpoint"),
        ({"model": {"endpoint": ""}}, "model.endpoint"),
        ({"limits": {"repetitions": 0}}, "limits.repetitions"),
        ({"limits": {"cases": -1}}, "limits.cases"),
        ({"limits": {"totalTokens": "many"}}, "limits.totalTokens"),
        ({"grader": "judge"}, "grader"),
        ({"publish": {"langfuse": "sometimes"}}, "publish.langfuse"),
        ({"dataset": {"manifest": "missing.json"}}, "dataset.manifest"),
        ({"name": None}, "name"),
    ],
)
def test_invalid_field_named(tmp_path, changes, field):
    with pytest.raises(config.ConfigError) as error:
        config.load(write(tmp_path, **changes))
    assert error.value.field == field
    assert field in str(error.value)


def test_yaml_error_names_path(tmp_path):
    path = tmp_path / "bad.yaml"
    path.write_text("a: [unclosed\n")
    with pytest.raises(config.ConfigError) as error:
        config.load(path)
    assert str(path.resolve()) in str(error.value)


def test_firefox_model_ok(tmp_path):
    cfg = config.load(write(tmp_path, model={"kind": "firefox", "choice": "x"}))
    assert cfg.model.kind == "firefox"


def test_overrides(tmp_path):
    path = write(tmp_path)
    cfg = config.load(
        path,
        {
            "limit": 2,
            "cases": ["case-3"],
            "repetitions": 3,
            "run_id": "r1",
            "headful": True,
        },
    )
    assert cfg.limits.cases == 2
    assert cfg.case_ids == ["case-3"]
    assert cfg.limits.repetitions == 3
    assert cfg.run_id == "r1" and cfg.headful


def test_limit_override_must_be_positive(tmp_path):
    with pytest.raises(config.ConfigError) as error:
        config.load(write(tmp_path), {"limit": 0})
    assert error.value.field == "limit"


def test_snapshot_limit_and_subset_deterministic(tmp_path):
    path = write(tmp_path)
    first = config.load_dataset(config.load(path, {"limit": 2}))
    second = config.load_dataset(config.load(path, {"limit": 2}))
    assert [c["id"] for c in first.cases] == ["case-0", "case-1"]
    assert first == second
    subset = config.load_dataset(config.load(path, {"cases": ["case-3", "case-1"]}))
    assert [c["id"] for c in subset.cases] == ["case-1", "case-3"]


def test_unknown_case_rejected(tmp_path):
    cfg = config.load(write(tmp_path), {"cases": ["nope"]})
    with pytest.raises(config.ConfigError) as error:
        config.load_dataset(cfg)
    assert error.value.field == "dataset.cases"


def test_item_ids_and_turns(tmp_path):
    path = write(tmp_path)
    manifest(tmp_path, count=2, turns=True)
    snapshot = config.load_dataset(config.load(path))
    assert [item["itemId"] for item in snapshot.items] == [
        "ds:case-0:0",
        "ds:case-0:1",
        "ds:case-1:0",
    ]
    assert snapshot.expected_keys(2)[0] == ("case-0", 0, 1)
    assert len(snapshot.expected_keys(2)) == 6


def test_snapshot_hash_and_scorer_passthrough(tmp_path):
    path = write(tmp_path)
    scorer = {"path": "s/reward.py", "sha256": "ab", "revision": "rev"}
    data = {"metadata": {"name": "ds", "scorer": scorer}, "scenarios": [{"id": "a"}]}
    (tmp_path / "manifest.json").write_text(json.dumps(data))
    snapshot = config.load_dataset(config.load(path))
    assert snapshot.scorer == scorer
    assert (
        snapshot.manifest_sha256
        == hashlib.sha256((tmp_path / "manifest.json").read_bytes()).hexdigest()
    )


def test_shipped_configs_load():
    cfg = config.load(EVALS / "example.yaml")
    assert cfg.model.endpoint == "http://127.0.0.1:8080/v1"
    data = yaml.safe_load((EVALS / "officeqa.yaml").read_text())
    assert data["grader"] == "officeqa"
    assert data["limits"]["cases"] == 10
    manifest = (EVALS / data["dataset"]["manifest"]).resolve()
    assert manifest.name == "manifest.json" and manifest.parent.name == "officeqa"


def test_example_snapshot():
    snapshot = config.load_dataset(config.load(EVALS / "example.yaml"))
    assert snapshot.name == "smartwindow-example"
    assert len(snapshot.cases) == 3
    assert all("expectedTool" in case for case in snapshot.cases)
