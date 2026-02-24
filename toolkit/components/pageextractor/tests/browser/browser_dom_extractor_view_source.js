/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Open a view-source: tab for a page served with the given HTML markup.
 *
 * @param {string} markup
 */
async function viewSource(markup) {
  markup = `<!DOCTYPE html><body>${markup}</body>`;

  const { url, serverClosed } = serveOnce(markup);
  const viewSourceUrl = `view-source:${url}`;

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    viewSourceUrl,
    true // waitForLoad
  );

  return {
    markup,
    getPageExtractor() {
      return tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
        "PageExtractor"
      );
    },
    async cleanup() {
      info("Cleaning up");
      await serverClosed;
      BrowserTestUtils.removeTab(tab);
    },
  };
}

add_task(async function test_view_source_get_text() {
  const { markup, getPageExtractor, cleanup } = await viewSource(
    "<h1>Hello</h1><p>World</p>"
  );

  const result = await getPageExtractor().getText();

  ok(result, "getText() should return a result");
  Assert.greater(
    result.text.length,
    0,
    "getText() should return non-empty text"
  );
  ok(
    result.text.includes("<h1>"),
    "getText() should include the raw source markup"
  );
  ok(result.text.includes(markup), "getText() should contain the full markup");
  Assert.deepEqual(result.links, [], "getText() should return no links");
  Assert.deepEqual(
    result.canvasSnapshots,
    [],
    "getText() should return no canvas snapshots"
  );

  await cleanup();
});

add_task(async function test_view_source_reader_mode_returns_null() {
  const { getPageExtractor, cleanup } = await viewSource(
    "<h1>Hello</h1><p>World</p>"
  );

  const result = await getPageExtractor().getReaderModeContent();

  is(
    result,
    null,
    "getReaderModeContent() should return null for view-source pages"
  );

  await cleanup();
});

add_task(async function test_view_source_max_length() {
  const { getPageExtractor, cleanup } = await viewSource(
    "<p>This is a longer piece of content for truncation testing.</p>"
  );

  const maxLength = 20;
  const result = await getPageExtractor().getText({ maxLength });

  Assert.lessOrEqual(
    result.text.length,
    maxLength,
    "getText() should respect maxLength"
  );

  await cleanup();
});

add_task(async function test_view_source_normalize_whitespace() {
  const { getPageExtractor, cleanup } = await viewSource("<p>Hello</p>");

  const result = await getPageExtractor().getText({
    normalizeWhitespace: true,
  });

  ok(result, "getText() with normalizeWhitespace should return a result");
  ok(
    !/\s{2,}/.test(result.text),
    "Whitespace should be collapsed to single spaces"
  );

  await cleanup();
});
