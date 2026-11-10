# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import argparse
import hashlib
import json
import mimetypes
import signal
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, urlparse

import graders
import publisher as publisher_module
import records
from scoring import attributes, spans

from config import load as load_config
from config import load_dataset

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts/aiwindow-trace-eval"
MAX_BODY = 8 * 1024 * 1024
FINAL_ANSWER_INSTRUCTION = (
    "\n\nThe source document is open in the current tab; read it with"
    " get_page_content before answering. Put only your final answer inside"
    " <FINAL_ANSWER>...</FINAL_ANSWER>."
)


def add_override_arguments(parser):
    parser.add_argument(
        "--config",
        type=Path,
        default=Path(__file__).resolve().parent / "evals/example.yaml",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--repetitions", type=int)
    parser.add_argument("--run-id")
    parser.add_argument("--headful", action="store_true")


def overrides_from(args):
    values = {
        "limit": args.limit,
        "cases": args.case or None,
        "repetitions": args.repetitions,
        "run_id": args.run_id,
        "headful": args.headful or None,
    }
    return {key: value for key, value in values.items() if value is not None}


def publishable_items(snapshot):
    items = []
    for item in snapshot.items:
        case = snapshot.case(item["caseId"])
        turn = case.get("turns", [case])[item["turnIndex"]]
        items.append({
            **item,
            "input": {
                "prompt": turn.get("prompt"),
                "tabs": [
                    {
                        key: tab[key]
                        for key in ("title", "url", "sourceUrl")
                        if key in tab
                    }
                    for tab in case.get("tabs", [])
                ],
                "turnIndex": item["turnIndex"],
            },
            "expectedOutput": turn.get("reference", case.get("reference", "")),
            "metadata": {
                "caseId": case["id"],
                "turnIndex": item["turnIndex"],
                "category": case.get("category", case.get("difficulty", "default")),
            },
        })
    return items


def publishable_snapshot(snapshot):
    return SimpleNamespace(
        name=snapshot.name,
        manifest_sha256=snapshot.manifest_sha256,
        cases=list(snapshot.cases),
        items=publishable_items(snapshot),
    )


class EvaluationServer(HTTPServer):
    def __init__(
        self,
        config,
        snapshot,
        run_id,
        output_dir,
        publisher,
        served_model=None,
    ):
        super().__init__(("127.0.0.1", 4318), Handler)
        self.resolved = config.resolved()
        self.snapshot = snapshot
        self.run_id = run_id
        self.publisher = publisher
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.limits = self.resolved["limits"]
        self.repetitions = self.limits["repetitions"]
        self.model = dict(self.resolved["model"])
        if served_model and not self.model["model"]:
            self.model["model"] = served_model
        self.metadata = snapshot.metadata
        self.cases = list(snapshot.cases)
        self.base_dir = Path(snapshot.manifest_path).parent
        self.grader = graders.build(config, snapshot)
        self.started = time.monotonic()
        self.traces = {}
        self.results = {}
        self.fixture_files = {}
        self.total_tokens = 0
        self.stop_reason = None
        self.runtime_cases = [self.runtime_case(case) for case in self.cases]
        self.published_snapshot = publishable_snapshot(snapshot)
        self.dataset_ref = publisher.publish_dataset(self.published_snapshot)

    def runtime_case(self, case):
        fields = ("id", "category", "prompt", "activeTab", "contextTabIndices")
        runtime = {key: case[key] for key in fields if key in case}
        runtime["tabs"] = []
        for tab in case["tabs"]:
            item = {
                key: tab[key]
                for key in ("title", "mediaType", "waitForSelector")
                if key in tab
            }
            if tab.get("fixture"):
                path = (self.base_dir / tab["fixture"]).resolve()
                if not path.is_file():
                    raise ValueError(f"Missing source fixture: {path}")
                content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
                expected_hash = tab.get("source", {}).get("fixtureSha256") or tab.get(
                    "sha256", tab.get("source", {}).get("sha256")
                )
                if expected_hash and content_hash != expected_hash:
                    raise ValueError(f"Source fixture hash mismatch: {path}")
                route = "/fixtures/" + content_hash + "/" + quote(path.name)
                self.fixture_files[route] = path
                item["url"] = "http://127.0.0.1:4318" + route
            elif "html" in tab or "body" in tab:
                item.update({key: tab[key] for key in ("html", "body") if key in tab})
            else:
                source = tab.get("sourceUrl", tab.get("url"))
                if not source or urlparse(source).scheme not in ("http", "https"):
                    raise ValueError(f"Case {case['id']} has no usable source")
                item["url"] = source
            runtime["tabs"].append(item)
        if "turns" in case:
            runtime["turns"] = [
                {
                    key: turn[key]
                    for key in ("prompt", "activeTab", "contextTabIndices")
                    if key in turn
                }
                for turn in case["turns"]
            ]
        return runtime

    def scenarios(self):
        return self.runtime_cases

    def config(self):
        return {
            "runId": self.run_id,
            "model": self.model,
            "toolPolicy": self.resolved["toolPolicy"],
            "offline": bool(self.metadata.get("offline", False)),
            "repetitions": self.repetitions,
            "caseTimeoutMs": self.limits["caseTimeoutSeconds"] * 1000,
            "modelCallsPerCase": self.limits["modelCallsPerCase"],
            "outputInstruction": FINAL_ANSWER_INSTRUCTION
            if self.resolved["grader"] == "officeqa"
            else "",
        }

    def persist(self, name, value):
        with (self.output_dir / name).open("a") as output:
            output.write(json.dumps(value, ensure_ascii=False) + "\n")

    def ingest(self, payload):
        for span in spans(payload):
            run_id = attributes(span).get("smartwindow.run_id")
            if run_id and run_id != self.run_id:
                raise ValueError("Trace belongs to another evaluation run")
        self.persist("traces.jsonl", payload)
        for resource in payload.get("resourceSpans", []):
            for scope in resource.get("scopeSpans", []):
                for span in scope.get("spans", []):
                    trace = self.traces.setdefault(
                        span["traceId"],
                        {
                            "resource": resource.get("resource"),
                            "scope": scope.get("scope"),
                            "spans": {},
                        },
                    )
                    trace["spans"][span["spanId"]] = span
        while len(self.traces) > 128:
            del self.traces[next(iter(self.traces))]

    def trace_payload(self, trace_id):
        trace = self.traces[trace_id]
        resource, scope = trace["resource"], trace["scope"]
        scope_spans = {"spans": list(trace["spans"].values())}
        if scope:
            scope_spans["scope"] = scope
        resource_spans = {"scopeSpans": [scope_spans]}
        if resource:
            resource_spans["resource"] = resource
        return {"resourceSpans": [resource_spans]}

    def trace_for(self, result):
        for trace in reversed(list(self.traces.values())):
            for span in trace["spans"].values():
                attrs = attributes(span)
                if (
                    not span.get("parentSpanId")
                    and attrs.get("smartwindow.scenario_id") == result["scenarioId"]
                    and attrs.get("smartwindow.run_id") == result["runId"]
                    and attrs.get("session.id") == result["conversationId"]
                    and (
                        "repetition" not in result
                        or str(attrs.get("smartwindow.repetition"))
                        == str(result["repetition"])
                    )
                    and (
                        "turnIndex" not in result
                        or str(attrs.get("smartwindow.eval_turn_index"))
                        == str(result["turnIndex"])
                    )
                ):
                    return span, list(trace["spans"].values())
        raise ValueError("No completed trace matches this case/run/conversation")

    def experiment_for(self, repetition):
        return publisher_module.experiment_for(
            self.run_id, repetition, self.dataset_ref, self.published_snapshot
        )

    def update_stop_reason(self):
        total = self.limits.get("totalTokens")
        if total is not None and self.total_tokens > total:
            self.stop_reason = f"Token limit {total} exceeded ({self.total_tokens})"
        elif time.monotonic() - self.started > self.limits["runtimeSeconds"]:
            self.stop_reason = (
                f"Runtime limit {self.limits['runtimeSeconds']}s exceeded"
            )

    def evaluate(self, result):
        if result["runId"] != self.run_id:
            raise ValueError("Result runId does not match this server")
        case = next(
            (case for case in self.cases if case["id"] == result["scenarioId"]), None
        )
        if case is None:
            raise ValueError("Unknown case")
        repetition = result.get("repetition", 1)
        turn_index = result.get("turnIndex", 0)
        if not 1 <= repetition <= self.repetitions:
            raise ValueError("Repetition out of range")
        turns = case.get("turns", [case])
        if not 0 <= turn_index < len(turns):
            raise ValueError("Turn index out of range")
        turn = turns[turn_index]
        key = (case["id"], turn_index, repetition)
        if key in self.results:
            raise ValueError("Duplicate case/turn/repetition result")
        root, trace = self.trace_for(result)
        reference = turn.get("reference", case.get("reference", ""))
        record = records.from_browser_result(
            result,
            root,
            trace,
            reference,
            self.snapshot.item_id(case["id"], turn_index),
        )
        record["scores"] = self.grader.score(record, case)
        experiment = self.experiment_for(repetition)
        self.publisher.publish_trace(
            record, self.trace_payload(root["traceId"]), experiment
        )
        self.publisher.publish_scores(record, experiment)
        if dataset_error := self.publisher.dataset_error:
            publisher_module.record_error(record, dataset_error)
        usage = record.get("usage") or {}
        self.total_tokens += (usage.get("prompt") or 0) + (usage.get("completion") or 0)
        self.update_stop_reason()
        self.results[key] = record
        self.persist("results.jsonl", record)
        return {
            **record,
            "continue": self.stop_reason is None,
            "stopReason": self.stop_reason,
        }

    def skipped_records(self, missing):
        if not self.stop_reason:
            return []
        return [
            records.skipped(
                self.snapshot.case(case_id),
                turn_index,
                repetition,
                self.snapshot.item_id(case_id, turn_index),
                self.stop_reason,
            )
            for case_id, turn_index, repetition in missing
        ]

    def summary(self):
        results = list(self.results.values())
        expected = self.snapshot.expected_keys(self.repetitions)
        missing = [key for key in expected if key not in self.results]
        return {
            **records.summarize(results, expected),
            "runId": self.run_id,
            "config": self.resolved,
            "stopReason": self.stop_reason,
            "missing": [
                {"caseId": key[0], "turnIndex": key[1], "repetition": key[2]}
                for key in missing
            ],
            "skipped": self.skipped_records(missing),
            "links": [
                {"itemId": record["itemId"], **links}
                for record in results
                if (links := self.publisher.links(record))
            ],
            "results": results,
        }


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(200)

    def respond(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if (
            self.headers.get("Origin")
            or self.headers.get("Sec-Fetch-Site", "none") != "none"
            or self.headers.get("Host")
            not in (
                "127.0.0.1:4318",
                "localhost:4318",
            )
        ):
            self.respond(
                403, {"error": "Only privileged loopback clients are accepted"}
            )
            return False
        return True

    def do_GET(self):
        if self.path.startswith("/fixtures/"):
            path = self.server.fixture_files.get(self.path)
            if path is None:
                self.respond(404, {"error": "Unknown source fixture"})
                return
            self.send_response(200)
            self.send_header(
                "Content-Type",
                mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            )
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with path.open("rb") as source:
                while chunk := source.read(65536):
                    self.wfile.write(chunk)
            return
        if not self.allowed():
            return
        if self.path == "/config":
            self.respond(200, self.server.config())
        elif self.path == "/scenarios":
            self.respond(200, self.server.scenarios())
        elif self.path == "/summary":
            self.respond(200, self.server.summary())
        elif self.path == "/health":
            self.respond(200, {"status": "ok", "runId": self.server.run_id})
        else:
            self.respond(404, {"error": "Unknown endpoint"})

    def do_POST(self):
        if not self.allowed():
            return
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > MAX_BODY:
                self.respond(413, {"error": "Invalid or excessive body size"})
                return
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.respond(415, {"error": "Expected application/json"})
                return
            payload = json.loads(self.rfile.read(size))
            if self.path == "/v1/traces":
                self.server.ingest(payload)
                self.respond(200, {})
            elif self.path == "/results":
                self.respond(200, self.server.evaluate(payload))
            else:
                self.respond(404, {"error": "Unknown endpoint"})
        except (ValueError, KeyError) as error:
            self.respond(400, {"error": str(error)})
        except Exception as error:
            self.respond(500, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser()
    add_override_arguments(parser)
    parser.add_argument("--output", type=Path, default=ARTIFACTS)
    parser.add_argument("--served-model")
    args = parser.parse_args()
    config = load_config(args.config, overrides_from(args))
    snapshot = load_dataset(config)
    run_id = args.run_id or datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
    publisher = publisher_module.build(
        publisher_module.Settings.from_env(), run_id, config.langfuse
    )
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    with EvaluationServer(
        config, snapshot, run_id, args.output, publisher, args.served_model
    ) as server:
        print(
            f"Smart Window eval bridge: http://127.0.0.1:4318 (run {run_id})",
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            publisher.close()


if __name__ == "__main__":
    try:
        main()
    except (publisher_module.PublisherError, ValueError) as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        sys.exit(2)
