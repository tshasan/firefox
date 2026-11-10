# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from pathlib import Path

import scoring


def score_dict(name, status, value=None, label=None, comment=""):
    score = {"name": name, "status": status, "comment": comment}
    if status == "scored":
        score["value"] = value
        if label is not None:
            score["label"] = label
    return score


def unavailable(name, comment):
    return score_dict(name, "unavailable", comment=comment)


def trace_error(name):
    return score_dict(
        name, "error", comment="Trace is incomplete or could not be serialized"
    )


def case_turn(case, record):
    turns = case.get("turns", [case])
    index = record.get("turnIndex", 0)
    return turns[index] if 0 <= index < len(turns) else case


class OfficeQAGrader:
    def __init__(self, snapshot):
        scorer = snapshot.scorer
        if not scorer:
            raise ValueError(
                "The officeqa grader requires metadata.scorer in the manifest"
            )
        if scorer.get("revision") != scoring.OFFICEQA_REVISION:
            raise ValueError("OfficeQA scorer revision does not match the trusted pin")
        path = (Path(snapshot.manifest_path).parent / scorer["path"]).resolve()
        self.scorer = scoring.OfficeQAScorer(path, scorer["sha256"])

    def score(self, record, case):
        try:
            return self.grade(record, case)
        except Exception as error:
            return [
                score_dict("officeqa_accuracy", "error", comment=str(error)),
                score_dict("extraction_coverage", "error", comment=str(error)),
            ]

    def grade(self, record, case):
        turn = case_turn(case, record)
        answer = record.get("answer") or ""
        if not answer.strip():
            accuracy = unavailable("officeqa_accuracy", "No answer was produced")
        else:
            result = self.scorer.score(record.get("reference", ""), answer)
            accuracy = score_dict(
                "officeqa_accuracy",
                "scored",
                result["score"],
                result["label"],
                result["explanation"],
            )
        if record.get("traceIncomplete"):
            return [accuracy, trace_error("extraction_coverage")]
        return [accuracy, self.coverage(record, case, turn)]

    def coverage(self, record, case, turn):
        required = turn.get("requiredSources", case.get("requiredSources", []))
        read_tool = any(
            call["name"] == "get_page_content" and call["executed"]
            for call in record["toolCalls"]
        )
        result = scoring.extraction_coverage(
            {"tabs": record.get("tabs") or [], "extractions": record["extractions"]},
            required,
            read_tool,
        )
        return score_dict(
            "extraction_coverage",
            "scored",
            result["score"],
            result["label"],
            result["explanation"],
        )


class ExpectedToolGrader:
    def score(self, record, case):
        name = "expected_tool_once"
        try:
            if record.get("traceIncomplete"):
                return [trace_error(name)]
            expected = case["expectedTool"]
            count = sum(
                call["name"] == expected["name"] and call["executed"]
                for call in record["toolCalls"]
            )
            passed = count == expected["count"]
            return [
                score_dict(
                    name,
                    "scored",
                    int(passed),
                    "pass" if passed else "fail",
                    f"Executed {expected['name']} {count} time(s); expected {expected['count']}.",
                )
            ]
        except Exception as error:
            return [score_dict(name, "error", comment=str(error))]


GRADERS = ("officeqa", "expected_tool")


def build(run_config, snapshot):
    if run_config.grader == "officeqa":
        return OfficeQAGrader(snapshot)
    return ExpectedToolGrader()
