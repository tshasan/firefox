# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import httpx
from publisher import PublisherError
from server import add_override_arguments, overrides_from, publishable_snapshot

from config import load as load_config
from config import load_dataset

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts/aiwindow-trace-eval"
BRIDGE = "http://127.0.0.1:4318"
TEST = "browser/components/aiwindow/models/tests/browser_eval/browser_eval_trace.js"
EVAL_OUTPUT = ARTIFACTS / "eval-output"
# Startup, fixture loading and shutdown happen outside the per-case clock.
HARNESS_SLACK_SECONDS = 600
# The bridge flushes queued Langfuse scores on SIGTERM before it exits.
BRIDGE_STOP_GRACE_SECONDS = 30


def harness_command(headless):
    command = [
        sys.executable,
        str(ROOT / "mach"),
        "eval",
        TEST,
        "--setpref=browser.smartwindow.trace.eval=true",
    ]
    if headless:
        command.append("--headless")
    return command


def collect_eval_artifacts(summary, destination, started):
    source = EVAL_OUTPUT
    browser_log = destination / "browser.log"
    if browser_log.is_file():
        marker = "Evaluation data written to "
        for line in browser_log.read_text().splitlines():
            if line.startswith(marker):
                source = (ROOT / line.removeprefix(marker)).parent
    target = destination / "eval"
    target.mkdir()
    names = ["browser_eval_trace-eval-data.json"]
    for metric in summary["metrics"]:
        names.extend([f"eval-{metric}.json", f"eval-{metric}_coverage.json"])
    paths = [source / name for name in names]
    paths.extend(source.glob("perfherder-data-*.json"))
    for path in paths:
        if path.is_file() and path.stat().st_mtime >= started:
            shutil.copyfile(path, target / path.name)
    if not (target / "browser_eval_trace-eval-data.json").is_file() or not any(
        target.glob("perfherder-data-*.json")
    ):
        raise RuntimeError("Firefox eval data or Perfherder artifacts are missing")


def served_model(client, endpoint):
    response = client.get(endpoint.rstrip("/") + "/models")
    response.raise_for_status()
    available = [item["id"] for item in response.json()["data"]]
    if len(available) != 1:
        raise RuntimeError(
            f"Set model.model; {endpoint} serves {len(available)} models: {available}"
        )
    return available[0]


def ready(client, url):
    try:
        return client.get(url, timeout=2).is_success
    except httpx.HTTPError:
        return False


def wait_ready(client, process, url, log, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Service exited with {process.returncode}; see {log}")
        if ready(client, url):
            return
        time.sleep(0.25)
    raise RuntimeError(f"Service did not become ready; see {log}")


def stop_process(process, grace=5):
    def send_signal(force=False):
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif force:
                process.kill()
            else:
                process.terminate()
        except ProcessLookupError:
            pass

    send_signal()
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass
    send_signal(force=True)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return False
    return True


def run_harness(command, environment, output, timeout):
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        stdout=output,
        stderr=subprocess.STDOUT,
        start_new_session=os.name == "posix",
    )
    status = {"timedOut": False, "interrupted": False}
    try:
        status["harnessExitCode"] = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        status.update(harnessExitCode=124, timedOut=True)
    except KeyboardInterrupt:
        status.update(harnessExitCode=130, interrupted=True)
    finally:
        if status["timedOut"] or status["interrupted"]:
            if not stop_process(process):
                status["cleanupError"] = "Browser process did not exit after SIGKILL"
    return status


def git_revision():
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=5
    ).strip()


def print_summary(summary, destination):
    print(
        f"Completed: {summary.get('completed', '?')}/{summary.get('total', '?')}"
        f" (failed: {summary.get('failed', '?')})"
    )
    if summary.get("timedOut"):
        print("Browser run timed out; reporting partial results.", file=sys.stderr)
    if summary.get("interrupted"):
        print("Browser run interrupted; reporting partial results.", file=sys.stderr)
    if summary.get("stopReason"):
        print(
            f"Stopped early: {summary['stopReason']} ({len(summary.get('skipped', []))} skipped)"
        )
    if summary.get("summaryError"):
        print(
            f"Could not retrieve partial results: {summary['summaryError']}",
            file=sys.stderr,
        )
    for name, metric in summary.get("metrics", {}).items():
        mean = metric["mean"]
        value = f"{100 * mean:.1f}%" if mean is not None else "unscored"
        print(
            f"{name}: {value} ({metric['scored']}/{metric['total']} scored, {metric['errors']} errors)"
        )
    print(f"Artifacts: {destination}")
    shown = set()
    for links in summary.get("links", []):
        for name, url in links.items():
            if name != "itemId" and url not in shown:
                shown.add(url)
                print(f"Langfuse {name}: {url}")
    publish_errors = [
        result["publishError"]
        for result in summary.get("results", [])
        if result.get("publishError")
    ]
    if publish_errors:
        print(
            f"Langfuse publishing failed for {len(publish_errors)} records: {publish_errors[0]}",
            file=sys.stderr,
        )


