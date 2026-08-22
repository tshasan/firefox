/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);
const { parseFlowToken } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pageextractor/PageExtractorEvents.sys.mjs"
);

/**
 * Finds the page_extractor.phase Glean event for one phase, the Glean twin
 * of the "PageExtractor" profiler marker of the same phase/process/flowId.
 *
 * @param {string} phase
 * @param {string} process
 * @param {string} [flowId] - Either a profiler marker's `flowId` (carries an
 *   `<instance>:` prefix Glean's `flow_id` doesn't) or another event's
 *   already-correlated `flow_id`; either way, any prefix is stripped before
 *   comparing.
 * @returns {object}
 */
function findPhaseEvent(phase, process, flowId) {
  const correlationId = flowId && parseFlowToken(flowId).correlationId;
  const event = Glean.pageExtractor.phase
    .testGetValue()
    ?.find(
      e =>
        e.extra.phase === phase &&
        e.extra.process === process &&
        (!correlationId || e.extra.flow_id === correlationId)
    );
  if (!event) {
    throw new Error(
      `No page_extractor.phase event was recorded for phase "${phase}".`
    );
  }
  return event;
}

/**
 * A get_text extraction records a "PageExtractor" profiler marker in both
 * the parent and content process, correlated by a shared flowId, with the
 * selected options and extraction outcome on the marker payload. Each of
 * those markers also has a page_extractor.phase Glean event twin, carrying
 * the same fields, recorded whether or not the profiler is running.
 */
