import json
import shutil
from pathlib import Path
from unittest import mock

import pytest

from mozperftest.environment import METRICS
from mozperftest.metrics.eval import EvalMetrics
from mozperftest.metrics.exceptions import (
    EvalMetricsConfigurationError,
    EvalMetricsPayloadError,
)
from mozperftest.tests.support import get_running_env
from mozperftest.utils import load_class_from_path


@pytest.fixture
def recorded_scores():
    evaluator = load_class_from_path(
        "RecordedScores",
        Path(__file__).resolve().parents[4] / "toolkit/components/ml/eval/evals.py",
    )
    return evaluator(lambda message: None, {})


def test_recorded_scores_preserves_failures_and_score_coverage(recorded_scores):
    results = recorded_scores.run([
        {
            "scores": [{"name": "accuracy", "score": 0}],
            "unavailableScores": [{"name": "groundedness", "reason": "No evidence"}],
        },
        {
            "scores": [
                {"name": "accuracy", "score": 1},
                {"name": "groundedness", "score": 0},
            ],
        },
    ])
    metrics = {result["name"]: result for result in results}
    assert metrics["accuracy"]["values"] == [0, 1]
    assert metrics["accuracy_coverage"]["values"] == [1.0]
    assert metrics["groundedness"]["values"] == [0]
    assert metrics["groundedness_coverage"]["values"] == [0.5]
    assert all(result["lowerIsBetter"] is False for result in results)


def test_recorded_scores_reports_all_unavailable(recorded_scores):
    assert recorded_scores.run([
        {"scores": [], "unavailableScores": [{"name": "groundedness"}]}
    ]) == [
        {
            "name": "groundedness_coverage",
            "values": [0.0],
            "unit": "ratio",
            "lowerIsBetter": False,
        }
    ]


