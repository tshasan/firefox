# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import copy
import json
from types import SimpleNamespace

import fake_langfuse
import publish
import publisher
import pytest

TRACE_ID = "a" * 32
ROOT_ID = "b" * 16
CHILD_ID = "c" * 16


def payload(trace_id=TRACE_ID, root_id=ROOT_ID):
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "t"}}
                    ]
                },
                "scopeSpans": [
                    {
                        "spans": [
                            {
                                "traceId": trace_id,
                                "spanId": root_id,
                                "name": "root",
                                "attributes": [
                                    {"key": "x", "value": {"stringValue": "1"}}
                                ],
                            },
                            {
                                "traceId": trace_id,
                                "spanId": CHILD_ID,
                                "parentSpanId": root_id,
                                "name": "child",
                            },
                        ]
                    }
                ],
            }
        ]
    }


def record(repetition=1, trace_id=TRACE_ID, root_id=ROOT_ID, item_id="ds:case1:0"):
    return {
        "runId": "run-1",
        "caseId": "case1",
        "itemId": item_id,
        "repetition": repetition,
        "traceId": trace_id,
        "rootSpanId": root_id,
        "prompt": "What?",
        "answer": "That.",
        "reference": "That",
        "scores": [
            {"name": "acc", "value": 1, "label": "correct", "status": "scored"},
            {"name": "cov", "status": "unavailable"},
        ],
    }


def snapshot():
    return SimpleNamespace(
        name="ds",
        manifest_sha256="abc",
        cases=[{"id": "case1", "prompt": "What?", "reference": "That"}],
        items=[
            {
                "itemId": "ds:case1:0",
                "caseId": "case1",
                "turnIndex": 0,
                "input": {"prompt": "What?"},
                "expectedOutput": "That",
                "metadata": {"caseId": "case1"},
            }
        ],
    )


def attrs(span):
    return {a["key"]: a["value"]["stringValue"] for a in span["attributes"]}


@pytest.fixture
def server():
    with fake_langfuse.fake_langfuse() as (url, state):
        yield url, state


@pytest.fixture(autouse=True)
def fast_retries(monkeypatch):
    monkeypatch.setattr(publisher, "RETRY_BACKOFF", (0, 0))


def make(url, run_id="run-1"):
    settings = publisher.Settings(f"pk-{url.rsplit(':', 1)[1]}", "sk", url)
    return publisher.build(settings, run_id, "always")


def publish_run(pub, rec, trace=None, snap=None):
    snap = snap or snapshot()
    ref = pub.publish_dataset(snap)
    experiment = publisher.experiment_for("run-1", rec["repetition"], ref, snap)
    pub.publish_trace(rec, trace or payload(), experiment)
    pub.publish_scores(rec, experiment)
    pub.flush()
    return experiment


def test_trace_attributes_and_ids(server):
    url, state = server
    pub = make(url)
    rec = record()
    original = payload()
    pristine = copy.deepcopy(original)
    ref = pub.publish_dataset(snapshot())
    experiment = publisher.experiment_for("run-1", 1, ref, snapshot())
    pub.publish_trace(rec, original, experiment)
    assert original == pristine
    assert "publishError" not in rec

    (post,) = state.otel_posts
    assert post["headers"]["x-langfuse-ingestion-version"] == "4"
    assert post["headers"]["Authorization"].startswith("Basic ")
    resource = post["body"]["resourceSpans"][0]
    assert attrs(resource["resource"])["langfuse.environment"] == "experiment"
    root, child = resource["scopeSpans"][0]["spans"]
    assert (root["traceId"], root["spanId"], child["spanId"]) == (
        TRACE_ID,
        ROOT_ID,
        CHILD_ID,
    )
    for span in (root, child):
        a = attrs(span)
        assert a["langfuse.experiment.id"] == "run-1"
        assert a["langfuse.experiment.name"] == "run-1"
        assert a["langfuse.experiment.dataset.id"] == state.datasets["ds"]["id"]
        assert a["langfuse.experiment.metadata.run_group"] == "run-1"
        assert a["langfuse.environment"] == "experiment"
        assert a["langfuse.experiment.item.id"] == "ds:case1:0"
        assert a["langfuse.experiment.item.root_observation_id"] == ROOT_ID
    root_attrs = attrs(root)
    assert root_attrs["x"] == "1"
    assert root_attrs["langfuse.observation.input"] == "What?"
    assert root_attrs["langfuse.observation.output"] == "That."
    assert json.loads(root_attrs["langfuse.experiment.item.expected_output"]) == "That"
    assert "langfuse.observation.input" not in attrs(child)


def test_dataset_items_and_scores_are_idempotent(server):
    url, state = server
    rec = record()
    for _ in range(2):
        pub = make(url)
        publish_run(pub, rec)
    assert list(state.datasets) == ["ds"]
    assert list(state.items) == ["ds:case1:0"]
    assert state.items["ds:case1:0"]["expectedOutput"] == "That"
    expected = publisher.score_id("run-1", "ds:case1:0", 1, "acc")
    assert list(state.scores) == [expected]
    assert len(expected) == 32
    score = state.scores[expected]
    assert score["traceId"] == TRACE_ID
    assert score["observationId"] == ROOT_ID
    assert score["value"] == 1.0
    assert score["environment"] == "experiment"
    assert len(state.otel_posts) == 2


