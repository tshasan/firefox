# Salience extractor and benchmark PoC

This PoC tries two ideas: extract text from the rendered layout, and measure
which facts survive extraction. It runs on six authored pages and twelve
saved real pages from WCXB. Treat its numbers as illustrations of the approach.
It proposes no change to the default extractor.

## Try the extractor on a page

Build Firefox with `./mach build`, then launch it with `./mach run`. In the
Browser Console's privileged command input, extract the current tab:

```javascript
var browser = Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser;
var actor = browser.browsingContext.currentWindowGlobal.getActor("PageExtractor");
var result = await actor.getText({
  useSalienceExtractor: true,
  sufficientLength: 10000,
  sourceUrl: browser.currentURI.spec,
});
console.log(result.text);
```

The command input needs `devtools.chrome.enabled` set in `about:config`. To
compare, pass `{ removeBoilerplate: false }` for the DOM walker, or
`{ removeBoilerplate: true }` for Reader Mode with DOM fallback. Keep
`sufficientLength` and `useSimpleText` the same across strategies.

`useSalienceExtractor` is opt-in and overrides `removeBoilerplate`. On an
`about:reader` page it reads the rendered article container. PDF and YouTube
handling still runs first. Smart Window never sets the option.

## What the algorithm does

`SalienceExtractor.sys.mjs` walks the flattened DOM, shadow roots and slotted
text included. It reads computed styles and text rectangles, and drops text with
tiny fonts, near-zero opacity, low contrast, or a position outside the page. It
keeps clipped text whose geometry suggests a user can reveal it, like carousel
slides and truncated reviews, and the content of closed `<details>` elements and
`hidden="until-found"` regions. When adjacent elements have no whitespace
between them but render apart, it separates their words.

It groups text into blocks, table rows, and sections. Given a character target,
it takes main content first, then unmarked text and sidebars, then navigation
and overlays. Within each priority it selects introductory evidence groups
across sections, with visible text before text a user has to bring into view.
Selected text keeps its heading context, visible `aria-labelledby` labels,
table column headings, and short adjacent labeled facts. It emits the result
in DOM reading order and treats short text in an unusually large font as a
heading. Menus, toolbars, selectors, and header lists grouped with popup
controls rank with navigation. Header feature lists and link-heavy lists inside
the content keep their content priority. To find popup groups, the extractor
checks the direct children of up to four ancestors and caches each answer.
Pages often put tab panels inside the tablist, so a tab panel takes the
priority of its nearest ancestor that isn't a control.

When landmarks mark less than a fifth of the page's text, the extractor infers
the main content: the deepest element holding 70% of the paragraph text, grown
to include the page's top-level heading. Once the page has 1,000 characters of
main content, link-dense runs outside it count as navigation. Navigation and
overlays only fill a character target, or appear without one, when the rest of
the page has fewer than 1,000 characters.

Main content and unmarked text each have a collection allowance of twice the
character target. Exhausting the unmarked allowance skips further unmarked
text measurements but keeps walking to find later main content. Each section
collects up to the character target, with a minimum allowance of 128 characters.
Whole text nodes can overshoot these soft allowances. Without a length target,
the collector skips section-selection bookkeeping. Viewport-only extraction
rejects off-viewport text before it can consume the collection allowance.

The extractor runs on heuristics, with no model behind it, and layout,
clipping, backgrounds, and landmark markup can all mislead it. It guesses from
geometry whether a user can reveal clipped text, computes no paint occlusion,
and doesn't defend against prompt injection. It treats an absolutely
positioned descendant as clipped by every overflowing ancestor, including
ancestors that aren't its containing block. It drops text that a page fades in
from zero opacity on scroll. Unlike the DOM walker, it takes no canvas
snapshots and runs no site-specific DOM strategies.

## Architecture and accessibility semantics

The implementation separates three jobs:

