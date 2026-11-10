# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Start or stop the fully local demo stack: Podman VM, Langfuse, llama-server.

Usage: python3.14 local_stack.py up|down|status
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts/aiwindow-trace-eval"
COMPOSE_DIR = Path(__file__).resolve().parent / "local"
COMPOSE_PROJECT = "langfuse"
COMPOSE = [
    "podman-compose",
    "-p",
    COMPOSE_PROJECT,
    "--env-file",
    "langfuse.env",
    "-f",
    "docker-compose.yml",
]
COMPOSE_SERVICES = (
    "postgres",
    "redis",
    "clickhouse",
    "minio",
    "langfuse-worker",
    "langfuse-web",
)
MACHINE = "langfuse"
LANGFUSE_URL = "http://127.0.0.1:3000"
PUBLIC_KEY = "pk-lf-smartwindow-local"
SECRET_KEY = "sk-lf-smartwindow-local"
USER_EMAIL = "demo@example.com"
USER_PASSWORD = "smartwindow-demo-1"
MODEL_URL = "http://127.0.0.1:8080/v1"
MODEL_COMMAND = [
    "llama-server",
    "-hf",
    "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M",
    "--no-mmproj",
    "--host",
    "127.0.0.1",
    "--port",
    "8080",
    "-c",
    "32768",
    "-np",
    "1",
    "--alias",
    "Qwen3-4B-Instruct-2507-Q4_K_M",
    "--jinja",
]
MODEL_PID = ARTIFACTS / "llama-server.pid"
MODEL_LOG = ARTIFACTS / "llama-server.log"


def env():
    return {
        "LANGFUSE_PUBLIC_KEY": PUBLIC_KEY,
        "LANGFUSE_SECRET_KEY": SECRET_KEY,
        "LANGFUSE_BASE_URL": LANGFUSE_URL,
    }


def http_ok(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status < 400
    except (urllib.error.URLError, OSError, ValueError):
        return False


def wait_for(url, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if http_ok(url):
            return
        time.sleep(2)
    raise RuntimeError(f"{what} did not become ready within {seconds}s")


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def machine_state():
    output = run(["podman", "machine", "list", "--format", "json"], capture_output=True)
    for machine in json.loads(output.stdout or "[]"):
        if machine.get("Name", "").rstrip("*") == MACHINE:
            return "running" if machine.get("Running") else "stopped"
    return "missing"


def ensure_machine():
    state = machine_state()
    if state == "missing":
        print("Creating the Podman VM (one-time image download)...", flush=True)
        run([
            "podman",
            "machine",
            "init",
            "--cpus",
            "4",
            "--memory",
            "8192",
            "--disk-size",
            "40",
            MACHINE,
        ])
    if state != "running":
        print("Starting the Podman VM...", flush=True)
        run(["podman", "machine", "start", MACHINE])


def ensure_langfuse():
    if http_ok(LANGFUSE_URL + "/api/public/health"):
        return
    ensure_machine()
    print("Starting Langfuse (first start pulls images)...", flush=True)
    run([*COMPOSE, "up", "-d", *COMPOSE_SERVICES], cwd=COMPOSE_DIR)
    wait_for(LANGFUSE_URL + "/api/public/health", 600, "Langfuse")


def ensure_model():
    if http_ok(MODEL_URL + "/models"):
        return
    print("Starting llama-server (first start downloads the model)...", flush=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with MODEL_LOG.open("a") as log:
        process = subprocess.Popen(
            MODEL_COMMAND,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    MODEL_PID.write_text(f"{process.pid}\n")
    wait_for(MODEL_URL + "/models", 1800, "llama-server")


def check_tools():
    missing = [
        tool
        for tool in ("podman", "podman-compose", "llama-server")
        if not shutil.which(tool)
    ]
    if missing:
        raise RuntimeError(
            f"missing {', '.join(missing)}; run: brew install podman podman-compose llama.cpp"
        )


def up():
    check_tools()
    ensure_langfuse()
    ensure_model()
    print(f"Langfuse: {LANGFUSE_URL} (login {USER_EMAIL} / {USER_PASSWORD})")
    print(f"Model: {MODEL_URL}")
    return env()


def stop_model():
    if not MODEL_PID.is_file():
        return
    try:
        os.killpg(int(MODEL_PID.read_text().strip()), signal.SIGTERM)
    except (ProcessLookupError, ValueError, PermissionError):
        pass
    MODEL_PID.unlink()


def down():
    stop_model()
    if machine_state() == "running":
        run([*COMPOSE, "down"], cwd=COMPOSE_DIR)
    if machine_state() == "running":
        run(["podman", "machine", "stop", MACHINE])
    print("Local stack stopped; Langfuse data is kept in the Podman volumes.")


def status():
    print(f"Podman VM: {machine_state()}")
    langfuse = "up" if http_ok(LANGFUSE_URL + "/api/public/health") else "down"
    print(f"Langfuse: {langfuse} ({LANGFUSE_URL})")
    model = "up" if http_ok(MODEL_URL + "/models") else "down"
    print(f"Model: {model} ({MODEL_URL})")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("up", "down", "status"))
    args = parser.parse_args(argv)
    try:
        {"up": up, "down": down, "status": status}[args.action]()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"Local stack: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
