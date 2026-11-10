# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import yaml
from graders import GRADERS

MODEL_KINDS = ("firefox", "custom")
LANGFUSE_MODES = ("auto", "always", "never")


class ConfigError(ValueError):
    def __init__(self, field, message):
        super().__init__(f"{field}: {message}")
        self.field = field
        self.message = message


@dataclass
class ModelConfig:
    kind: str
    choice: str = ""
    endpoint: str = ""
    model: str = ""
    api_key_env: str = ""
    parameters: dict = field(default_factory=dict)


@dataclass
class ToolPolicy:
    allowed_tools: list = field(
        default_factory=lambda: ["get_open_tabs", "get_page_content"]
    )
    restrict_urls_to_sources: bool = True


@dataclass
class Limits:
    cases: int | None = None
    repetitions: int = 1
    runtime_seconds: int = 3600
    case_timeout_seconds: int = 300
    model_calls_per_case: int = 8
    total_tokens: int | None = 500000
    max_completion_tokens: int = 4096


@dataclass
class RunConfig:
    path: Path
    name: str
    manifest: Path
    case_ids: list
    model: ModelConfig
    tool_policy: ToolPolicy
    grader: str
    limits: Limits
    langfuse: str
    run_id: str | None = None
    headful: bool = False

    def resolved(self):
        return {
            "schemaVersion": 1,
            "name": self.name,
            "path": str(self.path),
            "runId": self.run_id,
            "headful": self.headful,
            "dataset": {"manifest": str(self.manifest), "cases": list(self.case_ids)},
            "model": {
                "kind": self.model.kind,
                "choice": self.model.choice,
                "endpoint": self.model.endpoint,
                "model": self.model.model,
                "apiKeyEnv": self.model.api_key_env,
                "parameters": dict(self.model.parameters),
            },
            "toolPolicy": {
                "allowedTools": list(self.tool_policy.allowed_tools),
                "restrictUrlsToSources": self.tool_policy.restrict_urls_to_sources,
            },
            "grader": self.grader,
            "limits": {
                "cases": self.limits.cases,
                "repetitions": self.limits.repetitions,
                "runtimeSeconds": self.limits.runtime_seconds,
                "caseTimeoutSeconds": self.limits.case_timeout_seconds,
                "modelCallsPerCase": self.limits.model_calls_per_case,
                "totalTokens": self.limits.total_tokens,
                "maxCompletionTokens": self.limits.max_completion_tokens,
            },
            "publish": {"langfuse": self.langfuse},
        }


@dataclass(frozen=True)
class DatasetSnapshot:
    name: str
    manifest_path: Path
    manifest_sha256: str
    metadata: dict
    scorer: dict | None
    cases: tuple
    items: tuple

    def item_id(self, case_id, turn_index=0):
        return item_id(self.name, case_id, turn_index)

    def case(self, case_id):
        return next((case for case in self.cases if case["id"] == case_id), None)

    def expected_keys(self, repetitions):
        return [
            (item["caseId"], item["turnIndex"], repetition)
            for repetition in range(1, repetitions + 1)
            for item in self.items
        ]


def item_id(name, case_id, turn_index):
    return f"{name}:{case_id}:{turn_index}"


def mapping(value, name):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(name, "must be a mapping")
    return value


def positive_int(value, name, nullable=False):
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ConfigError(name, "must be a positive integer")
    return value


def string(value, name):
    if not isinstance(value, str):
        raise ConfigError(name, "must be a string")
    return value


def unknown_keys(data, allowed, name):
    extra = sorted(set(data) - set(allowed))
    if extra:
        raise ConfigError(f"{name}.{extra[0]}" if name else extra[0], "unknown field")