def main():
    parser = argparse.ArgumentParser(
        description="Run an evaluation suite through Firefox Smart Window."
    )
    add_override_arguments(parser)
    parser.add_argument("--mozconfig", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=ARTIFACTS,
        help="Directory that receives runs/<run-id>/",
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open the Langfuse dataset page when the run finishes",
    )
    args = parser.parse_args()
    run_id = args.run_id or datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id) or run_id in (".", ".."):
        parser.error("--run-id must be a simple filename")
    args.run_id = run_id
    cfg = load_config(args.config, overrides_from(args))
    snapshot = load_dataset(cfg)
    resolved = cfg.resolved()
    environment = dict(os.environ)
    if args.mozconfig:
        environment["MOZCONFIG"] = str(args.mozconfig.resolve())
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / "runs" / run_id
    if destination.exists():
        parser.error(
            f"Run directory already exists: {destination}; choose another --run-id"
        )
    destination.mkdir(parents=True)
    with httpx.Client(trust_env=False, follow_redirects=False, timeout=15) as client:
        if ready(client, BRIDGE + "/health"):
            raise RuntimeError(
                "An evaluation bridge is already using port 4318. Stop it before starting a new run."
            )
        served = None
        if cfg.model.kind == "custom" and not cfg.model.model:
            served = served_model(client, cfg.model.endpoint)
        published = publishable_snapshot(snapshot)
        (destination / "config.json").write_text(
            json.dumps(
                {
                    **resolved,
                    "runId": run_id,
                    "gitRevision": git_revision(),
                    "scorer": snapshot.scorer,
                    "servedModel": served,
                    "dataset": {
                        **resolved["dataset"],
                        "name": snapshot.name,
                        "manifest_sha256": snapshot.manifest_sha256,
                        "cases": published.cases,
                        "items": published.items,
                    },
                },
                indent=2,
            )
            + "\n"
        )
        command = [
            sys.executable,
            str(Path(__file__).with_name("server.py")),
            "--config",
            str(args.config.resolve()),
            "--run-id",
            run_id,
            "--output",
            str(destination),
        ]
        if served:
            command.extend(["--served-model", served])
        if args.limit is not None:
            command.extend(["--limit", str(args.limit)])
        if args.repetitions is not None:
            command.extend(["--repetitions", str(args.repetitions)])
        for case in args.case:
            command.extend(["--case", case])
        log = destination / "bridge.log"
        with log.open("w") as output_file:
            bridge = subprocess.Popen(
                command,
                cwd=ROOT,
                env=environment,
                stdout=output_file,
                stderr=subprocess.STDOUT,
                start_new_session=os.name == "posix",
            )
        try:
            wait_ready(client, bridge, BRIDGE + "/health", log)
            browser_log = destination / "browser.log"
            print(
                f"Running Firefox Smart Window; browser output: {browser_log}",
                flush=True,
            )
            with browser_log.open("w") as output_file:
                started = time.time()
                status = run_harness(
                    harness_command(not args.headful),
                    environment,
                    output_file,
                    cfg.limits.runtime_seconds + HARNESS_SLACK_SECONDS,
                )
            try:
                response = client.get(BRIDGE + "/summary")
                response.raise_for_status()
                summary = response.json()
            except (httpx.HTTPError, ValueError) as error:
                summary = {"summaryError": str(error)}
            summary.update(status)
            if not summary["harnessExitCode"] and not summary.get("summaryError"):
                try:
                    collect_eval_artifacts(summary, destination, started)
                except (OSError, RuntimeError) as error:
                    summary["artifactError"] = str(error)
            (destination / "summary.json").write_text(
                json.dumps(summary, indent=2) + "\n"
            )
            print_summary(summary, destination)
            if args.open:
                links = [
                    link for link in summary.get("links", []) if link.get("dataset")
                ]
                if links:
                    webbrowser.open(links[0]["dataset"])
                else:
                    print("Nothing to open: the run was not published to Langfuse")
            failed = bool(
                summary["harnessExitCode"]
                or summary.get("summaryError")
                or summary.get("artifactError")
                or summary.get("completed", 0) + summary.get("failed", 0)
                != summary.get("total")
                or summary.get("scoreErrors")
            )
            return int(failed)
        finally:
            if not stop_process(bridge, grace=BRIDGE_STOP_GRACE_SECONDS):
                print("Evaluation bridge did not exit after SIGKILL", file=sys.stderr)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        PublisherError,
        ValueError,
        RuntimeError,
        OSError,
        httpx.HTTPError,
        subprocess.TimeoutExpired,
    ) as error:
        print(f"Run could not complete: {error}", file=sys.stderr)
        sys.exit(1)
