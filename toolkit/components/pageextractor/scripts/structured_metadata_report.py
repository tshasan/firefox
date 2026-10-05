# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Renders the results of scan_structured_metadata.py as a self-contained HTML
report. Everything taken from a page is escaped, as pages are untrusted.
"""

from collections import Counter
from html import escape
from pathlib import Path
from urllib.parse import urlparse

STYLE = """
.viz-root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --surface-2: #f1f0ec;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #6f6e69;
  --grid: #dcdbd5;
  --series-1: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --surface-2: #262624;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #9a998f;
    --grid: #3a3a37;
    --series-1: #3987e5;
  }
}
body { margin: 0; }
.viz-root {
  background: var(--surface-1);
  color: var(--text-primary);
  font: 15px/1.5 system-ui, sans-serif;
  padding: 32px;
  max-width: 1100px;
  margin: auto;
}
h1 { font-size: 28px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 40px 0 4px; }
.subtitle, .note { color: var(--text-secondary); margin: 0 0 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 24px; }
.tile { background: var(--surface-2); border-radius: 8px; padding: 16px; }
.tile .value { font-size: 40px; font-weight: 600; line-height: 1.1; }
.tile .label { color: var(--text-secondary); }
.bars { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; align-items: center; }
.bar-label { color: var(--text-secondary); text-align: right; }
.bar-track { position: relative; height: 24px; border-left: 1px solid var(--grid); }
.bar { height: 20px; margin-top: 2px; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 2px; }
.bar-row { display: flex; align-items: center; gap: 8px; }
.bar-value { color: var(--text-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-row:hover .bar { filter: brightness(1.15); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--text-secondary); font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.conflict { background: var(--surface-2); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.conflict dt { color: var(--text-muted); font-size: 13px; }
.conflict dd { margin: 0 0 8px; }
code { font-size: 12px; }
"""

SIGNALS = [
    ("JSON-LD", lambda r: any(n["syntax"] == "json-ld" for n in nodes(r))),
    ("Microdata", lambda r: any(n["syntax"] == "microdata" for n in nodes(r))),
    ("Open Graph", lambda r: any(t["source"] == "opengraph" for t in tags(r))),
    ("Twitter Card", lambda r: any(t["source"] == "twitter" for t in tags(r))),
    ("HTML description", lambda r: bool(tag_values(r, "description"))),
    ("Canonical link", lambda r: bool(metadata(r)["links"])),
]


def metadata(result):
    return result["structuredMetadata"]


def nodes(result):
    return metadata(result)["structuredData"]["nodes"]


def tags(result):
    return metadata(result)["metaTags"]


def tag_values(result, name):
    return [t["value"] for t in tags(result) if t["name"] == name]


# Types that describe the site around the content rather than the content: a
# report-side choice, since the parser leaves such judgements to its consumers.
SCAFFOLDING_TYPES = {
    "BreadcrumbList",
    "CollectionPage",
    "ImageObject",
    "ItemList",
    "Organization",
    "Person",
    "SearchAction",
    "SiteNavigationElement",
    "SpeakableSpecification",
    "WebPage",
    "WebSite",
    "WPFooter",
    "WPHeader",
}


def content_types(result):
    """The schema.org types a page gives for its content, without scaffolding."""
    return {
        t["schemaOrgName"]
        for t in result["types"]
        if t["schemaOrgName"]
        and t["schemaOrgName"] not in SCAFFOLDING_TYPES
        and "Organization" not in t["ancestors"]
    }


def has_schema_org_type(result):
    return any(t["schemaOrgName"] for t in result["types"])


def description_conflict(result):
    """The distinct descriptions a page gives, when it gives more than one."""
    found = {}
    for name in ("description", "og:description", "twitter:description"):
        for value in tag_values(result, name):
            found.setdefault(" ".join(value.split()), name)
    return found if len(found) > 1 else None


def percent(count, total):
    return f"{round(100 * count / total)}%" if total else "n/a"


def host(url):
    return urlparse(url).hostname.removeprefix("www.")


def bars(rows):
    """Horizontal bars of (label, count, total) page counts, labelled with the
    share of pages."""
    out = ['<div class="bars">']
    for label, count, total in rows:
        width = 100 * count / total if total else 0
        tip = f"{label}: {count} of {total} pages ({percent(count, total)})"
        out.append(
            f'<div class="bar-label">{escape(label)}</div>'
            f'<div class="bar-row" title="{escape(tip)}">'
            f'<div class="bar-track" style="flex: 0 0 70%">'
            f'<div class="bar" style="width: {width:.1f}%"></div></div>'
            f'<span class="bar-value">{percent(count, total)} '
            f'<span class="note">({count})</span></span></div>'
        )
    out.append("</div>")
    return "".join(out)


def write_report(data, path):
    results = data["results"]
    loaded = [r for r in results if r.get("ok")]
    total = len(loaded)

    typed = sum(has_schema_org_type(r) for r in loaded)
    conflicts = [(r, c) for r in loaded if (c := description_conflict(r))]

    type_pages = Counter()
    for r in loaded:
        type_pages.update({
            t["schemaOrgName"] for t in r["types"] if t["schemaOrgName"]
        })

    by_category = {}
    for r in loaded:
        by_category.setdefault(r["category"], []).append(r)
    content_pages = [r for r in loaded if r["category"] != "homepage"]
    described = sum(bool(content_types(r)) for r in content_pages)

    html = [
        "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width'>",
        "<title>What pages say about themselves</title>",
        f"<style>{STYLE}</style></head><body><main class='viz-root'>",
        "<h1>What pages say about themselves</h1>",
        f"<p class='subtitle'>{total} of {len(results)} sites loaded in "
        f"Firefox's hidden browser on {escape(data['scannedAt'])}, read by "
        "PageExtractor's structured metadata parser, with no per-site code. The "
        "sites are a hand-picked list of popular pages, not a random sample of "
        "the web.</p>",
        "<div class='tiles'>",
        f"<div class='tile'><div class='value'>{percent(typed, total)}</div>"
        "<div class='label'>declare a schema.org type</div></div>",
        f"<div class='tile'><div class='value'>"
        f"{percent(described, len(content_pages))}</div>"
        "<div class='label'>of content pages state what their content is "
        "(a Recipe, a NewsArticle, a Product...)</div></div>",
        f"<div class='tile'><div class='value'>{len(type_pages)}</div>"
        "<div class='label'>distinct schema.org types found</div></div>",
        f"<div class='tile'><div class='value'>{percent(len(conflicts), total)}"
        "</div><div class='label'>give more than one description</div></div>",
        "</div>",
        "<h2>Which signals pages provide</h2>",
        "<p class='note'>Share of loaded pages with each kind of metadata.</p>",
        bars([(label, sum(test(r) for r in loaded), total) for label, test in SIGNALS]),
        "<h2>Which pages say what their content is</h2>",
        "<p class='note'>Share of loaded pages in each category that give a "
        "schema.org type for their content, beyond site scaffolding such as "
        "WebSite, BreadcrumbList or the publisher.</p>",
        bars([
            (category, sum(bool(content_types(r)) for r in pages), len(pages))
            for category, pages in by_category.items()
        ]),
        "<h2>What each kind of page says it is</h2>",
        "<table><tr><th>Category</th><th>Pages</th><th>Content types declared"
        "</th></tr>",
    ]
    for category, pages in by_category.items():
        found = Counter(name for r in pages for name in content_types(r))
        listed = ", ".join(
            f"{name} ({count})" if count > 1 else name
            for name, count in found.most_common()
        )
        html.append(
            f"<tr><td>{escape(category)}</td><td class='num'>{len(pages)}</td>"
            f"<td>{escape(listed or 'none')}</td></tr>"
        )
    html += [
        "</table>",
        "<h2>Most common types</h2>",
        "<table><tr><th>schema.org type</th><th>Pages</th></tr>",
    ]
    for name, count in type_pages.most_common(15):
        html.append(f"<tr><td>{escape(name)}</td><td class='num'>{count}</td></tr>")
    html.append("</table>")

    html.append(
        "<h2>Descriptions that disagree</h2><p class='note'>The parser keeps "
        "every source, so a feature can choose which description to trust. "
        "Some of the pages that give different ones:</p>"
    )
    for r, found in conflicts[:6]:
        html.append(
            f"<div class='conflict'><strong>{escape(host(r['url']))}</strong><dl>"
        )
        for value, name in found.items():
            html.append(f"<dt>{escape(name)}</dt><dd>{escape(value[:300])}</dd>")
        html.append("</dl></div>")

    html.append(
        "<h2>Every site</h2><table><tr><th>Category</th><th>Site</th>"
        "<th>Top-level types</th><th>Syntaxes</th><th>Meta tags</th>"
        "<th>Words</th><th>Load + read</th></tr>"
    )
    for r in results:
        if r.get("ok"):
            types = ", ".join(sorted({t["type"] for t in r["types"]})) or "none"
            syntaxes = ", ".join(sorted({n["syntax"] for n in nodes(r)})) or "none"
            cells = (
                f"<td>{escape(types)}</td><td>{escape(syntaxes)}</td>"
                f"<td class='num'>{len(tags(r))}</td>"
                f"<td class='num'>{r['wordCount']}</td>"
                f"<td class='num'>{r['durationMs'] / 1000:.1f}s</td>"
            )
        else:
            cells = f"<td colspan='5'>Not loaded: <code>{escape(r.get('error', ''))}</code></td>"
        html.append(
            f"<tr><td>{escape(r['category'])}</td>"
            f"<td><a href='{escape(r['url'])}'>{escape(host(r['url']))}</a></td>{cells}</tr>"
        )
    html.append(
        "</table><p class='note'>A page that loaded with no metadata and few "
        "words was probably a bot check rather than the real page. Sites that "
        "were not loaded refused the hidden browser, for example by "
        "redirecting it to another site.</p></main></body></html>"
    )
    Path(path).write_text("".join(html))
