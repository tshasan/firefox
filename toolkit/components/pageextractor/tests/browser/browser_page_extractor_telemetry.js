/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);
const { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);

function getLastEvent(gleanMetric) {
  const events = gleanMetric.testGetValue() || [];
  return events.length ? events.at(-1) : null;
}

function countEvents(gleanMetric) {
  return gleanMetric.testGetValue()?.length ?? 0;
}

// testGetValue() deserializes a fresh array/objects on every call, so
// comparing the "last event" by object identity would be true on the very
// first poll regardless of whether a new event actually landed. Track the
// event count instead and wait for it to grow past `originalCount`, which
// callers must capture *before* triggering the action that should record
// the event: capturing it here, after the action already ran and already
// recorded the event, would wait forever for a second event that never
// comes.
async function waitForGleanEvent(gleanMetric, originalCount) {
  await TestUtils.waitForCondition(() => {
    return countEvents(gleanMetric) > originalCount;
  }, "Waiting for new Glean event");
  return getLastEvent(gleanMetric);
}

/**
 * A get_text extraction should record a Glean event and a profiler marker
 * that share the same flow_id, with the event's extras reporting the
 * effective (defaults-applied) option values, and without leaking the
 * source URL.
 *
 * Only the top-level get-text/get-page-metadata/wait-for-ready/
 * headless-extractor operations record telemetry: firing a Glean event per
 * internal phase too (reader-parse, dom-extract, canvas-capture, ...) would
 * multiply telemetry volume several times over for one extraction, so their
 * outcome (status, strategy, counts) is folded into the top-level event
 * instead of getting an event of its own.
 */
add_task(async function test_page_extractor_telemetry_get_text() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <article>
      <h1>Telemetry test</h1>
      <p>This content is extracted through reader mode.</p>
    </article>
  `;

  const getTextCount = countEvents(Glean.pageextractorExtraction.getText);

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

  const gleanEvent = await waitForGleanEvent(
    Glean.pageextractorExtraction.getText,
    getTextCount
  );
  ok(gleanEvent, "A get_text Glean event was recorded.");
  is(gleanEvent.extra.status, "success", "Glean status matches.");
  is(gleanEvent.extra.strategy, "reader", "Glean strategy matches.");
  is(
    gleanEvent.extra.text_length,
    String(extraction.text.length),
    "Glean text_length matches the extraction result."
  );
  is(
    gleanEvent.extra.sufficient_length,
    "1000",
    "The effective sufficientLength was recorded."
  );
  is(
    gleanEvent.extra.remove_boilerplate,
    "true",
    "The effective removeBoilerplate was recorded."
  );
  ok(
    !JSON.stringify(gleanEvent.extra).includes("private-path"),
    "No source URL leaked into telemetry."
  );

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const parentMarker = markers.find(
    marker => marker.process === "parent" && marker.phase === "get-text"
  );
  ok(parentMarker, "The parent get-text marker was recorded.");
  is(
    parentMarker.flowId,
    gleanEvent.extra.flow_id,
    "The profiler marker and the Glean event share the same flow_id."
  );
});

/**
 * get_text should report which site-specific DOMExtractor strategy applied
 * (e.g. the Google search results page strategy), via a `site_strategy`
 * extra distinct from the top-level `strategy` extra, and should leave it
 * empty when no site-specific strategy matched the sourceUrl.
 */
add_task(async function test_page_extractor_telemetry_site_strategy() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <div>
      <a href="https://example.com/article">
        <h3>Article Title</h3>
        <cite>https://example.com &gt; article</cite>
      </a>
    </div>
  `;
  const actor = getPageExtractor();

  try {
    let getTextCount = countEvents(Glean.pageextractorExtraction.getText);
    await actor.getText({
      sourceUrl: "https://www.google.com/search?q=test",
    });
    let gleanEvent = await waitForGleanEvent(
      Glean.pageextractorExtraction.getText,
      getTextCount
    );
    is(
      gleanEvent.extra.site_strategy,
      "google-search",
      "The Google search results page strategy was recorded."
    );

    getTextCount = countEvents(Glean.pageextractorExtraction.getText);
    await actor.getText({ sourceUrl: "https://example.com/article" });
    gleanEvent = await waitForGleanEvent(
      Glean.pageextractorExtraction.getText,
      getTextCount
    );
    is(
      gleanEvent.extra.site_strategy,
      "",
      "No site-specific strategy is reported for a plain page."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A headless extraction should thread one flow_id through the
 * headless_extractor event, the wait-for-ready wait it performs while
 * loading the hidden browser, and the get_text event it triggers, closing
 * the correlation gap between all three.
 */
add_task(async function test_page_extractor_telemetry_headless_extractor() {
  const { html } = MLTestUtils.serveHTML();
  const { url, cleanup } = html`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Headless telemetry document</title>
      </head>
      <body>
        <div>This is a headless document</div>
      </body>
    </html>
  `;

  const headlessCount = countEvents(
    Glean.pageextractorExtraction.headlessExtractor
  );
  const waitForReadyCount = countEvents(
    Glean.pageextractorExtraction.waitForReady
  );
  const getTextCount = countEvents(Glean.pageextractorExtraction.getText);

  let capturedFlowId;
  try {
    await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, flowId) => {
        capturedFlowId = flowId;
        return pageExtractor.getText({}, flowId);
      },
    });
  } finally {
    await cleanup();
  }

  const headlessEvent = await waitForGleanEvent(
    Glean.pageextractorExtraction.headlessExtractor,
    headlessCount
  );
  const waitForReadyEvent = await waitForGleanEvent(
    Glean.pageextractorExtraction.waitForReady,
    waitForReadyCount
  );
  const getTextEvent = await waitForGleanEvent(
    Glean.pageextractorExtraction.getText,
    getTextCount
  );

  ok(capturedFlowId, "getHeadlessExtractor passed a flowId to its callback.");
  is(
    headlessEvent.extra.flow_id,
    capturedFlowId,
    "The headless_extractor event uses the flowId passed to the callback."
  );
  is(
    waitForReadyEvent.extra.flow_id,
    capturedFlowId,
    "The wait-for-ready wait performed while loading the hidden browser " +
      "shares the same flowId, instead of starting its own flow."
  );
  is(
    getTextEvent.extra.flow_id,
    capturedFlowId,
    "The get_text event triggered inside the callback shares the same flowId."
  );
});
