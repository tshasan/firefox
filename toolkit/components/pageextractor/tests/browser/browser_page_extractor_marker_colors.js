/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);

/**
 * Drives one real success, one real handled outcome ("document-hidden"),
 * and one real error ("TimeoutError") through PageExtractor: no internals
 * are stubbed, and every status comes from an actual page load. Asserts the
 * resulting marker colors, then dumps the captured profile to disk so it
 * can be dragged into https://profiler.firefox.com to see the blue/yellow/
 * red PageExtractor markers in the marker chart.
 */
add_task(async function test_page_extractor_marker_colors() {
  const { PageExtractorParent } = ChromeUtils.importESModule(
    "resource://gre/actors/PageExtractorParent.sys.mjs"
  );

  await ProfilerTestUtils.startProfilerForMarkerTests();

  // Blue: a normal foreground extraction succeeds.
  const { html: foregroundHtml } = await MLTestUtils.serveHTMLInTab({
    browser: gBrowser,
  });
  const { getPageExtractor, cleanup: cleanupForeground } = await foregroundHtml`
    <article>
      <h1>Marker colors test</h1>
      <p>This content is extracted to produce a success marker.</p>
    </article>
  `;
  await getPageExtractor().getText();

  // Yellow: on a backgrounded tab, document.hidden is genuinely true, so
  // wait-for-ready finishes as "document-hidden" instead of "success".
  const { html } = MLTestUtils.serveHTML();
  const { url: bgUrl, cleanup: cleanupBgServer } = html`
    <!DOCTYPE html>
    <body>
      Background tab content
    </body>
  `;
  const backgroundTab = await BrowserTestUtils.addTab(gBrowser, bgUrl, {
    inBackground: true,
  });
  await BrowserTestUtils.browserLoaded(backgroundTab.linkedBrowser);
  const backgroundExtractor =
    backgroundTab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
      "PageExtractor"
    );
  await backgroundExtractor.waitForPageReady();

  // Red: a headless load that never commits genuinely times out.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.pageExtractor.headlessTimeoutMs", 500]],
  });
  const { url: stalledUrl, cleanup: cleanupStalled } =
    MLTestUtils.serveStalledPage();
  await Assert.rejects(
    PageExtractorParent.getHeadlessExtractor({
      urlString: stalledUrl,
      callback: () => ok(false, "The callback must not run."),
    }),
    /did not load in a headless browser within 500ms/,
    "The stalled page times out."
  );

  const profile = await ProfilerTestUtils.stopNowAndGetProfile();

  await cleanupForeground();
  BrowserTestUtils.removeTab(backgroundTab);
  await cleanupBgServer();
  await cleanupStalled();
  await SpecialPowers.popPrefEnv();

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const successMarker = markers.find(
    m => m.phase === "get-text" && m.status === "success"
  );
  const hiddenMarker = markers.find(
    m => m.phase === "wait-for-ready" && m.status === "document-hidden"
  );
  const errorMarker = markers.find(
    m => m.phase === "headless-navigate" && m.status === "error"
  );
  ok(successMarker, "A success marker was recorded.");
  ok(hiddenMarker, "A document-hidden marker was recorded.");
  ok(errorMarker, "An error marker was recorded.");
  is(successMarker.color, "blue", "Success renders blue.");
  is(hiddenMarker.color, "yellow", "A handled outcome renders yellow.");
  is(errorMarker.color, "red", "An error renders red.");

  const path = PathUtils.join(
    PathUtils.tempDir,
    "page_extractor_marker_colors.json"
  );
  await IOUtils.writeUTF8(path, JSON.stringify(profile));
  info(
    `Profile written to ${path} -- drag it into ` +
      "https://profiler.firefox.com to see the blue/yellow/red PageExtractor markers."
  );
});