| Module | Responsibility |
| --- | --- |
| `SalienceExtractor.sys.mjs` | One flattened DOM walk, cached style and geometry reads, and text collection. |
| `SalienceSemantics.sys.mjs` | Accessibility preparation, computed roles, popup controls, and DOM/ARIA heading hints. |
| `SalienceSelection.sys.mjs` | The region priority order, and selection over collected runs and strings; no layout reads or accessibility calls. |

The selector rotates through the active section queues and drops each queue
once it runs out. When it pulls in context for a selected run, it takes at most
eight table header rows, four label targets per section, and 32 label targets
per extraction. Larger tables and denser ARIA relationships lose context past
those limits. Rotating across sections can drop the detail a question needs,
since the selector never sees the question.

`useSalienceExtractor: true` also turns on the accessibility lookups; no
separate option controls them. When it needs them, `SalienceSemantics` starts
the accessibility service and creates the document accessible, then yields for
up to 250 ms while the new tree is empty. It remembers documents whose tree
stayed empty in a `WeakSet`, so later calls skip the wait while the service
keeps running. The PoC trades the cost of starting accessibility, including
promoting PDF-only accessibility to full accessibility, for extraction quality.

After preparation, `SalienceSemantics` memoizes up to 64 element lookups. It
falls back to DOM and ARIA hints when accessibility is unavailable or an
element has no accessible. It reads roles without walking accessible children
or computing recursive names, and drops its service reference when collection
ends. A missing accessible never hides visible text, and the body output never
includes the text of a hidden label.

The element lookup calls `getAccessibleFromCache`, which the accessibility API
marks as test-only, so this integration can't land as it stands. Tree
preparation makes `extractSalientText` async, and direct callers must await it.

## Run the offline comparison

From the checkout root, after building:

```sh
mkdir -p artifacts
./mach mochitest toolkit/components/pageextractor/tests/browser/browser_salience_extractor.js --headless > artifacts/salience-tests.log 2>&1
./mach mochitest toolkit/components/pageextractor/tests/browser/browser_salience_sections.js --headless > artifacts/salience-sections.log 2>&1
./mach mochitest toolkit/components/pageextractor/tests/browser/browser_salience_benchmark.js toolkit/components/pageextractor/tests/browser/browser_salience_real_benchmark.js --headless --log-raw artifacts/salience-benchmark.jsonl > artifacts/salience-benchmark.log 2>&1
python3 toolkit/components/pageextractor/tests/salience_report.py artifacts/salience-benchmark.jsonl
./mach python-test toolkit/components/pageextractor/tests/test_salience_report.py
```

Open `artifacts/salience-poc/report.html`. `results.json`, in the same
directory, holds the outputs, options, timings, Firefox build, references, and
scores. The scorer needs Python's standard library and nothing else unless you
pass `--tokenizer-file`. You download no pages, models, or datasets.

The browser tests serve fixtures over loopback and call the PageExtractor
actor. The authored cases wait for their declared dynamic content. Each mode
runs with full output and a 1,000-character target; real pages also run with a
10,000-character target. Whole blocks and headings can overshoot the target.
Each variant warms up once, then records three calls. Timings include actor IPC
and exclude page loading, so read them as rough. Each output also records its
warm-up time, which can include waiting for the page and preparing
accessibility, so it doesn't isolate initialization cost.

An authored case fails when salience drops question evidence. Real pages log
evidence misses without failing, since they exist to expose weaknesses. The
real-page test fails on a missing snapshot, a hash mismatch, a corrupted page
title, or a missing extraction result. The scorer counts empty text as missing
evidence. The Let's Encrypt snapshot needs client-side hydration, so the corpus
marks it as a replay limitation; all three modes return empty text on it.

The cases cover an article, a recipe after long navigation, hidden product
text, a script-injected forum thread, documentation in a closed shadow root,
and a clipped product review. They live in
`toolkit/components/pageextractor/tests/browser/salience_corpus.json`. Each
case has HTML, expected text, questions with evidence strings, unwanted strings,
page type, difficulty, source, and license. To add a case, append it there and
rerun.