add_task(async function test_page_extractor_profiler_markers() {
  Services.fog.testResetFOG();
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <article>
      <h1>Profiler marker test</h1>
      <p>This content is extracted through reader mode.</p>
    </article>
  `;

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let extraction;
  let profile;
  try {
    extraction = await getPageExtractor().getText({
      sufficientLength: 1000,
      removeBoilerplate: true,
      _forceRemoveBoilerplate: true,
      sourceUrl: "https://example.com/private-path",
    });
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
    // Flush before cleanup() tears down the content actor and discards its
    // buffered Glean data.
    await Services.fog.testFlushAllChildren();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const parentMarker = markers.find(
    marker => marker.process === "parent" && marker.phase === "get-text"
  );
  ok(parentMarker, "The parent get-text marker was recorded.");
  is(parentMarker.status, "success", "The parent marker reports success.");
  is(
    parentMarker.textLength,
    extraction.text.length,
    "The extracted text length was recorded."
  );
  is(
    parentMarker.options,
    "sufficientLength=1000, removeBoilerplate=true, _forceRemoveBoilerplate=true, sourceUrl=https://example.com/private-path",
    "The passed options were recorded on the marker."
  );

  const requestMarkers = markers.filter(
    marker => marker.flowId === parentMarker.flowId
  );
  const contentPhases = new Set(
    requestMarkers
      .filter(marker => marker.process === "content")
      .map(marker => marker.phase)
  );
  for (const phase of [
    "wait-for-ready",
    "reader-parse",
    "reader-output-parse",
    "dom-extract",
    "get-text",
  ]) {
    ok(contentPhases.has(phase), `The ${phase} marker was recorded.`);
  }

  const contentMarker = requestMarkers.find(
    marker => marker.process === "content" && marker.phase === "get-text"
  );
  is(contentMarker.strategy, "reader", "The reader strategy was recorded.");
  is(contentMarker.status, "success", "The content marker reports success.");

  const parentEvent = findPhaseEvent("get-text", "parent", parentMarker.flowId);
  is(parentEvent.extra.status, "success", "The event reports success.");
  is(
    parentEvent.extra.text_length,
    String(extraction.text.length),
    "The extracted text length was recorded."
  );

  const contentEvent = findPhaseEvent(
    "get-text",
    "content",
    parentMarker.flowId
  );
  is(
    contentEvent.extra.strategy,
    "reader",
    "The reader strategy was recorded."
  );
  is(
    contentEvent.extra.link_count,
    "0",
    "No links were found in the test page."
  );
  is(
    contentEvent.extra.canvas_count,
    "0",
    "No canvases were found in the test page."
  );
  is(
    contentEvent.extra.site_strategy,
    undefined,
    "No site-specific strategy applies to a plain example.com page."
  );
  ok(
    Number.isFinite(Number(contentEvent.extra.duration_ms)),
    "A duration was recorded."
  );
});

/**
 * A headless extraction records a "PageExtractor" marker for its outermost
 * headless-extractor phase, plus a headless-navigate marker covering the
 * hidden browser's navigation, both on the parent process. As with every
 * phase, both have a page_extractor.phase Glean event twin, correlated by
 * that flowId with the content-process get-text event that reads the page.
 */
add_task(async function test_page_extractor_headless_markers() {
  Services.fog.testResetFOG();
  const { PageExtractorParent } = ChromeUtils.importESModule(
    "resource://gre/actors/PageExtractorParent.sys.mjs"
  );
  const { html } = MLTestUtils.serveHTML();
  const { url, cleanup } = html`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Headless marker test</title>
      </head>
      <body>
        <div>Headless marker test content</div>
      </body>
    </html>
  `;

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, flowId) =>
        pageExtractor.getText({}, flowId),
    });
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
    await Services.fog.testFlushAllChildren();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  const headlessMarkers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const headlessMarker = headlessMarkers.find(
    marker =>
      marker.process === "parent" && marker.phase === "headless-extractor"
  );
  ok(headlessMarker, "A headless-extractor marker was recorded.");
  is(headlessMarker.status, "success", "The headless extraction succeeded.");

  const navigateMarker = headlessMarkers.find(
    marker =>
      marker.flowId === headlessMarker.flowId &&
      marker.phase === "headless-navigate"
  );
  ok(
    navigateMarker,
    "A headless-navigate marker covers loading the hidden browser up to " +
      "its navigation committing, before the page-ready wait starts."
  );
  is(
    navigateMarker.process,
    "parent",
    "headless-navigate happens on the parent, alongside headless-extractor."
  );
  is(
    navigateMarker.status,
    "success",
    "The navigation committed successfully."
  );

  const headlessEvent = findPhaseEvent(
    "headless-extractor",
    "parent",
    headlessMarker.flowId
  );
  is(headlessEvent.extra.status, "success", "The event reports success.");
  is(
    headlessEvent.extra.strategy,
    "headless",
    'A non-anonymous headless load is recorded as the "headless" strategy.'
  );
  ok(
    Number.isFinite(Number(headlessEvent.extra.duration_ms)),
    "A duration was recorded."
  );

  const navigateEvent = findPhaseEvent(
    "headless-navigate",
    "parent",
    headlessMarker.flowId
  );
  is(navigateEvent.extra.status, "success", "The event reports success.");

  findPhaseEvent("get-text", "content", headlessMarker.flowId);
});

/**
 * A get_page_metadata call records a "PageExtractor" marker in both the
 * parent and content process, correlated by a shared flowId, with the
 * strategy the content process picked on the marker payload, and a
 * page_extractor.phase Glean event twin for each.
 */
add_task(async function test_page_extractor_metadata_markers() {
  Services.fog.testResetFOG();
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <article>
      <h1>Metadata marker test</h1>
      <p>This content is used to compute page metadata.</p>
    </article>
  `;

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await getPageExtractor().getPageMetadata();
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
    await Services.fog.testFlushAllChildren();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const parentMarker = markers.find(
    marker =>
      marker.process === "parent" && marker.phase === "get-page-metadata"
  );
  ok(parentMarker, "The parent get-page-metadata marker was recorded.");
  is(parentMarker.status, "success", "The parent marker reports success.");

  const contentMarker = markers.find(
    marker =>
      marker.flowId === parentMarker.flowId &&
      marker.process === "content" &&
      marker.phase === "get-page-metadata"
  );
  ok(
    contentMarker,
    "The content get-page-metadata marker shares the parent's flowId."
  );
  is(
    contentMarker.strategy,
    "dom",
    "A regular page is read through the dom strategy, not about-reader."
  );
  is(contentMarker.status, "success", "The content marker reports success.");

  findPhaseEvent("get-page-metadata", "parent", parentMarker.flowId);
  const contentEvent = findPhaseEvent(
    "get-page-metadata",
    "content",
    parentMarker.flowId
  );
  is(contentEvent.extra.strategy, "dom", "The dom strategy was recorded.");
  is(contentEvent.extra.status, "success", "The event reports success.");
});

/**
 * A headless load that never commits its navigation (e.g. a stalled server)
 * records both its headless-navigate and headless-extractor
 * page_extractor.phase events with status "error" and the timeout's error
 * name. `phase` already says where it broke, so no separate "failure stage"
 * field is needed to query the failure by route.
 */
