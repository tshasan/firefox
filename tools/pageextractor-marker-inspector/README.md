# PageExtractor Extract Debugger

A local debug tool (MV3 WebExtension) with a single DevTools panel:
pick `GetTextOptions`, click Extract, and see the real
`PageExtractorParent#getText()` output (verbatim text/links/canvas
snapshots) plus live-tracking highlight boxes over every text block,
canvas, and link the extraction actually picked up, drawn directly on the
inspected page.

The boxes are drawn with `Document.insertAnonymousContent()` — the same
canvasFrame primitive DevTools' own inspector highlighter is built on — and
re-measure the real elements every animation frame, so they keep tracking
scrolling, resizing, and layout changes for as long as they're shown,
rather than freezing at a rect captured once during extraction.

Every action also shows a "Performance" section: the real "PageExtractor"
profiler markers and Glean telemetry events that call produced, captured by
briefly recording with the real Firefox Profiler (`Services.profiler`) behind
the scenes — no separate `about:profiling` capture needed, and if you already
have one running, this leaves it alone and just takes a snapshot.

The panel UI is plain HTML with no stylesheet — it leans on native form
controls instead: a `<fieldset>` around the canvas-related options whose
`<legend>` holds the `includeCanvasSnapshots` checkbox (checkboxes in a
fieldset's legend are exempt from the fieldset's own disabled state, so one
`fieldset.disabled` toggle greys out the rest while leaving that checkbox
clickable), `<details>` to tuck away the automation-only option, and a
`<textarea readonly>` for the extracted text (wraps and scrolls natively).

This is a personal dev tool, not part of the Gecko build — it isn't tracked
in the tree's git history. It depends on a small, private `_debugLayout`
`GetTextOptions` field added to `DOMExtractor.sys.mjs` /
`PageExtractorChild.sys.mjs` / `PageExtractor.d.ts` (plus the new
`DebugLayoutOverlay.sys.mjs`, registered in `moz.build`) on this branch
(never surfaced in markers/telemetry) — you need a build that includes
those changes, and to have run `./mach build faster` at least once so the
new file gets symlinked into the objdir, for bounding boxes to come back.

## One-time setup

It's implemented as a WebExtension experiment API (`experiment_apis` in
manifest.json) so it can call the actual `PageExtractorParent` actor
directly. That requires the pref `extensions.experiments.enabled` to be
`true`. **This is not necessarily on by default** — plenty of local/dev
profiles ship with it pinned to `false`. Check `about:config` and set it
explicitly:

```
extensions.experiments.enabled = true
```

If this is missing, the add-on fails to install outright: `about:debugging`
will say the extension "appears to be invalid". That's almost certainly
the failure you'll hit if nothing shows up after loading it — check this
pref first.

Then: go to `about:debugging#/runtime/this-firefox` → "Load Temporary
Add-on…" → select `manifest.json` in this folder. Click the add-on's
"Inspect" link there if anything still looks broken — that opens a toolbox
with real console errors instead of guessing.

## Using it

1. Open any regular page (`http://`/`https://`/`file://`), open DevTools
   (F12) → a "PageExtractor" tab appears in the toolbox.
2. `sourceUrl` is pre-filled from the inspected tab's URL (needed for
   site-specific strategies like Google Search/YouTube) — edit or clear it
   to test a different URL's strategy.
3. Check/fill in whichever `GetTextOptions` you want, then click "Extract".
   This calls the real actor — same code path as any production caller.
4. The right side shows the verbatim text, links, and (if
   `includeCanvasSnapshots` is checked) the captured canvas images.
5. Boxes are drawn automatically on the inspected page: blue for each
   extracted text block, purple for canvases, green for links. They track
   scrolling/resizing/layout changes live, so there's no "redraw" step —
   scroll around and watch them follow. Click "Clear boxes on page" to
   remove them (or just run Extract again, which replaces them).
6. `_forceRemoveBoilerplate` only works under `Cu.isInAutomation`, so
   checking it here surfaces the real "automation only" error — that's
   expected, not a bug in this tool.
7. Below each action's output, "Performance" shows the "PageExtractor"
   profiler markers the call produced, grouped into one box per flow (a
   getText() call and everything it triggers, parent and content process
   together, share one flow) — a blue "parent" or green "content" tag per
   row makes which process ran which phase obvious at a glance, alongside a
   color-coded duration bar (same colors the real profiler marker chart
   uses) and a details cell for fields like strategy/textLength/errorName.
   Below that, "Recorded telemetry" is a table of any new Glean events
   recorded (via each metric's `testGetValue()`) — the same data a captured
   profile or a Redash query on `pageextractor.extraction` would show.
