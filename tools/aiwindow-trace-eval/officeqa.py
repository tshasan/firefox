# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import argparse
import ast
import csv
import hashlib
import html
import json
import re
import shutil
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCORER_REVISION = "7b9a3c154ef9fb40215bb67934afc43e6799de16"
SCORER_SHA256 = "0d91698c87df6d889339aac36f63ae0966607f169890b0bf8b472b26bfe8138f"
UPSTREAM = f"https://raw.githubusercontent.com/databricks/officeqa/{SCORER_REVISION}"
SUBSETS = {
    "full": ("databricks/officeqa", "officeqa_full.csv"),
    "pro": ("databricks/officeqa", "officeqa_pro.csv"),
    "pro-v2": ("databricks/officeqa-pro-v2", "officeqa_pro_v2.csv"),
}


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def source_files(value):
    value = value.strip()
    if value.startswith("["):
        try:
            names = json.loads(value)
        except json.JSONDecodeError:
            names = ast.literal_eval(value)
    else:
        names = [name.strip() for name in re.split(r"[;\n]", value) if name.strip()]
    if not isinstance(names, list) or not names:
        raise ValueError("source_files must contain at least one filename")
    for name in names:
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or "\\" in name
            or not re.fullmatch(r"[A-Za-z0-9_.-]+\.txt", name)
        ):
            raise ValueError(f"Unsafe or unsupported source_files entry: {name!r}")
    return list(dict.fromkeys(names))


def read_rows(path, uids=(), limit=3, difficulty=None):
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        required = {"uid", "question", "answer", "source_docs", "source_files"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"CSV is missing OfficeQA columns: {sorted(required)}")
        rows = []
        seen = set()
        for row in reader:
            uid = row["uid"].strip()
            if not uid or uid in seen:
                raise ValueError(f"Empty or duplicate OfficeQA uid: {uid!r}")
            seen.add(uid)
            if uids and uid not in uids:
                continue
            if difficulty and row.get("difficulty") != difficulty:
                continue
            if not row["question"].strip() or not row["answer"].strip():
                raise ValueError(f"OfficeQA row {uid} has an empty question or answer")
            source_files(row["source_files"])
            rows.append(row)
        missing = set(uids) - {row["uid"] for row in rows}
        if missing:
            raise ValueError(
                f"Requested UIDs unavailable after filtering: {sorted(missing)}"
            )
        if not rows:
            raise ValueError("No OfficeQA rows match the selection")
        return rows[:limit] if limit else rows


def corpus_filename(source_name, subset, representation):
    stem = Path(source_name).stem
    if representation == "parsed-text":
        if subset == "pro-v2":
            raise ValueError(
                "OfficeQA Pro V2 does not publish transformed text; use PDF mode"
            )
        return Path("treasury_bulletins_parsed/transformed") / source_name
    directory = "pdfs" if subset == "pro-v2" else "treasury_bulletin_pdfs"
    return Path(directory) / f"{stem}.pdf"


def find_document(corpus, relative):
    candidates = [corpus / relative, corpus / relative.name]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(f"OfficeQA source document missing: {relative}")


def install_scorer(output):
    directory = output / "scorer"
    directory.mkdir(parents=True, exist_ok=True)
    for filename in ("reward.py", "LICENSE-APACHE", "LICENSE-CC-BY-SA", "NOTICE"):
        target = directory / filename
        if not target.is_file():
            with urllib.request.urlopen(
                f"{UPSTREAM}/{filename}", timeout=60
            ) as response:
                content = response.read(2 * 1024 * 1024 + 1)
            if len(content) > 2 * 1024 * 1024:
                raise ValueError(f"Unexpectedly large upstream file: {filename}")
            target.write_bytes(content)
    scorer = directory / "reward.py"
    if sha256(scorer) != SCORER_SHA256:
        raise ValueError(
            "Official OfficeQA scorer checksum does not match the pinned revision"
        )
    return {
        "path": "scorer/reward.py",
        "sha256": SCORER_SHA256,
        "revision": SCORER_REVISION,
        "sourceUrl": f"{UPSTREAM}/reward.py",
    }


