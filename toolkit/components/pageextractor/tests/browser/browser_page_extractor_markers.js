/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);

/**
 * A get_text extraction records a "PageExtractor" profiler marker in both
 * the parent and content process, correlated by a shared flowId, with the
 * selected options and extraction outcome on the marker payload.
 */
add_task(async function test_page_extractor_profiler_markers() {
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
});

/**
 * A headless extraction records a "PageExtractor" marker for its outermost
 * headless-extractor phase, plus a headless-navigate marker covering the
 * hidden browser's navigation, both on the parent process.
 */
add_task(async function test_page_extractor_headless_markers() {
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
});

/**
 * A get_page_metadata call records a "PageExtractor" marker in both the
 * parent and content process, correlated by a shared flowId, with the
 * strategy the content process picked on the marker payload.
 */
add_task(async function test_page_extractor_metadata_markers() {
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
