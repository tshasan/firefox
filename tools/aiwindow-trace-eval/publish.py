# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Republish a saved run: python3.14 publish.py <run-dir>."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import publisher


def read_jsonl(path):
    return [
        json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()
    ]


def trace_id(payload):
    for resource in payload.get("resourceSpans", []):
        for scope in resource.get("scopeSpans", []):
            for span in scope.get("spans", []):
                return span.get("traceId")
    return None


def republish(run_dir, settings=None):
    run_dir = Path(run_dir)
    config = json.loads((run_dir / "config.json").read_text())
    run_id = config["runId"]
    dataset = config["dataset"]
    snapshot = SimpleNamespace(
        name=dataset["name"],
        manifest_sha256=dataset["manifest_sha256"],
        cases=dataset.get("cases", []),
        items=dataset.get("items", []),
    )
    mode = config.get("publish", {}).get("langfuse", "auto")
    if mode == "never":
        mode = "auto"
    settings = settings or publisher.Settings.from_env()
    pub = publisher.build(settings, run_id, mode)
    traces = {
        trace_id(payload): payload for payload in read_jsonl(run_dir / "traces.jsonl")
    }
    records = read_jsonl(run_dir / "results.jsonl")
    ref = pub.publish_dataset(snapshot)
    dataset_error = pub.dataset_error
    for record in records:
        record.pop("publishError", None)
        experiment = publisher.experiment_for(
            run_id, record.get("repetition", 1), ref, snapshot
        )
        payload = traces.get(record.get("traceId"))
        if payload is None:
            publisher.record_error(record, "trace missing from traces.jsonl")
        else:
            pub.publish_trace(record, payload, experiment)
        pub.publish_scores(record, experiment)
        if dataset_error:
            publisher.record_error(record, dataset_error)
    pub.close()
    (run_dir / "results.jsonl").write_text(
        "".join(json.dumps(record) + "\n" for record in records)
    )
    return records


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: publish.py <run-dir>", file=sys.stderr)
        return 2
    try:
        records = republish(argv[0])
    except Exception as error:
        print(f"publish failed: {error}", file=sys.stderr)
        return 1
    failed = [r for r in records if r.get("publishError")]
    for record in failed:
        print(f"{record.get('itemId')}: {record['publishError']}", file=sys.stderr)
    print(f"published {len(records) - len(failed)}/{len(records)} records")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