def parse_model(data):
    data = mapping(data, "model")
    unknown_keys(
        data,
        ("kind", "choice", "endpoint", "model", "apiKeyEnv", "parameters"),
        "model",
    )
    kind = data.get("kind")
    if kind not in MODEL_KINDS:
        raise ConfigError("model.kind", f"must be one of {', '.join(MODEL_KINDS)}")
    model = ModelConfig(
        kind=kind,
        choice=string(data.get("choice", ""), "model.choice"),
        endpoint=string(data.get("endpoint", ""), "model.endpoint"),
        model=string(data.get("model", ""), "model.model"),
        api_key_env=string(data.get("apiKeyEnv", ""), "model.apiKeyEnv"),
        parameters=mapping(data.get("parameters"), "model.parameters"),
    )
    if kind == "firefox" and not model.choice:
        raise ConfigError("model.choice", "is required when model.kind is firefox")
    if kind == "custom":
        parsed = urlparse(model.endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ConfigError(
                "model.endpoint",
                "must be an http or https URL when model.kind is custom",
            )
    return model


def parse_limits(data):
    data = mapping(data, "limits")
    unknown_keys(
        data,
        (
            "cases",
            "repetitions",
            "runtimeSeconds",
            "caseTimeoutSeconds",
            "modelCallsPerCase",
            "totalTokens",
            "maxCompletionTokens",
        ),
        "limits",
    )
    defaults = Limits()
    limits = Limits(
        cases=positive_int(data.get("cases"), "limits.cases", nullable=True),
        repetitions=positive_int(
            data.get("repetitions", defaults.repetitions), "limits.repetitions"
        ),
        runtime_seconds=positive_int(
            data.get("runtimeSeconds", defaults.runtime_seconds),
            "limits.runtimeSeconds",
        ),
        case_timeout_seconds=positive_int(
            data.get("caseTimeoutSeconds", defaults.case_timeout_seconds),
            "limits.caseTimeoutSeconds",
        ),
        model_calls_per_case=positive_int(
            data.get("modelCallsPerCase", defaults.model_calls_per_case),
            "limits.modelCallsPerCase",
        ),
        total_tokens=positive_int(
            data.get("totalTokens", defaults.total_tokens),
            "limits.totalTokens",
            nullable=True,
        ),
        max_completion_tokens=positive_int(
            data.get("maxCompletionTokens", defaults.max_completion_tokens),
            "limits.maxCompletionTokens",
        ),
    )
    return limits


def parse_tool_policy(data):
    data = mapping(data, "toolPolicy")
    unknown_keys(data, ("allowedTools", "restrictUrlsToSources"), "toolPolicy")
    default = ToolPolicy()
    tools = data.get("allowedTools", default.allowed_tools)
    if not isinstance(tools, list) or not all(isinstance(tool, str) for tool in tools):
        raise ConfigError("toolPolicy.allowedTools", "must be a list of strings")
    restrict = data.get("restrictUrlsToSources", default.restrict_urls_to_sources)
    if not isinstance(restrict, bool):
        raise ConfigError("toolPolicy.restrictUrlsToSources", "must be a boolean")
    return ToolPolicy(list(tools), restrict)


def load(path, overrides=None):
    overrides = dict(overrides or {})
    unknown = sorted(
        set(overrides) - {"limit", "cases", "repetitions", "run_id", "headful"}
    )
    if unknown:
        raise ConfigError(unknown[0], "unknown override")
    path = Path(path).expanduser().resolve()
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ConfigError(str(path), f"cannot read config: {error}") from error
    except yaml.YAMLError as error:
        raise ConfigError(str(path), f"invalid YAML: {error}") from error
    data = mapping(data, str(path))
    unknown_keys(
        data,
        (
            "schemaVersion",
            "name",
            "dataset",
            "model",
            "toolPolicy",
            "grader",
            "limits",
            "publish",
        ),
        "",
    )
    if data.get("schemaVersion") != 1:
        raise ConfigError("schemaVersion", "must be 1")
    name = data.get("name")
    if not isinstance(name, str) or not name:
        raise ConfigError("name", "must be a non-empty string")

    dataset = mapping(data.get("dataset"), "dataset")
    unknown_keys(dataset, ("manifest", "cases"), "dataset")
    manifest = dataset.get("manifest")
    if not isinstance(manifest, str) or not manifest:
        raise ConfigError("dataset.manifest", "must be a path")
    manifest = (path.parent / manifest).resolve()
    if not manifest.is_file():
        raise ConfigError("dataset.manifest", f"file not found: {manifest}")
    case_ids = dataset.get("cases") or []
    if not isinstance(case_ids, list) or not all(isinstance(c, str) for c in case_ids):
        raise ConfigError("dataset.cases", "must be a list of case ids")

    grader = data.get("grader")
    if grader not in GRADERS:
        raise ConfigError("grader", f"must be one of {', '.join(GRADERS)}")

    publish = mapping(data.get("publish"), "publish")
    unknown_keys(publish, ("langfuse",), "publish")
    langfuse = publish.get("langfuse", "auto")
    if langfuse not in LANGFUSE_MODES:
        raise ConfigError(
            "publish.langfuse", f"must be one of {', '.join(LANGFUSE_MODES)}"
        )

    limits = parse_limits(data.get("limits"))
    if overrides.get("limit") is not None:
        limits.cases = positive_int(overrides["limit"], "limit")
    if overrides.get("repetitions") is not None:
        limits.repetitions = positive_int(overrides["repetitions"], "repetitions")
    if overrides.get("cases"):
        case_ids = list(overrides["cases"])

    return RunConfig(
        path=path,
        name=name,
        manifest=manifest,
        case_ids=case_ids,
        model=parse_model(data.get("model")),
        tool_policy=parse_tool_policy(data.get("toolPolicy")),
        grader=grader,
        limits=limits,
        langfuse=langfuse,
        run_id=overrides.get("run_id"),
        headful=bool(overrides.get("headful", False)),
    )


def load_dataset(run_config):
    raw = run_config.manifest.read_bytes()
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise ConfigError(
            "dataset.manifest", f"invalid JSON in {run_config.manifest}: {error}"
        ) from error
    if isinstance(data, dict):
        metadata = data.get("metadata", {})
        cases = data.get("scenarios")
    else:
        metadata, cases = {}, data
    if not isinstance(cases, list) or not cases:
        raise ConfigError("dataset.manifest", "must contain at least one scenario")
    ids = [case.get("id") for case in cases]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and i for i in ids):
        raise ConfigError(
            "dataset.manifest", "scenario ids must be unique non-empty strings"
        )
    name = metadata.get("name") or run_config.manifest.parent.name

    if run_config.case_ids:
        unknown = [case for case in run_config.case_ids if case not in ids]
        if unknown:
            raise ConfigError("dataset.cases", f"unknown case ids: {unknown}")
        cases = [case for case in cases if case["id"] in run_config.case_ids]
    if run_config.limits.cases:
        cases = cases[: run_config.limits.cases]
    cases = tuple(cases)

    items = []
    for case in cases:
        for turn_index in range(len(case.get("turns", [case]))):
            items.append({
                "caseId": case["id"],
                "turnIndex": turn_index,
                "itemId": item_id(name, case["id"], turn_index),
            })
    return DatasetSnapshot(
        name=name,
        manifest_path=run_config.manifest,
        manifest_sha256=hashlib.sha256(raw).hexdigest(),
        metadata=metadata,
        scorer=metadata.get("scorer"),
        cases=cases,
        items=tuple(items),
    )