def test_recorded_scores_metrics_use_short_measurement_units(tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(tests=[], output=str(tmp_path))
    metadata.script = {"options": {"default": {"evaluations": {"RecordedScores": {}}}}}
    metadata.add_eval_payload(
        "test.js", [{"scores": [{"name": "extraction_coverage", "score": 1}]}]
    )
    try:
        result = env.layers[METRICS].layers[0].run(metadata)
        units = {metric["name"]: metric["unit"] for metric in result.get_results()}
        assert units == {
            "extraction_coverage": "score",
            "extraction_coverage_coverage": "ratio",
        }
    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@pytest.mark.parametrize(
    "payloads",
    [
        [],
        [{"error": "Timeout"}],
        [{"scores": [{"name": "accuracy", "error": "Scorer unavailable"}]}],
        [
            {
                "scores": [
                    {"name": "accuracy", "score": 1},
                    {"name": "accuracy", "score": 0},
                ]
            }
        ],
    ]
    + [
        [{"scores": [{"name": "accuracy", "score": value}]}]
        for value in (True, "1", None, float("nan"), float("inf"))
    ],
)
def test_recorded_scores_rejects_invalid_results(recorded_scores, payloads):
    with pytest.raises(ValueError):
        recorded_scores.run(payloads)


def eval_metrics_running_env(**kw):
    return get_running_env(flavor="eval-mochitest", **kw)


class MockBleuEval:
    name = "bleu"
    requirements = []

    def __init__(self, log, config):
        self.log = log
        self.config = config

    def run(self, payloads):
        return {
            "name": self.name,
            "values": [100.0 for _ in payloads],
            "lowerIsBetter": True,
        }


class MockBleuEvalReturnsList:
    name = "bleu"
    requirements = []

    def __init__(self, log, config):
        pass

    def run(self, payloads):
        return [
            {
                "name": self.name,
                "values": [100.0 for _ in payloads],
                "lowerIsBetter": True,
            }
        ]


class MockChrfEval:
    name = "chrF"
    requirements = []

    def __init__(self, log, config):
        pass

    def run(self, payloads):
        return {
            "name": self.name,
            "values": [95.0 for _ in payloads],
            "lowerIsBetter": True,
        }


def get_mock_eval_class(name, path):
    """Helper function for mocking load_class_from_path with multiple eval types."""
    if name == "TranslationsBleu":
        return MockBleuEval
    elif name == "TranslationsChrf":
        return MockChrfEval
    raise ImportError(f"Unknown eval class {name}")


@mock.patch("mozperftest.metrics.eval.load_class_from_path", return_value=MockBleuEval)
@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_processes_single_evaluation(mock_load_class, tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                }
            }
        }
    }

    metadata.add_eval_payload(
        "test_translation.js",
        [
            {"trg": "Hello world", "ref": "Hello world"},
            {"trg": "Goodbye world", "ref": "Goodbye world"},
        ],
    )

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        result_metadata = eval_metrics_layer.run(metadata)

        results = result_metadata.get_results()
        assert len(results) == 1
        result = results[0]
        assert result["name"] == "bleu"
        assert result["framework"]["name"] == "mozperftest"
        assert result["lowerIsBetter"] is True
        assert result["shouldAlert"] is False
        assert result["value"] is not None

        eval_file = tmp_path / "eval-bleu.json"
        assert eval_file.exists()
        eval_data = json.loads(eval_file.read_text())
        assert len(eval_data) == 2

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch(
    "mozperftest.metrics.eval.load_class_from_path", side_effect=get_mock_eval_class
)
@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_processes_multiple_evaluations(mock_load_class, tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                    "TranslationsChrf": {"shouldAlert": True, "alertThreshold": 5.0},
                }
            }
        }
    }

    metadata.add_eval_payload(
        "test_translation.js",
        [
            {"trg": "Hello world", "ref": "Hello world"},
        ],
    )

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        result_metadata = eval_metrics_layer.run(metadata)

        results = result_metadata.get_results()
        assert len(results) == 2

        bleu_result = next((r for r in results if r["name"] == "bleu"), None)
        assert bleu_result is not None
        assert bleu_result["shouldAlert"] is False
        assert "alertThreshold" not in bleu_result

        chrf_result = next((r for r in results if r["name"] == "chrF"), None)
        assert chrf_result is not None
        assert chrf_result["shouldAlert"] is True
        assert chrf_result["alertThreshold"] == 5.0

        assert (tmp_path / "eval-bleu.json").exists()
        assert (tmp_path / "eval-chrF.json").exists()

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch("mozperftest.metrics.eval.load_class_from_path", return_value=MockBleuEval)
@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_handles_multiple_tests(mock_load_class, tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                }
            }
        }
    }

    metadata.add_eval_payload(
        "test_translation1.js",
        [{"trg": "Hello world", "ref": "Hello world"}],
    )
    metadata.add_eval_payload(
        "test_translation2.js",
        [{"trg": "Goodbye world", "ref": "Goodbye world"}],
    )

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        eval_metrics_layer.run(metadata)

        eval_file = tmp_path / "eval-bleu.json"
        assert eval_file.exists()
        eval_data = json.loads(eval_file.read_text())
        assert len(eval_data) == 2
        assert any("test_translation1.js" in str(item) for item in eval_data)
        assert any("test_translation2.js" in str(item) for item in eval_data)

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_raises_on_missing_evaluations(tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {"options": {"default": {}}}

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        with pytest.raises(
            EvalMetricsConfigurationError, match="No evaluations were configured"
        ):
            eval_metrics_layer.run(metadata)

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_raises_on_missing_eval_class(tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "NonExistentEvalClass": {"shouldAlert": False},
                }
            }
        }
    }

    metadata.add_eval_payload("test.js", [{"trg": "test", "ref": "test"}])

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        with pytest.raises(ImportError, match="was found but it was not a valid class"):
            eval_metrics_layer.run(metadata)

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_raises_on_missing_payloads(tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                }
            }
        }
    }

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        with pytest.raises(
            EvalMetricsPayloadError, match="No eval payloads were found"
        ):
            eval_metrics_layer.run(metadata)

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch("mozperftest.metrics.eval.load_class_from_path", return_value=MockBleuEval)
@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_computes_summary_value(mock_load_class, tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                }
            }
        }
    }

    metadata.add_eval_payload(
        "test_translation.js",
        [
            {"trg": "Hello world", "ref": "Hello world"},
            {"trg": "Hello world", "ref": "Hello world"},
        ],
    )

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        result_metadata = eval_metrics_layer.run(metadata)

        results = result_metadata.get_results()
        assert len(results) == 1
        result = results[0]
        assert result["value"] is not None
        assert isinstance(result["value"], (int, float))

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch("mozperftest.metrics.eval.load_class_from_path", return_value=MockBleuEval)
@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_creates_output_directory(mock_load_class, tmp_path):
    output_dir = tmp_path / "nested" / "output" / "dir"
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(output_dir),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                }
            }
        }
    }

    metadata.add_eval_payload(
        "test_translation.js",
        [{"trg": "Hello world", "ref": "Hello world"}],
    )

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        eval_metrics_layer.run(metadata)

        assert output_dir.exists()
        assert (output_dir / "eval-bleu.json").exists()

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)


@mock.patch(
    "mozperftest.metrics.eval.load_class_from_path",
    return_value=MockBleuEvalReturnsList,
)
@mock.patch("mozperftest.test.mochitest.ON_TRY", new=False)
@mock.patch("mozperftest.utils.ON_TRY", new=False)
def test_eval_metrics_handles_list_result(mock_load_class, tmp_path):
    mach_cmd, metadata, env = eval_metrics_running_env(
        tests=[],
        output=str(tmp_path),
    )

    metadata.script = {
        "options": {
            "default": {
                "evaluations": {
                    "TranslationsBleu": {"shouldAlert": False},
                }
            }
        }
    }

    metadata.add_eval_payload(
        "test_translation.js",
        [{"trg": "Hello world", "ref": "Hello world"}],
    )

    try:
        metrics = env.layers[METRICS]
        eval_metrics_layer = metrics.layers[0]

        assert isinstance(eval_metrics_layer, EvalMetrics)

        result_metadata = eval_metrics_layer.run(metadata)

        results = result_metadata.get_results()
        assert len(results) == 1
        assert results[0]["name"] == "bleu"

    finally:
        shutil.rmtree(mach_cmd._mach_context.state_dir)
