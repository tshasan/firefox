#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import argparse
import hashlib
import html
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

MARKER = "SALIENCE_BENCHMARK "


def normalize(text):
    return " ".join(text.casefold().split())


def metrics(text, reference):
    predicted = Counter(re.findall(r"\w+", normalize(text)))
    expected = Counter(re.findall(r"\w+", normalize(reference)))
    overlap = sum((predicted & expected).values())
    precision = overlap / predicted.total() if predicted else float(not expected)
    recall = overlap / expected.total() if expected else float(not predicted)
    return {
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall)
        if precision + recall
        else 0,
    }


def read_records(path):
    records = {}
    corpus_counts = Counter()
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            message = line
        else:
            if (
                entry.get("action") == "test_end"
                and "salience" in entry.get("test", "")
                and "benchmark" in entry.get("test", "")
                and entry.get("status") != "PASS"
            ):
                raise ValueError(f"Benchmark test failed: {entry['test']}")
            message = entry.get("message", "")
        if MARKER not in message:
            continue
        record = json.loads(message.split(MARKER, 1)[1])
        case_id = record["reference"]["id"]
        corpus = record["corpus"]
        key = (corpus, case_id)
        if key in records:
            raise ValueError(f"Duplicate case: {case_id}; use a single benchmark run")
        records[key] = record
        corpus_counts[corpus] += 1
    if not records or any(
        r["caseCount"] != corpus_counts[r["corpus"]] for r in records.values()
    ):
        raise ValueError("Incomplete benchmark log; finish all cases before reporting")
    for (_, case_id), record in records.items():
        expected = {
            (mode, budget)
            for mode in ("dom", "reader", "salience")
            for budget in record.get("sufficientLengths", [None, 1000])
        }
        actual = [(o["mode"], o["sufficientLength"]) for o in record["outputs"]]
        if len(actual) != len(expected) or set(actual) != expected:
            raise ValueError(f"Incomplete or duplicate variants for {case_id}")
    return list(records.values())


def score(records, tokenizer=None):
    rows = []
    for record in records:
        page = record["reference"]
        for output in record["outputs"]:
            text = normalize(output["text"])
            questions = page["qa"]
            survival = [
                all(normalize(evidence) in text for evidence in question["evidence"])
                for question in questions
            ]
            row = {
                "id": page["id"],
                "corpus": record["corpus"],
                "type": page["type"],
                "difficulty": page["difficulty"],
                **output,
                **metrics(output["text"], page["expected"]),
                "evidence_recall": statistics.mean(survival),
                "missing_questions": [
                    q["question"] for q, kept in zip(questions, survival) if not kept
                ],
                "missing_required": [
                    s for s in page.get("required", []) if normalize(s) not in text
                ],
                "unwanted_hits": [s for s in page["unwanted"] if normalize(s) in text],
                "characters": len(output["text"]),
                "median_ms": statistics.median(output["times"]),
            }
            required_count = len(page.get("required", []))
            row["required_recall"] = (
                1 - len(row["missing_required"]) / required_count
                if required_count
                else None
            )
            if tokenizer:
                row["tokens"] = len(
                    tokenizer.encode(output["text"], add_special_tokens=False).ids
                )
                reference_tokens = len(
                    tokenizer.encode(page["expected"], add_special_tokens=False).ids
                )
                row["token_ratio"] = row["tokens"] / reference_tokens
            rows.append(row)
    return rows


