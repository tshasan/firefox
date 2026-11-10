# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Loopback fake of the Langfuse endpoints used by publisher.py.

Routes, as hit by langfuse==5.2.0 and publisher.py:
  POST /api/public/otel/v1/traces      OTLP JSON, recorded in state.otel_posts
  POST /api/public/v2/datasets         create_dataset, upserts by name
  GET  /api/public/v2/datasets/<name>  get_dataset
  POST /api/public/dataset-items       create_dataset_item, upserts by id
  GET  /api/public/dataset-items       paginated item list for get_dataset
  POST /api/public/scores              create_score batch (list or object),
                                       upserts by score id
Anything else is answered with 404 and recorded in state.unhandled.

Run standalone with `python3.14 fake_langfuse.py --port 0`.
"""

import argparse
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

PROJECT_ID = "fake-project"
NOW = "2026-01-01T00:00:00.000Z"


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.otel_posts = []
        self.datasets = {}
        self.items = {}
        self.scores = {}
        self.unhandled = []

    def dataset_json(self, name):
        dataset = self.datasets[name]
        return {
            "id": dataset["id"],
            "name": name,
            "description": dataset["description"],
            "metadata": dataset["metadata"],
            "projectId": PROJECT_ID,
            "createdAt": NOW,
            "updatedAt": NOW,
        }

    def item_json(self, item):
        return {
            "id": item["id"],
            "status": "ACTIVE",
            "input": item["input"],
            "expectedOutput": item["expectedOutput"],
            "metadata": item["metadata"],
            "datasetId": self.datasets[item["datasetName"]]["id"],
            "datasetName": item["datasetName"],
            "createdAt": NOW,
            "updatedAt": NOW,
            "mediaReferences": [],
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw) if raw else None

    def do_POST(self):
        state = self.server.state
        path = urlparse(self.path).path
        body = self.body()
        with state.lock:
            if path == "/api/public/otel/v1/traces":
                state.otel_posts.append({
                    "headers": dict(self.headers.items()),
                    "body": body,
                })
                return self.reply(200, {})
            if path == "/api/public/v2/datasets":
                name = body["name"]
                existing = state.datasets.get(name)
                state.datasets[name] = {
                    "id": existing["id"]
                    if existing
                    else f"dataset-{len(state.datasets) + 1}",
                    "description": body.get("description"),
                    "metadata": body.get("metadata"),
                }
                return self.reply(200, state.dataset_json(name))
            if path == "/api/public/dataset-items":
                if body["datasetName"] not in state.datasets:
                    return self.reply(404, {"message": "dataset not found"})
                state.items[body["id"]] = body
                return self.reply(200, state.item_json(body))
            if path == "/api/public/scores":
                for score in body if isinstance(body, list) else [body]:
                    state.scores[score["id"]] = score
                return self.reply(200, {})
            state.unhandled.append(("POST", self.path, body))
        self.reply(404, {"message": "not found"})

    def do_GET(self):
        state = self.server.state
        parsed = urlparse(self.path)
        with state.lock:
            if parsed.path.startswith("/api/public/v2/datasets/"):
                name = unquote(parsed.path.rsplit("/", 1)[1])
                if name in state.datasets:
                    return self.reply(200, state.dataset_json(name))
                return self.reply(404, {"message": "dataset not found"})
            if parsed.path == "/api/public/dataset-items":
                name = parse_qs(parsed.query).get("datasetName", [""])[0]
                data = [
                    state.item_json(item)
                    for item in state.items.values()
                    if item["datasetName"] == name
                ]
                meta = {
                    "page": 1,
                    "limit": max(len(data), 1),
                    "totalItems": len(data),
                    "totalPages": 1,
                }
                return self.reply(200, {"data": data, "meta": meta})
            state.unhandled.append(("GET", self.path, None))
        self.reply(404, {"message": "not found"})


class FakeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.state = State()


@contextmanager
def fake_langfuse(port=0):
    server = FakeServer(port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", server.state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = FakeServer(args.port)
    print(f"http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
