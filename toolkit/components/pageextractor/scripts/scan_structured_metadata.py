# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Loads a list of live sites in PageExtractor's hidden browser and records the
structured metadata each one declares.

    ./mach python toolkit/components/pageextractor/scripts/scan_structured_metadata.py

Pages are fetched anonymously with a fresh profile, so no user data is sent.
The results are written as JSON next to an HTML report, which can be rebuilt
from the JSON with --report-only.
"""

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from structured_metadata_report import write_report  # noqa: E402

# Runs in the parent process. Resolves with the page's structured metadata,
# plus the schema.org reading of every top-level type, or with an error.
SCAN_SCRIPT = """
const [url, resolve] = arguments;
const { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);
const { getSchemaOrgAncestors, getSchemaOrgTypeName } =
  ChromeUtils.importESModule(
    "moz-src:///toolkit/components/pageextractor/SchemaOrgVocabulary.sys.mjs"
  );
const start = Date.now();
PageExtractorParent.getHeadlessExtractor({
  urlString: url,
  anonymousFetch: true,
  callback: actor => actor.getPageMetadata(),
}).then(
  metadata => {
    const types = metadata.structuredMetadata.structuredData.nodes
      .filter(node => node.isTopLevel)
      .flatMap(node =>
        node.types.map(type => ({
          type,
          syntax: node.syntax,
          schemaOrgName: getSchemaOrgTypeName(type),
          ancestors: getSchemaOrgAncestors(type),
          // The broad kinds of thing it is: the direct subtypes of Thing
          // among the type and its ancestors.
          categories: [type, ...getSchemaOrgAncestors(type)]
            .map(getSchemaOrgTypeName)
            .filter(
              name => name && getSchemaOrgAncestors(name).join() == "Thing"
            ),
        }))
      );
    resolve({
      ok: true,
      durationMs: Math.round(Date.now() - start),
      language: metadata.language,
      wordCount: metadata.wordCount,
      isReaderable: metadata.isReaderable,
      isGated: metadata.isGated,
      types,
      structuredMetadata: metadata.structuredMetadata,
    });
  },
  error =>
    resolve({
      ok: false,
      durationMs: Math.round(Date.now() - start),
      error: String(error?.name ? `${error.name}: ${error.message}` : error),
    })
);
"""


def read_sites(path):
    sites = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            category, url = line.split(maxsplit=1)
            sites.append({"category": category, "url": url})
    return sites


def default_binary():
    from mozbuild.base import MozbuildObject

    return MozbuildObject.from_environment(cwd=str(HERE)).get_binary_path()


def scan(sites, binary, headless, timeout_s):
    from marionette_driver.marionette import Marionette

    client = Marionette(bin=binary, headless=headless, gecko_log="-")
    client.start_session()
    client.set_context(client.CONTEXT_CHROME)
    client.timeout.script = timeout_s
    results = []
    try:
        for index, site in enumerate(sites, 1):
            print(f"[{index}/{len(sites)}] {site['url']}", flush=True)
            try:
                result = client.execute_async_script(
                    SCAN_SCRIPT, script_args=[site["url"]], new_sandbox=False
                )
            except Exception as error:
                result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
            results.append({**site, **result})
    finally:
        client.cleanup()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sites",
        default=str(HERE / "structured_metadata_sites.txt"),
        help="A file of 'category url' lines.",
    )
    parser.add_argument(
        "--output",
        default="artifacts/structured-metadata-scan",
        help="The directory for scan.json and report.html.",
    )
    parser.add_argument("--binary", help="Defaults to the local build.")
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--timeout", type=int, default=60, help="Seconds per site.")
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Rebuild report.html from an existing scan.json.",
    )
    args = parser.parse_args()

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    scan_path = output / "scan.json"

    if args.report_only:
        data = json.loads(scan_path.read_text())
    else:
        sites = read_sites(args.sites)
        started = time.strftime("%Y-%m-%d %H:%M")
        results = scan(
            sites, args.binary or default_binary(), not args.headful, args.timeout
        )
        data = {"scannedAt": started, "results": results}
        scan_path.write_text(json.dumps(data, indent=2))
        print(f"Wrote {scan_path}")

    report_path = output / "report.html"
    write_report(data, report_path)
    print(f"Wrote {report_path}")


if __name__ == "__main__":
    main()