add_task(async function test_page_extractor_headless_load_navigate_failure() {
  Services.fog.testResetFOG();
  const { PageExtractorParent } = ChromeUtils.importESModule(
    "resource://gre/actors/PageExtractorParent.sys.mjs"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.pageExtractor.headlessTimeoutMs", 500]],
  });

  const { url, cleanup } = MLTestUtils.serveStalledPage();
  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: () =>
          ok(false, "The callback must not run for a page that never loaded."),
      }),
      /did not load in a headless browser within 500ms/,
      "The extractor gives up on a stalled page."
    );
  } finally {
    await cleanup();
    await SpecialPowers.popPrefEnv();
  }

  const navigateEvent = findPhaseEvent("headless-navigate", "parent");
  is(navigateEvent.extra.status, "error", "The event reports failure.");
  is(
    navigateEvent.extra.error_name,
    "TimeoutError",
    "The timeout's error name was recorded on the navigate phase."
  );
  // The navigate phase is pinned to headlessTimeoutMs, so its duration is a
  // meaningful lower bound, not just "some number was recorded."
  Assert.greaterOrEqual(
    Number(navigateEvent.extra.duration_ms),
    500,
    "The navigate phase's duration reflects the full timeout it waited out."
  );

  const headlessEvent = findPhaseEvent(
    "headless-extractor",
    "parent",
    navigateEvent.extra.flow_id
  );
  is(headlessEvent.extra.status, "error", "The event reports failure.");
  is(
    headlessEvent.extra.error_name,
    "TimeoutError",
    "The timeout's error name was recorded on the outer phase too."
  );
});

/**
 * getText() has no try/catch of its own: its outer PageExtractorEvent.run()
 * wrapper marks the get-text event as an error if any inner phase
 * (youtube-extract, reader-parse, reader-output-parse, dom-extract) throws.
 * This injects a failure in reader-mode parsing, the one real
 * non-PageExtractor collaborator, to prove the outer get-text marker
 * reports it, not just the inner phase that threw. It calls the child
 * actor's getText() directly (as in test_page_metadata_no_document in
 * browser_page_metadata.js), skipping the parent/child round trip, since
 * only content-side error handling is under test.
 */
add_task(async function test_page_extractor_get_text_reports_inner_failure() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, cleanup } = await html`
    <article>
      <h1>Reader failure test</h1>
      <p>This content is extracted through reader mode.</p>
    </article>
  `;

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  let rejected;
  let errorName;
  try {
    ({ rejected, errorName } = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      async () => {
        const { ReaderMode } = ChromeUtils.importESModule(
          "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs"
        );
        const actor = content.windowGlobalChild.getActor("PageExtractor");
        const originalParseDocument = ReaderMode.parseDocument;
        ReaderMode.parseDocument = () => {
          const error = new Error("Injected reader-mode failure.");
          error.name = "InjectedReaderModeFailure";
          throw error;
        };
        try {
          await actor.getText.call(actor, {
            removeBoilerplate: true,
            _forceRemoveBoilerplate: true,
          });
          return { rejected: false };
        } catch (error) {
          return { rejected: true, errorName: error.name };
        } finally {
          ReaderMode.parseDocument = originalParseDocument;
        }
      }
    ));
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  ok(rejected, "The injected reader-mode failure propagates out of getText().");
  is(
    errorName,
    "InjectedReaderModeFailure",
    "The actual error propagates rather than being swallowed."
  );

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const contentMarker = markers.find(
    marker => marker.process === "content" && marker.phase === "get-text"
  );
  ok(
    contentMarker,
    "The outer get-text phase reports the failure from the phase it ran " +
      "internally, not just that inner phase."
  );
  is(
    contentMarker.status,
    "error",
    "The outer get-text marker reports the failure."
  );
  is(
    contentMarker.errorName,
    "InjectedReaderModeFailure",
    "The outer get-text phase carries the actual error's name."
  );
});

/**
 * waitForPageReady() memoizes readiness only after the double rAF for
 * layout/paint runs -- not after any wait. A backgrounded tab's wait
 * returns early as "document-hidden" without running that rAF, so a
 * later getText() call on the same still-hidden tab must still wait: it
 * never got the layout/paint guarantee.
 */
add_task(async function test_page_extractor_repeats_wait_while_still_hidden() {
  const { html } = MLTestUtils.serveHTML();
  const { url, cleanup: cleanupServer } = html`
    <!DOCTYPE html>
    <body>
      Backgrounded content
    </body>
  `;

  const backgroundTab = await BrowserTestUtils.addTab(gBrowser, url, {
    inBackground: true,
  });
  await BrowserTestUtils.browserLoaded(backgroundTab.linkedBrowser);
  const extractor =
    backgroundTab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
      "PageExtractor"
    );

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await extractor.waitForPageReady();
    await extractor.getText();
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    BrowserTestUtils.removeTab(backgroundTab);
    await cleanupServer();
  }

  const waitMarkers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  ).filter(
    marker => marker.phase === "wait-for-ready" && marker.process === "content"
  );
  is(
    waitMarkers.length,
    2,
    "getText() still waits for readiness: the earlier wait never got " +
      "its rAF guarantee because the tab was hidden, so it wasn't " +
      "memoized as complete."
  );
  ok(
    waitMarkers.every(marker => marker.status === "document-hidden"),
    "Both waits reflect that the tab is still hidden."
  );
});

