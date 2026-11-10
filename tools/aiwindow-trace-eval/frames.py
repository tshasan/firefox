# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import argparse
import ast
import csv
import hashlib
import json
import random
import sys
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import httpx

API = "https://en.wikipedia.org/w/api.php"
USER_AGENT = (
    "smartwindow-trace-eval/0.1 (https://github.com/mozilla-firefox/firefox) httpx"
)


def links(row):
    try:
        values = ast.literal_eval(row.get("wiki_links") or "[]")
    except (SyntaxError, ValueError):
        values = []
    if not values:
        values = [
            value
            for key, value in row.items()
            if key.startswith("wikipedia_link_") and value
        ]
    unique = []
    for raw in values:
        value = raw.strip()
        parsed = urlparse(value)
        if parsed.scheme == "https" and parsed.netloc == "en.wikipedia.org":
            if value not in unique:
                unique.append(value)
    return unique


def read_rows(path):
    csv.field_size_limit(sys.maxsize)
    with path.open(newline="", encoding="utf-8") as source:
        reader = csv.DictReader(source, delimiter="\t")
        rows = []
        for record in reader:
            index = record.get("") or record.get("Unnamed: 0")
            rows.append({
                "index": int(index),
                "prompt": record["Prompt"].strip(),
                "answer": record["Answer"].strip(),
                "links": links(record),
                "reasoningTypes": [
                    item.strip()
                    for item in (record.get("reasoning_types") or "").split("|")
                    if item.strip()
                ],
            })
    return rows


def sample(rows, limit, seed, indices):
    if indices:
        chosen = {row["index"]: row for row in rows}
        missing = [index for index in indices if index not in chosen]
        if missing:
            raise ValueError(f"Unknown FRAMES rows: {missing}")
        return [chosen[index] for index in indices]
    shuffled = rows[:]
    random.Random(seed).shuffle(shuffled)
    if not limit:
        return sorted(shuffled, key=lambda row: row["index"])
    groups = {}
    for row in shuffled:
        groups.setdefault(" | ".join(sorted(row["reasoningTypes"])), []).append(row)
    picked = []
    while len(picked) < limit and any(groups.values()):
        for key in sorted(groups):
            if groups[key] and len(picked) < limit:
                picked.append(groups[key].pop())
    return sorted(picked, key=lambda row: row["index"])


def pin(client, url, timestamp, cache):
    title = unquote(urlparse(url).path.removeprefix("/wiki/"))
    if title in cache:
        return cache[title]
    response = client.get(
        API,
        params={
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "prop": "revisions",
            "rvprop": "ids|timestamp",
            "rvlimit": "1",
            "rvdir": "older",
            "rvstart": timestamp,
            "titles": title,
            "redirects": "1",
        },
    )
    response.raise_for_status()
    pages = response.json()["query"]["pages"]
    revisions = pages[0].get("revisions") if pages else None
    if not revisions:
        cache[title] = None
        return None
    resolved = pages[0]["title"]
    revision = revisions[0]
    cache[title] = {
        "url": "https://en.wikipedia.org/w/index.php?title="
        + quote(resolved.replace(" ", "_"))
        + f"&oldid={revision['revid']}",
        "title": resolved,
        "revisionId": revision["revid"],
        "revisionTimestamp": revision["timestamp"],
    }
    return cache[title]


def main():
    parser = argparse.ArgumentParser(
        description="Convert the FRAMES test TSV into a Smart Window UI-eval manifest"
    )
    parser.add_argument("--tsv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--setting",
        choices=("tabs", "cold"),
        default="tabs",
        help="tabs: the gold articles are open and attached; cold: nothing is open",
    )
    parser.add_argument("--limit", type=int, default=10, help="0 selects all rows")
    parser.add_argument("--row", type=int, action="append", default=[])
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-tabs", type=int, default=6)
    parser.add_argument(
        "--pin-date",
        default="2024-08-01T00:00:00Z",
        help="Open each article as of this revision time; 'live' uses the current page",
    )
    args = parser.parse_args()

    rows = read_rows(args.tsv)
    selected = sample(rows, args.limit, args.seed, args.row)
    skipped = []
    scenarios = []
    cache = {}
    with httpx.Client(
        headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=False
    ) as client:
        for row in selected:
            if args.setting == "tabs" and len(row["links"]) > args.max_tabs:
                skipped.append({"index": row["index"], "reason": "too many sources"})
                continue
            gold = []
            for url in row["links"]:
                if args.pin_date == "live":
                    gold.append({"url": url, "sourceUrl": url})
                    continue
                pinned = pin(client, url, args.pin_date, cache)
                if pinned:
                    gold.append({**pinned, "sourceUrl": pinned["url"], "liveUrl": url})
            if len(gold) != len(row["links"]):
                skipped.append({"index": row["index"], "reason": "unresolved source"})
                continue
            scenarios.append({
                "id": f"frames-{row['index']}",
                "category": " | ".join(sorted(row["reasoningTypes"])) or "default",
                "reasoningTypes": row["reasoningTypes"],
                "prompt": row["prompt"],
                "reference": row["answer"],
                "goldSources": gold,
                "tabs": gold if args.setting == "tabs" else [],
            })

    source_hash = hashlib.sha256(args.tsv.read_bytes()).hexdigest()
    manifest = {
        "metadata": {
            "name": f"frames-{args.setting}",
            "benchmark": "FRAMES (google/frames-benchmark, test split)",
            "grader": "frames",
            "driver": "ui",
            "mode": "live",
            "retrievalMode": "oracle-tabs" if args.setting == "tabs" else "cold",
            "pinDate": args.pin_date,
            "sourceSha256": source_hash,
            "seed": args.seed,
            "skipped": skipped,
        },
        "scenarios": scenarios,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(scenarios)} scenarios to {args.output} ({len(skipped)} skipped)")


if __name__ == "__main__":
    main()
