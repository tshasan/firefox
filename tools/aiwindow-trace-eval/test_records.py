# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json

import records


def attr(key, value):
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": value}}


def span(span_id, attrs, start=0, end=0, parent=""):
    return {
        "traceId": "a" * 32,
        "spanId": span_id,
        "parentSpanId": parent,
        "startTimeUnixNano": str(start),
        "endTimeUnixNano": str(end),
        "attributes": [attr(k, v) for k, v in attrs.items()],
    }


ROOT = span(
    "1" * 16, {"openinference.span.kind": "CHAIN"}, 1_000_000_000, 3_500_000_000
)


def llm(span_id, prompt=None, completion=None):
    attrs = {"openinference.span.kind": "LLM"}
    if prompt is not None:
        attrs["llm.token_count.prompt"] = prompt
        attrs["llm.token_count.completion"] = completion
    return span(span_id, attrs, parent=ROOT["spanId"])


def tool(span_id, call_id, executed):
    return span(
        span_id,
        {
            "openinference.span.kind": "TOOL",
            "gen_ai.tool.name": "get_page_content",
            "gen_ai.tool.call.id": call_id,
            "smartwindow.tool.executed": executed,
        },
        parent=ROOT["spanId"],
    )


PAYLOAD = {
    "runId": "run-1",
    "scenarioId": "case-a",
    "conversationId": "conv",
    "repetition": 2,
    "turnIndex": 0,
    "model": "m",
    "promptVersion": "v1",
    "firefoxBuild": {"version": "157.0a1", "buildId": "20261112000000"},
    "originalQuestion": "What?",
    "prompt": "What? Answer.",
    "responseText": "Because.",
    "toolCalls": [
        {
            "id": "c1",
            "type": "function",
            "function": {"name": "get_page_content", "arguments": '{"url": "u"}'},
        },
        {
            "id": "c2",
            "type": "function",
            "function": {"name": "get_page_content", "arguments": "{}"},
        },
    ],
    "tabs": [{"index": 0, "url": "http://x/", "title": "T"}],
    "extractions": [
        {
            "url": "http://x/",
            "success": True,
            "textLength": 5,
            "strategy": "pdf",
            "sufficientLength": 100,
            "elapsedMs": 12.5,
            "extractedText": "hello",
        },
        {
            "url": "http://y/",
            "success": False,
            "strategy": "html",
            "elapsedMs": 3.0,
            "error": "Error: actor destroyed",
        },
    ],
    "error": None,
}


def build(payload=PAYLOAD, spans=None):
    spans = (
        spans
        if spans is not None
        else [ROOT, llm("2" * 16, 10, 3), llm("3" * 16, 7, 2)]
    )
    return records.from_browser_result(
        payload, ROOT, [ROOT, *spans], "ref", "ds:case-a:0"
    )


def test_record_fields():
    record = build()
    assert record["runId"] == "run-1"
    assert record["caseId"] == "case-a"
    assert record["itemId"] == "ds:case-a:0"
    assert record["repetition"] == 2
    assert record["traceId"] == "a" * 32
    assert record["rootSpanId"] == "1" * 16
    assert record["question"] == "What?"
    assert record["promptVersion"] == "v1"
    assert record["firefoxBuild"] == {
        "version": "157.0a1",
        "buildId": "20261112000000",
    }
    assert record["answer"] == "Because."
    assert record["reference"] == "ref"
    assert record["modelCalls"] == 2
    assert record["usage"] == {"prompt": 17, "completion": 5}
    assert record["latencyMs"] == 2500.0
    assert record["status"] == "completed"
    assert record["error"] is None
    assert record["traceIncomplete"] is False
    assert record["scores"] == []
    assert record["extractions"] == [
        {
            "url": "http://x/",
            "success": True,
            "textLength": 5,
            "strategy": "pdf",
            "sufficientLength": 100,
            "elapsedMs": 12.5,
            "error": None,
        },
        {
            "url": "http://y/",
            "success": False,
            "textLength": 0,
            "strategy": "html",
            "sufficientLength": None,
            "elapsedMs": 3.0,
            "error": "Error: actor destroyed",
        },
    ]