/**
 * Reading a PDF is handled entirely by PageExtractorParent#getTextFromPDF,
 * bypassing the content-process getText() this file's other tests exercise.
 * Its own "pdf-extract" phase, and the "pdf" strategy on the outer
 * "get-text" phase, are only ever produced by this code path, so a PDF
 * extraction is the only way to prove either is actually recorded.
 */
add_task(async function test_page_extractor_pdf_markers() {
  Services.fog.testResetFOG();
  const { cleanup, getPageExtractor } = await openSupportFile("page.pdf");

  let extraction;
  try {
    extraction = await getPageExtractor().getText();
    await Services.fog.testFlushAllChildren();
  } finally {
    await cleanup();
  }

  const getTextEvent = findPhaseEvent("get-text", "parent");
  is(getTextEvent.extra.status, "success", "The PDF extraction succeeded.");
  is(
    getTextEvent.extra.strategy,
    "pdf",
    "The outer get-text phase records the pdf strategy."
  );
  is(
    getTextEvent.extra.text_length,
    String(extraction.text.length),
    "The extracted text length was recorded."
  );

  const pdfEvent = findPhaseEvent(
    "pdf-extract",
    "parent",
    getTextEvent.extra.flow_id
  );
  is(
    pdfEvent.extra.status,
    "success",
    "The pdf-extract phase itself reports success."
  );
  is(
    pdfEvent.extra.strategy,
    "pdf",
    "The pdf-extract phase's own strategy field is recorded."
  );
});

/**
 * DOMExtractor picks a site-specific strategy (e.g. "google-search") from
 * the sourceUrl option, independent of where the page actually loaded from.
 * A plain page never sets this field (asserted in
 * test_page_extractor_profiler_markers above); this proves it's recorded on
 * the content-process "get-text" phase for a real Google search sourceUrl,
 * the same trigger browser_dom_extractor_search_tool.js uses for the
 * extraction behavior itself.
 */
add_task(async function test_page_extractor_site_strategy_event() {
  Services.fog.testResetFOG();
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <div class="MjjYud">
      <a href="https://example.com">A search result</a>
    </div>
  `;

  try {
    await getPageExtractor().getText({
      sourceUrl: "https://www.google.com/search?q=test",
    });
    await Services.fog.testFlushAllChildren();
  } finally {
    await cleanup();
  }

  const contentEvent = findPhaseEvent("get-text", "content");
  is(
    contentEvent.extra.site_strategy,
    "google-search",
    "The google-search site strategy was recorded for a Google search " +
      "results sourceUrl."
  );
});

/**
 * get-page-metadata's "about-reader" branch reads metadata by calling back
 * into getText(), rather than reading the DOM directly like the "dom"
 * strategy covered above. Untested until now; this proves it records the
 * right strategy through its Glean twin.
 */
add_task(async function test_page_extractor_metadata_about_reader_strategy() {
  Services.fog.testResetFOG();
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <article>
      <h1>About-reader metadata test</h1>
      <p>
        It's interesting that inside of Mozilla most people call mochitests
        "mohkee tests". I believe this is because it is adjacent to the term
        "mocha tests", which is pronounced with the hard k sound. However, the
        testing infrastructure is named after the delicious Japanese treat known
        as mochi.
      </p>
    </article>
  `;

  await toggleReaderMode();

  try {
    await getPageExtractor().getPageMetadata();
    await Services.fog.testFlushAllChildren();
  } finally {
    await cleanup();
  }

  const contentEvent = findPhaseEvent("get-page-metadata", "content");
  is(
    contentEvent.extra.strategy,
    "about-reader",
    "The about-reader strategy is recorded when reading metadata in " +
      "reader mode."
  );
});

/**
 * The canvas-capture phase, added alongside the other new phases in this
 * branch, isn't asserted elsewhere. This drives it through a real canvas
 * the same way browser_dom_extractor.js's canvas snapshot tests do, to
 * prove it's actually recorded, not just listed in PHASES.
 */
add_task(async function test_page_extractor_canvas_capture_event() {
  Services.fog.testResetFOG();
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <canvas id="test" width="200" height="200"></canvas>
    <script>
      const ctx = document.getElementById("test").getContext("2d");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 200, 200);
    </script>
  `;

  try {
    await getPageExtractor().getText({ includeCanvasSnapshots: true });
    await Services.fog.testFlushAllChildren();
  } finally {
    await cleanup();
  }

  const canvasEvent = findPhaseEvent("canvas-capture", "content");
  is(
    canvasEvent.extra.status,
    "success",
    "The canvas-capture phase reports success."
  );
  is(
    canvasEvent.extra.canvas_count,
    "1",
    "The captured canvas count was recorded."
  );
});