def render(records, rows, tokenizer_info=None):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["corpus"], row["mode"], row["sufficientLength"])].append(row)
    table = []
    for (corpus, mode, budget), group in sorted(
        groups.items(),
        key=lambda item: (
            item[0][0],
            item[0][2] if item[0][2] is not None else float("inf"),
            item[0][1],
        ),
    ):
        values = [corpus, mode, str(budget or "Full"), str(len(group))]
        values += [
            f"{statistics.mean(r[key] for r in group):.1%}"
            for key in ("evidence_recall", "precision", "recall", "f1")
        ]
        values += [
            f"{statistics.mean(r['characters'] for r in group):.0f}",
            f"{statistics.median(r['median_ms'] for r in group):.2f}",
            str(sum(len(r["unwanted_hits"]) for r in group)),
        ]
        required = [
            r["required_recall"] for r in group if r["required_recall"] is not None
        ]
        values.append(f"{statistics.mean(required):.1%}" if required else "—")
        if "tokens" in group[0]:
            values += [
                f"{statistics.mean(r['tokens'] for r in group):.0f}",
                f"{statistics.mean(r['token_ratio'] for r in group):.2f}",
            ]
        table.append(
            "<tr>" + "".join(f"<td>{html.escape(v)}</td>" for v in values) + "</tr>"
        )
    headings = [
        "Corpus",
        "Mode",
        "Character target",
        "Cases",
        "Evidence recall",
        "Precision",
        "Recall",
        "F1",
        "Mean characters",
        "Median ms",
        "Unwanted hits",
        "Required snippet recall",
    ]
    if "tokens" in rows[0]:
        headings += ["Mean tokens", "Token/reference ratio"]
    details = []
    for record in records:
        page = record["reference"]
        corpus = record["corpus"]
        case_rows = [r for r in rows if r["id"] == page["id"] and r["corpus"] == corpus]
        missing = any(
            r["missing_questions"] for r in case_rows if r["mode"] == "salience"
        )
        search_text = html.escape(
            f"{page['id']} {page.get('title', '')} {page['source']}".lower(), quote=True
        )
        source = html.escape(page["source"])
        if page["source"].startswith(("https://", "http://")):
            source = f'<a href="{source}">{source}</a>'
        content = [
            f'<section class="case" data-corpus="{html.escape(corpus, quote=True)}" data-missing="{str(missing).lower()}" data-search="{search_text}">',
            f"<h2>{html.escape(page['id'])}: {html.escape(page.get('title', page['type']))}</h2>",
            f"<p>{html.escape(corpus)} / {html.escape(page['type'])} / {html.escape(page['difficulty'])}</p>",
            f"<p>{html.escape(record.get('condition', 'Authored rendered fixture'))}</p>",
            f"<p>{html.escape(page.get('notes', ''))}</p>",
            f"<p>Source: {source}. License: {html.escape(page['license'])}.</p>",
            f"<p>Snapshot SHA-256: {html.escape(page.get('sha256', 'not applicable'))}. Viewport: {html.escape(json.dumps(record.get('viewport')))}.</p>",
            "<details><summary>Reference text</summary>",
            f"<pre>{html.escape(page['expected'])}</pre></details>",
            "<h3>Questions and required evidence</h3><ul>",
        ]
        for q in page["qa"]:
            content.append(
                f"<li>{html.escape(q['question'])}: {html.escape('; '.join(q['evidence']))}</li>"
            )
        content.append("</ul>")
        for row in case_rows:
            title = f"{row['mode']} / {row['sufficientLength'] or 'full'}: evidence {row['evidence_recall']:.0%}, F1 {row['f1']:.2f}"
            warmup = (
                f" Warm-up: {row['warmup_ms']:.2f} ms." if "warmup_ms" in row else ""
            )
            content.append(
                f"<details><summary>{html.escape(title)}</summary><p>{row['characters']} characters; {row['median_ms']:.2f} ms.{warmup}</p><p>Missing questions: {html.escape('; '.join(row['missing_questions']) or 'none')}. Unwanted: {html.escape('; '.join(row['unwanted_hits']) or 'none')}.</p><p>Missing required snippets: {html.escape('; '.join(row['missing_required']) or 'none')}.</p><pre>{html.escape(row['text'])}</pre></details>"
            )
        content.append("</section>")
        details.append("\n".join(content))
    header = "".join(f'<th scope="col">{html.escape(h)}</th>' for h in headings)
    corpora = sorted({r["corpus"] for r in records})
    corpus_options = "".join(
        f'<option value="{html.escape(c, quote=True)}">{html.escape(c)}</option>'
        for c in corpora
    )
    return f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Salience extraction PoC</title>
