# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Publishes Smart Window eval runs to Langfuse.

Datasets, dataset items and scores go through the Langfuse SDK. Traces are
posted as OTLP/HTTP JSON so the collector's spans keep their original ids.
"""

import base64
import copy
import hashlib
import json
import os
import time
from dataclasses import dataclass

import httpx
from scoring import spans

OTEL_PATH = "/api/public/otel/v1/traces"
ATTEMPTS = 3
RETRY_BACKOFF = (0.5, 1.0)


class PublisherError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    public_key: str
    secret_key: str
    base_url: str

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        public_key = env.get("LANGFUSE_PUBLIC_KEY", "").strip()
        secret_key = env.get("LANGFUSE_SECRET_KEY", "").strip()
        if not public_key or not secret_key:
            return None
        base_url = (
            env.get("LANGFUSE_BASE_URL", "").strip() or "https://cloud.langfuse.com"
        )
        return cls(public_key, secret_key, base_url.rstrip("/"))


def experiment_name(run_id, repetition):
    return run_id if repetition <= 1 else f"{run_id}-rep{repetition}"


def experiment_for(run_id, repetition, dataset_ref, snapshot):
    name = experiment_name(run_id, repetition)
    return {
        "id": name,
        "name": name,
        "dataset_id": (dataset_ref or {}).get("id") or snapshot.name,
        "run_group": run_id,
        "metadata": {
            "run_group": run_id,
            "repetition": str(repetition),
            "dataset": snapshot.name,
            "dataset_sha256": snapshot.manifest_sha256,
        },
    }


def score_id(run_id, item_id, repetition, name):
    key = "|".join([run_id, item_id, str(repetition), name])
    return hashlib.sha256(key.encode()).hexdigest()[:32]


def record_error(record, error):
    message = str(error) or type(error).__name__
    existing = record.get("publishError")
    record["publishError"] = f"{existing}; {message}" if existing else message


def string_attribute(key, value):
    return {"key": key, "value": {"stringValue": value}}


def set_attributes(span, items):
    keys = {item["key"] for item in items}
    span["attributes"] = [
        item for item in span.get("attributes", []) if item["key"] not in keys
    ] + items


class NullPublisher:
    dataset_error = None

    def publish_dataset(self, snapshot):
        return None

    def publish_trace(self, record, otlp_payload, experiment):
        return None

    def publish_scores(self, record, experiment):
        return None

    def flush(self):
        return None

    def close(self):
        return None

    def links(self, record):
        return {}


class LangfusePublisher:
    def __init__(self, settings, run_id):
        self.settings = settings
        self.run_id = run_id
        self.project_id = None
        self.dataset_ref = None
        self.dataset_error = None
        self._client = None
        self._http = httpx.Client(trust_env=False, timeout=15)

    @property
    def client(self):
        if self._client is None:
            from langfuse import Langfuse

            self._client = Langfuse(
                public_key=self.settings.public_key,
                secret_key=self.settings.secret_key,
                base_url=self.settings.base_url,
            )
        return self._client

    def publish_dataset(self, snapshot):
        try:
            return self._publish_dataset(snapshot)
        except Exception as error:
            self.dataset_error = f"dataset: {error}"
            return None

    def _publish_dataset(self, snapshot):
        dataset = self.client.create_dataset(
            name=snapshot.name,
            description=f"Smart Window eval dataset {snapshot.name}",
            metadata={"manifest_sha256": snapshot.manifest_sha256},
        )
        for item in snapshot.items:
            self.client.create_dataset_item(
                dataset_name=snapshot.name,
                id=item["itemId"],
                input=item.get("input"),
                expected_output=item.get("expectedOutput"),
                metadata=item.get("metadata"),
            )
        self.project_id = getattr(dataset, "project_id", None)
        self.dataset_ref = {
            "id": dataset.id,
            "name": snapshot.name,
            "project_id": self.project_id,
        }
        return self.dataset_ref

    def decorate(self, record, otlp_payload, experiment):
        payload = copy.deepcopy(otlp_payload)
        root_id = record.get("rootSpanId")
        shared = [
            string_attribute("langfuse.experiment.id", experiment["id"]),
            string_attribute("langfuse.experiment.name", experiment["name"]),
            string_attribute(
                "langfuse.experiment.dataset.id", experiment["dataset_id"]
            ),
            string_attribute("langfuse.environment", "experiment"),
            string_attribute("langfuse.experiment.item.id", record["itemId"]),
            string_attribute("langfuse.experiment.item.root_observation_id", root_id),
        ] + [
            string_attribute(f"langfuse.experiment.metadata.{key}", str(value))
            for key, value in experiment["metadata"].items()
        ]
        root = None
        for span in spans(payload):
            set_attributes(span, shared)
            if span.get("spanId") == root_id:
                root = span
        if root is None:
            raise PublisherError(f"root span {root_id} not found in trace")
        set_attributes(
            root,
            [
                string_attribute(
                    "langfuse.observation.input", record.get("prompt") or ""
                ),
                string_attribute(
                    "langfuse.observation.output", record.get("answer") or ""
                ),
                string_attribute(
                    "langfuse.experiment.item.expected_output",
                    json.dumps(record.get("reference")),
                ),
            ],
        )
        for resource in payload.get("resourceSpans", []):
            resource_info = resource.setdefault("resource", {})
            resource_info.setdefault("attributes", []).append(
                string_attribute("langfuse.environment", "experiment")
            )
        return payload

    def post(self, payload):
        token = base64.b64encode(
            f"{self.settings.public_key}:{self.settings.secret_key}".encode()
        ).decode()
        headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
            "x-langfuse-ingestion-version": "4",
        }
        url = self.settings.base_url + OTEL_PATH
        last = None
        for attempt in range(ATTEMPTS):
            if attempt:
                time.sleep(RETRY_BACKOFF[attempt - 1])
            try:
                response = self._http.post(url, json=payload, headers=headers)
            except httpx.HTTPError as error:
                last = error
                continue
            if response.status_code < 400:
                return
            last = PublisherError(
                f"OTLP ingestion HTTP {response.status_code}: {response.text[:200]}"
            )
            if response.status_code < 500:
                break
        raise last

    def publish_trace(self, record, otlp_payload, experiment):
        try:
            self.post(self.decorate(record, otlp_payload, experiment))
        except Exception as error:
            record_error(record, f"trace: {error}")

    def publish_scores(self, record, experiment):
        try:
            for score in record.get("scores") or []:
                if score.get("status") != "scored" or score.get("value") is None:
                    continue
                self.client.create_score(
                    name=score["name"],
                    value=float(score["value"]),
                    trace_id=record["traceId"],
                    observation_id=record["rootSpanId"],
                    score_id=score_id(
                        self.run_id,
                        record["itemId"],
                        record.get("repetition", 1),
                        score["name"],
                    ),
                    comment=score.get("comment"),
                    data_type="NUMERIC",
                    environment="experiment",
                    metadata={
                        "label": score.get("label"),
                        "experiment": experiment["name"],
                        "run_group": experiment["run_group"],
                    },
                )
        except Exception as error:
            record_error(record, f"scores: {error}")

    def flush(self):
        try:
            if self._client is not None:
                self._client.flush()
        except Exception:
            pass

    def links(self, record):
        if not self.project_id or not record.get("traceId"):
            return {}
        base = f"{self.settings.base_url}/project/{self.project_id}"
        links = {"trace": f"{base}/traces/{record['traceId']}"}
        if self.dataset_ref:
            links["dataset"] = f"{base}/datasets/{self.dataset_ref['id']}"
        return links

    def close(self):
        self.flush()
        self._http.close()
        if self._client is not None:
            try:
                self._client.shutdown()
            except Exception:
                pass


def build(settings, run_id, publish_mode="auto"):
    if publish_mode == "never":
        return NullPublisher()
    if settings is None:
        if publish_mode == "always":
            raise PublisherError(
                "publish.langfuse is 'always' but LANGFUSE_PUBLIC_KEY and "
                "LANGFUSE_SECRET_KEY are not set"
            )
        return NullPublisher()
    return LangfusePublisher(settings, run_id)
