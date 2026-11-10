# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import hashlib
import importlib.util
import json
import math
from pathlib import Path
from urllib.parse import parse_qs, unquote, urldefrag, urlparse

OFFICEQA_REVISION = "7b9a3c154ef9fb40215bb67934afc43e6799de16"
OFFICEQA_SCORER_SHA256 = (
    "0d91698c87df6d889339aac36f63ae0966607f169890b0bf8b472b26bfe8138f"
)


def attributes(span):
    return {
        item["key"]: next(iter(item["value"].values()))
        for item in span.get("attributes", [])
    }


def spans(payload):
    return [
        span
        for resource in payload.get("resourceSpans", [])
        for scope in resource.get("scopeSpans", [])
        for span in scope.get("spans", [])
    ]


def extraction_coverage(result, expected_sources, read_tool):
    tabs = {tab["index"]: tab for tab in result.get("tabs", [])}
    extracted = {
        urldefrag(item.get("url", ""))[0]
        for item in result.get("extractions", [])
        if item.get("success") and item.get("textLength", 0) > 0
    }
    required = [
        urldefrag(tabs[index]["url"])[0] for index in expected_sources if index in tabs
    ]
    passed = (
        bool(required)
        and len(required) == len(expected_sources)
        and all(url in extracted for url in required)
        and read_tool
    )
    return {
        "name": "extraction_coverage",
        "annotator_kind": "CODE",
        "score": int(passed),
        "label": "pass" if passed else "fail",
        "explanation": f"Actual PageExtractor reads covered {sum(url in extracted for url in required)}/{len(expected_sources)} required pages; get_page_content executed: {read_tool}.",
    }


def wiki_title(url):
    parsed = urlparse(url or "")
    if not parsed.netloc.endswith("wikipedia.org"):
        return None
    title = parse_qs(parsed.query).get("title", [None])[0]
    if not title and parsed.path.startswith("/wiki/"):
        title = parsed.path.removeprefix("/wiki/")
    return unquote(title).replace(" ", "_").casefold() if title else None


def response_text(root):
    value = attributes(root).get("output.value")
    if not isinstance(value, str):
        return ""
    try:
        content = json.loads(value)
    except ValueError:
        return value
    if isinstance(content, dict):
        return content.get("body") or ""
    return content if isinstance(content, str) else ""


def tool_counts(trace):
    counts = {}
    for span in trace:
        attrs = attributes(span)
        if attrs.get("openinference.span.kind") == "TOOL" and attrs.get(
            "smartwindow.tool.executed"
        ):
            name = attrs.get("gen_ai.tool.name")
            counts[name] = counts.get(name, 0) + 1
    return counts


def source_coverage(gold_sources, trace):
    gold = {wiki_title(source["url"]) for source in gold_sources} - {None}
    read = set()
    for span in trace:
        if span.get("name") != "get_page_content.read":
            continue
        try:
            output = json.loads(attributes(span).get("output.value") or "{}")
        except ValueError:
            continue
        if output.get("ok") and output.get("content"):
            read.add(wiki_title(output.get("url")))
    covered = gold & read
    counts = tool_counts(trace)
    return {
        "name": "source_coverage",
        "annotator_kind": "CODE",
        "score": len(covered) / len(gold) if gold else 0.0,
        "explanation": f"Read {len(covered)}/{len(gold)} gold articles; executed tools: {json.dumps(counts, sort_keys=True)}.",
    }


def metric_summary(results, total):
    names = {
        score["name"]
        for result in results
        for score in result["scores"] + result.get("unavailableScores", [])
    }
    output = {}
    for name in sorted(names):
        scores = [
            score
            for result in results
            for score in result["scores"]
            if score["name"] == name
        ]
        values = [
            score["score"]
            for score in scores
            if isinstance(score.get("score"), (int, float))
        ]
        output[name] = {
            "mean": sum(values) / len(values) if values else None,
            "scored": len(values),
            "total": total,
            "errors": sum("error" in score for score in scores),
            "unavailable": sum(
                score["name"] == name
                for result in results
                for score in result.get("unavailableScores", [])
            ),
        }
    return output


class OfficeQAScorer:
    def __init__(self, path, expected_hash, tolerance=0.0):
        path = Path(path)
        self.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected_hash != OFFICEQA_SCORER_SHA256 or self.sha256 != expected_hash:
            raise ValueError(
                "Official OfficeQA scorer SHA256 does not match the pinned manifest"
            )
        if not math.isfinite(tolerance) or not 0 <= tolerance <= 1:
            raise ValueError("OfficeQA relative tolerance must be between 0 and 1")
        spec = importlib.util.spec_from_file_location(
            "smartwindow_officeqa_reward", path
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tolerance = tolerance

    def score(self, reference, answer):
        value = self.module.score_answer(
            ground_truth=str(reference), predicted=answer, tolerance=self.tolerance
        )
        if value not in (0, 1):
            raise ValueError("Official scorer returned a non-binary score")
        return {
            "name": "officeqa_accuracy",
            "annotator_kind": "CODE",
            "score": value,
            "label": "correct" if value else "incorrect",
            "explanation": f"Official OfficeQA score_answer; relative tolerance={self.tolerance}; scorer SHA256={self.sha256}.",
        }
