# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json

from scoring import attributes


def span_time(span, key):
    try:
        return int(span.get(key))
    except (TypeError, ValueError):
        return None


def latency_ms(root_span):
    start = span_time(root_span, "startTimeUnixNano")
    end = span_time(root_span, "endTimeUnixNano")
    if start is None or end is None or end < start:
        return None
    return (end - start) / 1e6


def parse_arguments(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value if value is not None else {}


def requested_tool_calls(attrs):
    try:
        output = json.loads(attrs.get("output.value") or "{}")
    except ValueError:
        return []
    calls = output.get("toolCalls") if isinstance(output, dict) else None
    return calls if isinstance(calls, list) else []


def tool_calls(payload, spans):
    by_id = {}
    requested = []
    for span in spans:
        attrs = attributes(span)
        kind = attrs.get("openinference.span.kind")
        if kind == "TOOL":
            by_id[attrs.get("gen_ai.tool.call.id")] = attrs
        elif kind == "LLM":
            requested.extend(requested_tool_calls(attrs))
    dispatched = payload.get("toolCalls") or []
    known = {call.get("id") for call in dispatched} | set(by_id)
    # The model request cap fails the turn before the last request's calls are
    # added to the conversation, so only the LLM span records them.
    undispatched = [
        call
        for call in requested
        if isinstance(call, dict) and call.get("id") not in known
    ]
    calls = []
    for call in dispatched + undispatched:
        function = call["function"]
        attrs = by_id.get(call.get("id"))
        executed = attrs is not None and attrs.get("smartwindow.tool.executed") is True
        calls.append({
            "name": function["name"],
            "arguments": parse_arguments(function.get("arguments")),
            "executed": executed,
            "rejected": (attrs is not None and not executed) or call in undispatched,
        })
    return calls


def usage(spans):
    totals = {}
    for span in spans:
        attrs = attributes(span)
        for name in ("prompt", "completion"):
            value = attrs.get(f"llm.token_count.{name}")
            if value is not None:
                totals[name] = totals.get(name, 0) + int(value)
    if not totals:
        return None
    return {
        "prompt": totals.get("prompt", 0),
        "completion": totals.get("completion", 0),
    }


def status_for(error):
    if not error:
        return "completed"
    return "timeout" if "timed out" in str(error) else "error"


def base_record(case_id, item_id, repetition, turn_index, reference):
    return {
        "runId": None,
        "caseId": case_id,
        "itemId": item_id,
        "repetition": repetition,
        "turnIndex": turn_index,
        "traceId": None,
        "rootSpanId": None,
        "conversationId": None,
        "model": None,
        "promptVersion": None,
        "firefoxBuild": None,
        "question": None,
        "prompt": None,
        "answer": "",
        "reference": reference,
        "toolCalls": [],
        "tabs": [],
        "extractions": [],
        "modelCalls": 0,
        "usage": None,
        "latencyMs": None,
        "traceIncomplete": False,
        "status": "skipped",
        "error": None,
        "scores": [],
    }


def from_browser_result(payload, root_span, spans, reference, item_id):
    all_attrs = [attributes(span) for span in spans]
    incomplete = any(
        attrs.get("smartwindow.truncated")
        or attrs.get("smartwindow.serialization_error")
        for attrs in all_attrs
    )
    error = payload.get("error") or None
    return {
        **base_record(
            payload.get("scenarioId"),
            item_id,
            payload.get("repetition", 1),
            payload.get("turnIndex", 0),
            reference,
        ),
        "runId": payload.get("runId"),
        "traceId": root_span.get("traceId"),
        "rootSpanId": root_span.get("spanId"),
        "conversationId": payload.get("conversationId"),
        "model": payload.get("model"),
        "promptVersion": payload.get("promptVersion"),
        "firefoxBuild": payload.get("firefoxBuild"),
        "question": payload.get("originalQuestion"),
        "prompt": payload.get("prompt"),
        "answer": payload.get("responseText") or "",
        "toolCalls": tool_calls(payload, spans),
        "tabs": [
            {
                "index": tab.get("index"),
                "url": tab.get("url"),
                "title": tab.get("title"),
            }
            for tab in payload.get("tabs") or []
        ],
        "extractions": [
            {
                "url": item.get("url"),
                "success": bool(item.get("success")),
                "textLength": item.get("textLength", 0),
                "strategy": item.get("strategy"),
                "sufficientLength": item.get("sufficientLength"),
                "elapsedMs": item.get("elapsedMs"),
                "error": item.get("error"),
            }
            for item in payload.get("extractions") or []
        ],
        "modelCalls": sum(
            attrs.get("openinference.span.kind") == "LLM" for attrs in all_attrs
        ),
        "usage": usage(spans),
        "latencyMs": latency_ms(root_span),
        "traceIncomplete": bool(incomplete),
        "status": status_for(error),
        "error": error,
    }


def skipped(case, turn_index, repetition, item_id, reason):
    turns = case.get("turns", [case])
    turn = turns[turn_index] if turn_index < len(turns) else case
    reference = turn.get("reference", case.get("reference", ""))
    return {
        **base_record(case["id"], item_id, repetition, turn_index, reference),
        "question": turn.get("prompt"),
        "prompt": turn.get("prompt"),
        "error": reason,
    }


def summarize(records, expected_keys):
    expected = {tuple(key) for key in expected_keys}
    by_key = {
        (record["caseId"], record["turnIndex"], record["repetition"]): record
        for record in records
    }
    present = [record for key, record in by_key.items() if key in expected]
    counts = {"completed": 0, "error": 0, "timeout": 0}
    for record in present:
        counts[record["status"]] = counts.get(record["status"], 0) + 1
    names = sorted({score["name"] for record in present for score in record["scores"]})
    metrics = {}
    for name in names:
        scores = [
            score
            for record in present
            for score in record["scores"]
            if score["name"] == name
        ]
        values = [
            score["value"]
            for score in scores
            if score.get("status") == "scored"
            and isinstance(score.get("value"), (int, float))
        ]
        metrics[name] = {
            "mean": sum(values) / len(values) if values else None,
            "scored": len(values),
            "total": len(expected),
            "errors": sum(score.get("status") == "error" for score in scores),
            "unavailable": sum(
                score.get("status") == "unavailable" for score in scores
            ),
        }
    return {
        "total": len(expected),
        "completed": counts["completed"],
        "failed": counts["error"] + counts["timeout"],
        "timeouts": counts["timeout"],
        "scoreErrors": sum(metric["errors"] for metric in metrics.values()),
        "metrics": metrics,
    }
