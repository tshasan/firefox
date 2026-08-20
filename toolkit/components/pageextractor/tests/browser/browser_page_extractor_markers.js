/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);

/**
 * A get_text extraction records a "PageExtractor" profiler marker in both
 * the parent and content process, correlated by a shared flowId, with the
 * selected options and extraction outcome on the marker payload and no
 * source URL leaked into it.
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
    "sufficientLength=1000, removeBoilerplate=true, forceRemoveBoilerplate=true",
    "Only the selected options were recorded, and the source URL was not."
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

  const headlessMarker = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  ).find(
    marker =>
      marker.process === "parent" && marker.phase === "headless-extractor"
  );
  ok(headlessMarker, "A headless-extractor marker was recorded.");
  is(headlessMarker.status, "success", "The headless extraction succeeded.");

  const navigateMarker = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  ).find(
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