def test_usage_null_without_token_counts():
    record = build(spans=[llm("2" * 16)])
    assert record["usage"] is None
    assert record["modelCalls"] == 1


def test_tool_calls_from_spans():
    record = build(spans=[tool("4" * 16, "c1", True), tool("5" * 16, "c2", False)])
    assert record["toolCalls"] == [
        {
            "name": "get_page_content",
            "arguments": {"url": "u"},
            "executed": True,
            "rejected": False,
        },
        {
            "name": "get_page_content",
            "arguments": {},
            "executed": False,
            "rejected": True,
        },
    ]


def test_tool_calls_include_calls_dropped_by_the_request_cap():
    capped = llm("6" * 16, 5, 1)
    capped["attributes"].append(
        attr(
            "output.value",
            json.dumps({
                "text": "",
                "toolCalls": [
                    {
                        "id": "c1",
                        "function": {"name": "get_page_content", "arguments": "{}"},
                    },
                    {
                        "id": "c3",
                        "function": {"name": "get_open_tabs", "arguments": "{}"},
                    },
                ],
            }),
        )
    )
    record = build(
        {**PAYLOAD, "error": "Error: Model request limit of 1 reached"},
        spans=[tool("4" * 16, "c1", True), tool("5" * 16, "c2", False), capped],
    )
    assert [
        (call["name"], call["executed"], call["rejected"])
        for call in record["toolCalls"]
    ] == [
        ("get_page_content", True, False),
        ("get_page_content", False, True),
        ("get_open_tabs", False, True),
    ]


def test_status_rules():
    assert (
        build({**PAYLOAD, "error": "scenario timed out after 300s"})["status"]
        == "timeout"
    )
    assert build({**PAYLOAD, "error": "boom"})["status"] == "error"
    assert build({**PAYLOAD, "error": "boom"})["error"] == "boom"


def test_truncated_marks_incomplete():
    truncated = span("6" * 16, {"smartwindow.truncated": True})
    assert build(spans=[truncated])["traceIncomplete"] is True
    broken = span("7" * 16, {"smartwindow.serialization_error": "bad"})
    assert build(spans=[broken])["traceIncomplete"] is True


def test_skipped_record():
    case = {"id": "case-a", "prompt": "q", "reference": "r"}
    record = records.skipped(case, 0, 1, "ds:case-a:0", "token budget exhausted")
    assert record["status"] == "skipped"
    assert record["error"] == "token budget exhausted"
    assert record["reference"] == "r"
    assert record["scores"] == []


def scored(name, value, status="scored"):
    score = {"name": name, "status": status}
    if status == "scored":
        score["value"] = value
    return score


def test_summarize_counts_and_metrics():
    expected = [("a", 0, 1), ("b", 0, 1), ("c", 0, 1), ("d", 0, 1)]
    done = build()
    done.update(caseId="a", repetition=1, scores=[scored("m", 1)])
    second = {**done, "caseId": "b", "scores": [scored("m", 0)]}
    third = {
        **done,
        "caseId": "c",
        "status": "timeout",
        "scores": [scored("m", None, "error")],
    }
    extra = {**done, "caseId": "zzz"}
    summary = records.summarize([done, second, third, extra], expected)
    assert summary["total"] == 4
    assert summary["completed"] == 2
    assert summary["metrics"]["m"] == {
        "mean": 0.5,
        "scored": 2,
        "total": 4,
        "errors": 1,
        "unavailable": 0,
    }


def test_summarize_skipped_and_unavailable():
    case = {"id": "a", "prompt": "q"}
    skip = records.skipped(case, 0, 1, "i", "limit")
    other = build()
    other.update(caseId="b", repetition=1, scores=[scored("m", None, "unavailable")])
    summary = records.summarize([skip, other], [("a", 0, 1), ("b", 0, 1)])
    assert summary["completed"] == 1
    assert summary["metrics"]["m"]["unavailable"] == 1
    assert summary["metrics"]["m"]["mean"] is None