def build_manifest(
    rows,
    csv_path,
    documents,
    output,
    subset,
    representation,
    revision=None,
    driver="mochitest",
):
    output.mkdir(parents=True, exist_ok=True)
    destination = output / "documents"
    destination.mkdir(exist_ok=True)
    scenarios = []
    for row in rows:
        names = source_files(row["source_files"])
        tabs = []
        for name in names:
            path = documents[name]
            original_hash = sha256(path)
            stem = Path(name).stem
            if representation == "pdf":
                with path.open("rb") as source:
                    if not source.read(1024).lstrip().startswith(b"%PDF-"):
                        raise ValueError(f"Source is not a PDF: {path}")
                target = destination / f"{stem}.pdf"
                if path.resolve() != target.resolve():
                    shutil.copyfile(path, target)
                media_type = "application/pdf"
            else:
                text = path.read_text(encoding="utf-8-sig")
                target = destination / f"{stem}.html"
                target.write_text(
                    '<!doctype html><html lang="en"><meta charset="utf-8">'
                    f"<title>{html.escape(stem)}</title><body><article>"
                    f"<h1>{html.escape(stem)}</h1><pre>{html.escape(text)}</pre>"
                    "</article></body></html>\n",
                    encoding="utf-8",
                )
                media_type = "text/html"
            tabs.append({
                "title": stem,
                "fixture": str(target.relative_to(output)),
                "mediaType": media_type,
                "source": {
                    "file": name,
                    "sha256": original_hash,
                    "fixtureSha256": sha256(target),
                    "representation": representation,
                },
            })
        scenarios.append({
            "id": row["uid"],
            "category": row.get("difficulty", "officeqa"),
            "prompt": row["question"],
            "tabs": tabs,
            "activeTab": 0,
            "contextTabIndices": list(range(len(tabs))),
            "reference": row["answer"],
            "requiredSources": list(range(len(tabs))),
            "officeqa": {key: row[key] for key in row},
        })
    return {
        "schemaVersion": 1,
        "metadata": {
            "name": f"officeqa-{subset}-smartwindow-{representation}",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "upstream": "https://github.com/databricks/officeqa",
            "datasetRepository": SUBSETS[subset][0],
            "datasetRevision": revision,
            "csvSha256": sha256(csv_path),
            "subset": subset,
            "sourceRepresentation": representation,
            "driver": driver,
            "mode": "replay",
            "offline": True,
            "allowedTools": ["get_open_tabs", "get_page_content"],
            "retrievalMode": "oracle-source-documents",
            "license": "CC-BY-SA-4.0",
            "scorer": install_scorer(output),
            "limitations": [
                "Source documents named by the answer key are supplied as browser tabs; full-corpus retrieval is not measured.",
                "Firefox get_page_content currently truncates extracted text; PDF page fragments do not select an answer page.",
                "OfficeQA removes OCR text layers from scanned PDFs; native Firefox extraction does not add OCR.",
            ],
        },
        "scoring": {"kind": "officeqa", "tolerance": 0.0},
        "scenarios": scenarios,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Prepare official OfficeQA rows for Smart Window"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--csv", type=Path, help="Authorized local OfficeQA CSV")
    source.add_argument(
        "--bucket",
        type=Path,
        help="Local OfficeQA directory containing CSVs and corpus",
    )
    source.add_argument(
        "--download", action="store_true", help="Use authorized Hugging Face access"
    )
    parser.add_argument(
        "--corpus", type=Path, help="Local corpus root or selected PDF/text directory"
    )
    parser.add_argument("--subset", choices=SUBSETS, default="full")
    parser.add_argument(
        "--representation", choices=("pdf", "parsed-text"), default="pdf"
    )
    parser.add_argument(
        "--revision", default="main", help="Hugging Face dataset revision"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=3,
        help="Number of rows; 0 imports all selected rows",
    )
    parser.add_argument("--uid", action="append", default=[])
    parser.add_argument("--difficulty", choices=("easy", "hard"))
    parser.add_argument(
        "--output", type=Path, default=Path("artifacts/aiwindow-trace-eval/officeqa")
    )
    parser.add_argument(
        "--driver",
        choices=("ui", "mochitest"),
        default="mochitest",
        help="mochitest uses mach eval; ui drives the Smart Window interface",
    )
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be nonnegative")
    if args.bucket:
        args.csv = args.bucket / SUBSETS[args.subset][1]
        args.corpus = args.corpus or args.bucket
    if args.csv and not args.corpus:
        parser.error("--corpus is required with --csv")
    revision = None
    if args.download:
        try:
            from huggingface_hub import HfApi, hf_hub_download
        except ImportError:
            parser.error("Install huggingface_hub to download the authorized dataset")
        repo, filename = SUBSETS[args.subset]
        revision = HfApi().dataset_info(repo, revision=args.revision).sha
        csv_path = Path(
            hf_hub_download(repo, filename, repo_type="dataset", revision=revision)
        )
    else:
        csv_path = args.csv.resolve()
    rows = read_rows(csv_path, args.uid, args.limit, args.difficulty)
    documents = {}
    for row in rows:
        for name in source_files(row["source_files"]):
            if name in documents:
                continue
            relative = corpus_filename(name, args.subset, args.representation)
            if args.download:
                documents[name] = Path(
                    hf_hub_download(
                        repo, str(relative), repo_type="dataset", revision=revision
                    )
                )
            else:
                documents[name] = find_document(args.corpus.resolve(), relative)
    output = args.output.resolve()
    manifest = build_manifest(
        rows,
        csv_path,
        documents,
        output,
        args.subset,
        args.representation,
        revision,
        args.driver,
    )
    target = output / "manifest.json"
    target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(
        json.dumps({
            "manifest": str(target),
            "rows": len(rows),
            "documents": len(documents),
            "representation": args.representation,
            "retrievalMode": "oracle-source-documents",
        })
    )


if __name__ == "__main__":
    main()