def test_get_dataset_sees_items(server):
    url, _ = server
    pub = make(url)
    pub.publish_dataset(snapshot())
    dataset = pub.client.get_dataset("ds")
    assert [item.id for item in dataset.items] == ["ds:case1:0"]


def test_repetition_two_is_separate_experiment(server):
    url, state = server
    pub = make(url)
    snap = snapshot()
    ref = pub.publish_dataset(snap)
    first = publisher.experiment_for("run-1", 1, ref, snap)
    second = publisher.experiment_for("run-1", 2, ref, snap)
    assert second["name"] == "run-1-rep2"
    assert second["id"] != first["id"]
    assert second["run_group"] == first["run_group"] == "run-1"
    rec = record(repetition=2)
    pub.publish_trace(rec, payload(), second)
    root = state.otel_posts[0]["body"]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    a = attrs(root)
    assert a["langfuse.experiment.name"] == "run-1-rep2"
    assert a["langfuse.experiment.metadata.run_group"] == "run-1"
    pub.publish_scores(rec, second)
    pub.flush()
    assert publisher.score_id("run-1", "ds:case1:0", 2, "acc") in state.scores
    assert publisher.score_id("run-1", "ds:case1:0", 1, "acc") not in state.scores


def test_links_need_project_id(server):
    url, _ = server
    pub = make(url)
    rec = record()
    assert pub.links(rec) == {}
    pub.publish_dataset(snapshot())
    links = pub.links(rec)
    assert links["trace"] == f"{url}/project/fake-project/traces/{TRACE_ID}"


def test_unreachable_server_records_error_without_raising():
    pub = make("http://127.0.0.1:1")
    snap = snapshot()
    experiment = publisher.experiment_for("run-1", 1, None, snap)
    rec = record()
    pub.publish_trace(rec, payload(), experiment)
    assert rec["publishError"].startswith("trace:")
    pub.publish_trace(rec, payload(), experiment)
    assert rec["publishError"].count("trace:") == 2
    assert pub.publish_dataset(snap) is None
    assert pub.dataset_error


def test_client_error_is_not_retried(server):
    url, state = server
    pub = make(url)
    pub.settings = publisher.Settings("pk", "sk", url + "/missing")
    rec = record()
    pub.publish_trace(
        rec, payload(), publisher.experiment_for("r", 1, None, snapshot())
    )
    assert "HTTP 404" in rec["publishError"]
    assert state.otel_posts == []


def test_missing_root_span_is_an_error(server):
    url, state = server
    pub = make(url)
    rec = record(root_id="d" * 16)
    pub.publish_trace(
        rec, payload(), publisher.experiment_for("r", 1, None, snapshot())
    )
    assert "root span" in rec["publishError"]
    assert state.otel_posts == []


def test_null_publisher_and_build_modes():
    assert publisher.Settings.from_env({}) is None
    assert publisher.Settings.from_env({"LANGFUSE_PUBLIC_KEY": "a"}) is None
    settings = publisher.Settings.from_env({
        "LANGFUSE_PUBLIC_KEY": "a",
        "LANGFUSE_SECRET_KEY": "b",
        "LANGFUSE_BASE_URL": "http://x/",
    })
    assert settings.base_url == "http://x"
    assert isinstance(publisher.build(None, "r", "auto"), publisher.NullPublisher)
    assert isinstance(publisher.build(settings, "r", "never"), publisher.NullPublisher)
    assert isinstance(
        publisher.build(settings, "r", "auto"), publisher.LangfusePublisher
    )
    with pytest.raises(publisher.PublisherError):
        publisher.build(None, "r", "always")
    null = publisher.NullPublisher()
    rec = record()
    before = copy.deepcopy(rec)
    null.publish_dataset(snapshot())
    null.publish_trace(rec, payload(), {})
    null.publish_scores(rec, {})
    null.flush()
    null.close()
    assert null.links(rec) == {}
    assert rec == before


def write_run(run_dir, records, traces):
    snap = snapshot()
    config = {
        "runId": "run-1",
        "publish": {"langfuse": "auto"},
        "dataset": {
            "name": snap.name,
            "manifest_sha256": snap.manifest_sha256,
            "cases": snap.cases,
            "items": snap.items,
        },
    }
    (run_dir / "config.json").write_text(json.dumps(config))
    (run_dir / "traces.jsonl").write_text("".join(json.dumps(t) + "\n" for t in traces))
    (run_dir / "results.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in records)
    )


def test_publish_round_trip(server, tmp_path, monkeypatch):
    url, state = server
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", f"pk-{url.rsplit(':', 1)[1]}")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setenv("LANGFUSE_BASE_URL", url)
    write_run(tmp_path, [record()], [payload()])
    assert publish.main([str(tmp_path)]) == 0
    assert publish.main([str(tmp_path)]) == 0
    assert len(state.items) == 1
    assert len(state.scores) == 1
    assert len(state.otel_posts) == 2


def test_publish_fails_when_trace_missing(server, tmp_path, monkeypatch):
    url, _ = server
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", f"pk-{url.rsplit(':', 1)[1]}")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setenv("LANGFUSE_BASE_URL", url)
    write_run(tmp_path, [record(trace_id="e" * 32)], [payload()])
    assert publish.main([str(tmp_path)]) == 1
    saved = json.loads((tmp_path / "results.jsonl").read_text())
    assert "traces.jsonl" in saved["publishError"]