<style>body {{ font: 16px system-ui; max-width: 90rem; margin: 2rem auto; padding: 1rem; }}
table {{ border-collapse: collapse; }} th, td {{ border: 1px solid #888; padding: .5rem; text-align: start; }}
pre {{ white-space: pre-wrap; overflow-wrap: anywhere; background: #eee; color: #111; padding: 1rem; }}
summary {{ cursor: pointer; padding: .5rem; }} .table {{ overflow-x: auto; }}
.case {{ border-block-start: 1px solid #888; margin-block-start: 2rem; }}
.filters {{ display: flex; flex-wrap: wrap; gap: 1rem; margin-block: 1rem; }}</style>
<h1>Salience extraction PoC</h1>
<p>{len(records)} pages across {len(corpora)} corpora; exploratory results, not a general quality claim.
Evidence recall counts questions for which every evidence string survives. It does not measure generated answers.
Word precision/recall/F1 use normalized word multisets. Character targets are soft limits.
Timing is warm actor IPC plus extraction, excluding page load. Reader may fall back to DOM.
Per-output warm-up times may include page readiness and accessibility preparation.
Means give every case equal weight. No model tokenizer is assumed unless explicitly supplied.</p>
<p>WCXB cases replay saved HTML with inline styles, with scripts, frames and external resources blocked.
They do not reproduce the live site's rendered layout. WCXB references and unwanted/required snippets
are supplied by Murrough Foley; PoC evidence questions are checked against those references and await independent review.
Real-page evidence misses are reported, not test failures. Authored fixture evidence remains enforced.</p>
<p>Firefox: {html.escape(json.dumps(records[0]["firefox"]))}</p>
<p>Tokenizer: {html.escape(json.dumps(tokenizer_info) if tokenizer_info else "not supplied; character counts only")}</p>
<div class="table"><table><caption>Extraction comparison</caption><thead><tr>{header}</tr></thead><tbody>{"".join(table)}</tbody></table></div>
<div class="filters">
<label>Corpus <select id="corpus"><option value="">All corpora</option>{corpus_options}</select></label>
<label>Find page <input id="search" type="search"></label>
<label><input id="missing" type="checkbox"> Only salience evidence misses</label>
</div>
<p id="count" role="status"></p>
{"".join(details)}
<script>
const corpus = document.getElementById("corpus");
const search = document.getElementById("search");
const missing = document.getElementById("missing");
function filter() {{
  let count = 0;
  for (const page of document.querySelectorAll(".case")) {{
    page.hidden = (corpus.value && page.dataset.corpus !== corpus.value) ||
      (missing.checked && page.dataset.missing !== "true") ||
      !page.dataset.search.includes(search.value.toLowerCase());
    if (!page.hidden) count++;
  }}
  document.getElementById("count").textContent = `${{count}} pages shown`;
}}
for (const control of [corpus, search, missing]) control.addEventListener("input", filter);
filter();
</script></html>"""


def main():
    parser = argparse.ArgumentParser(
        description="Report the offline salience PoC mochitest results"
    )
    parser.add_argument("log", type=Path)
    parser.add_argument("--output", type=Path, default=Path("artifacts/salience-poc"))
    parser.add_argument("--tokenizer-file", type=Path)
    args = parser.parse_args()
    tokenizer = None
    tokenizer_info = None
    if args.tokenizer_file:
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(args.tokenizer_file))
        tokenizer_info = {
            "file": str(args.tokenizer_file),
            "sha256": hashlib.sha256(args.tokenizer_file.read_bytes()).hexdigest(),
        }
    records = read_records(args.log)
    rows = score(records, tokenizer)
    args.output.mkdir(parents=True, exist_ok=True)
    data = {
        "records": records,
        "scores": rows,
        "tokenizer": tokenizer_info,
    }
    (args.output / "results.json").write_text(
        json.dumps(data, indent=2) + "\n", encoding="utf-8"
    )
    report = args.output / "report.html"
    report.write_text(render(records, rows, tokenizer_info), encoding="utf-8")
    print(f"Scored {len(records)} cases, {len(rows)} outputs: {report}")


if __name__ == "__main__":
    main()