## Real pages

The real corpus lives in `tests/browser/salience_real/`. It includes an AVX-512
article, a Let's Encrypt thread, a OnePlus product page, a Hakutsuru collection,
a shoe rental listing, ArchWiki's sudo documentation, Glossier's about page,
an ASU degree comparison, a Japan travel thread, Wikipedia's programming
languages category, a Harvard course page, and Netlify's home page. The twelve
pages span seven page types, with three evidence questions each.

The snapshots and reference text come from Murrough Foley's WCXB development
split. See the corpus `README.md` for provenance, licensing, and how the replay
differs from the live site. The snapshots carry their publishers' rights, and
some carry share-alike or copyleft terms, like Wikipedia's CC-BY-SA and
ArchWiki's GFDL, so they need a licensing review or have to move out of tree
before anything lands. The pages are a convenience sample, and nobody
besides the author has reviewed the PoC questions. Don't compare these scores
with live-site extractions.

To add WCXB development pages, edit `tests/salience_real_cases.json` and run:

```sh
python3 toolkit/components/pageextractor/tests/salience_import.py /path/to/wcxb
```

The importer checks each question's evidence against the source reference
before it copies snapshots and regenerates the manifest. Write questions whose
evidence spans early and late content, and keep hard cases where salience
scores badly. Don't pick pages or edit evidence to raise a score.

## Paired timing against a frozen baseline

The real-page runner can time a saved baseline module and the current extractor
on the same loaded document. Supply a trusted module URI or a local file URI:

```sh
./mach mochitest toolkit/components/pageextractor/tests/browser/browser_salience_real_benchmark.js --headless --setpref browser.pageextractor.salience.baselineModule=file:///absolute/path/to/baseline.sys.mjs --log-raw artifacts/salience-paired.jsonl > artifacts/salience-paired.log 2>&1
```

The baseline must export `extractSalientText`; freeze or pin its dependencies
too. The runner warms both variants, alternates their order over nine samples,
and logs `SALIENCE_PAIRED_BENCHMARK` records with timings and output text for
full, 1,000-character, and 10,000-character extraction. These measurements omit
actor IPC and page loading. Compare quality and per-page timing together. Nine
samples on twelve pages tell you nothing about tail latency. Without the pref,
the benchmark runs as before.

## Read the results

- Evidence recall counts the questions whose evidence strings all survive,
  ignoring case and whitespace. It measures whether the evidence reached the
  output. A model could still answer wrong.
- Precision, recall, and F1 compare word multisets against the reference.
  Repeated boilerplate lowers precision, and missing reference words lower
  recall.
- Character counts show output size. Unwanted-string hits name each leak. The
  report lists every reference, question, and output.
- Required snippet recall checks the WCXB inclusion labels, separately from
  the PoC questions. Summary rows separate the authored and real corpora.
- Filter the report by corpus, page title, or salience evidence misses. Expand
  outputs to inspect missing questions, unwanted text, and required snippets.
- Reader Mode falls back to DOM, as it does in the existing API.

For token counts, install `tokenizers` in your Python environment and pass a
tokenizer file:

```sh
python3 toolkit/components/pageextractor/tests/salience_report.py artifacts/salience-benchmark.jsonl --tokenizer-file /path/to/tokenizer.json
```

The report then adds output tokens and output-to-reference token ratios. Targets
stay in characters, and the report truncates nothing to a token budget.

## Still to do

The PoC runs as browser mochitests over authored fixtures and static replays.
It lacks faithful rendered captures, `./mach eval` integration, an
independently reviewed held-out corpus, lazy-loading and consent interactions,
downstream answer evaluation, and representative performance numbers.

The next cases worth adding are pages where salience drops evidence, picks the
wrong region, or keeps hidden text. Reduce each page to an offline fixture,
write its questions, and have someone else review its expected text. Regenerate
the report whenever you change the algorithm.
