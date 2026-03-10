/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { getOpenTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

function createFakeTab(url, title, lastAccessed) {
  return {
    linkedBrowser: {
      currentURI: {
        spec: url,
      },
    },
    label: title,
    lastAccessed,
  };
}

function createFakeWindow(tabs, closed = false, isAIWindow = true) {
  return {
    closed,
    gBrowser: {
      tabs,
    },
    document: {
      documentElement: {
        hasAttribute: attr => attr === "ai-window" && isAIWindow,
      },
    },
  };
}

function setupPageDataServiceMock(sandbox, descriptionMap = {}) {
  const PageDataService = ChromeUtils.importESModule(
    "moz-src:///browser/components/pagedata/PageDataService.sys.mjs"
  ).PageDataService;

  sandbox.stub(PageDataService, "getCached").callsFake(url => {
    if (url in descriptionMap) {
      return { description: descriptionMap[url] };
    }
    return null;
  });

  sandbox.stub(PageDataService, "fetchPageData").callsFake(async url => {
    if (url in descriptionMap) {
      return { description: descriptionMap[url] };
    }
    return null;
  });
}

add_task(async function test_getOpenTabs_basic() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const fakeWindow = createFakeWindow([
      createFakeTab("https://example.com", "Example", 1000),
      createFakeTab("https://mozilla.org", "Mozilla", 2000),
      createFakeTab("https://firefox.com", "Firefox", 3000),
    ]);

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb, {
      "https://firefox.com": "Firefox browser homepage",
      "https://mozilla.org": "Mozilla organization site",
    });

    const tabs = await getOpenTabs();

    Assert.equal(tabs.length, 3, "Should return all 3 tabs");
    Assert.equal(tabs[0].url, "https://firefox.com", "Most recent tab first");
    Assert.equal(tabs[0].title, "Firefox", "Title should match");
    // @todo Bug2009194
    // Assert.equal(
    //   tabs[0].description,
    //   "Firefox browser homepage",
    //   "Description should be fetched"
    // );
    Assert.equal(tabs[1].url, "https://mozilla.org", "Second most recent tab");
    // @todo Bug2009194
    // Assert.equal(
    //   tabs[1].description,
    //   "Mozilla organization site",
    //   "Description should be fetched"
    // );
    Assert.equal(tabs[2].url, "https://example.com", "Least recent tab");
    Assert.equal(
      tabs[2].description,
      "",
      "Description should be empty when not available"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_filters_non_web_urls() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const fakeWindow = createFakeWindow([
      createFakeTab("https://example.com", "Example", 1000),
      createFakeTab("about:preferences", "Preferences", 2000),
      createFakeTab("about:config", "Config", 3000),
      createFakeTab("https://mozilla.org", "Mozilla", 4000),
      createFakeTab("about:blank", "Blank", 5000),
      createFakeTab("chrome://browser/content/browser.xhtml", "Chrome", 6000),
      createFakeTab("moz-extension://abc/page.html", "Extension", 7000),
      createFakeTab("file:///home/user/doc.html", "Local File", 8000),
      createFakeTab("data:text/html,hello", "Data URL", 9000),
    ]);

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb);

    const tabs = await getOpenTabs();

    Assert.equal(
      tabs.length,
      2,
      "Should only return http/https tabs (filtered 7)"
    );
    Assert.equal(
      tabs[0].url,
      "https://mozilla.org",
      "Should return mozilla.org"
    );
    Assert.equal(tabs[1].url, "https://example.com", "Should return example");
    Assert.ok(
      tabs.every(
        t => t.url.startsWith("https://") || t.url.startsWith("http://")
      ),
      "Only http/https URLs in results"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_pagination() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const tabs = [];
    for (let i = 0; i < 20; i++) {
      tabs.push(
        createFakeTab(`https://example${i}.com`, `Example ${i}`, i * 1000)
      );
    }
    const fakeWindow = createFakeWindow(tabs);

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb);

    // Test hardcoded limit
    const defaultResult = await getOpenTabs();
    Assert.equal(defaultResult.length, 15, "Should return 15 tabs");
    Assert.equal(
      defaultResult[0].url,
      "https://example19.com",
      "First tab should be most recent"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_filters_non_ai_windows() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const aiWindow = createFakeWindow(
      [
        createFakeTab("https://ai1.com", "AI Tab 1", 1000),
        createFakeTab("https://ai2.com", "AI Tab 2", 2000),
      ],
      false,
      true
    );

    const classicWindow = createFakeWindow(
      [
        createFakeTab("https://classic1.com", "Classic Tab 1", 3000),
        createFakeTab("https://classic2.com", "Classic Tab 2", 4000),
      ],
      false,
      false
    );

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [
      classicWindow,
      aiWindow,
    ]);
    setupPageDataServiceMock(sb);

    const tabs = await getOpenTabs();

    Assert.equal(
      tabs.length,
      2,
      "Should only return tabs from AI Windows (filtered 2 classic tabs)"
    );
    Assert.equal(tabs[0].url, "https://ai2.com", "Most recent AI tab");
    Assert.equal(tabs[1].url, "https://ai1.com", "Second AI tab");
    Assert.ok(
      !tabs.some(t => t.url.includes("classic")),
      "No classic window tabs in results"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_return_structure() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const fakeWindow = createFakeWindow([
      createFakeTab("https://test.com", "Test Page", 1000),
    ]);

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb, {
      "https://test.com": "A test page description",
    });

    const tabs = await getOpenTabs();

    Assert.equal(tabs.length, 1, "Should return one tab");

    const tab = tabs[0];
    Assert.ok("url" in tab, "Tab should have url property");
    Assert.ok("title" in tab, "Tab should have title property");
    Assert.ok("description" in tab, "Tab should have description property");
    Assert.ok("lastAccessed" in tab, "Tab should have lastAccessed property");

    Assert.equal(typeof tab.url, "string", "url should be a string");
    Assert.equal(typeof tab.title, "string", "title should be a string");
    Assert.equal(
      typeof tab.description,
      "string",
      "description should be a string"
    );
    Assert.equal(
      typeof tab.lastAccessed,
      "number",
      "lastAccessed should be a number"
    );

    Assert.equal(tab.url, "https://test.com", "url value correct");
    Assert.equal(tab.title, "Test Page", "title value correct");
    // @todo Bug2009194
    // Assert.equal(
    //   tab.description,
    //   "A test page description",
    //   "description should be fetched from PageDataService"
    // );
    Assert.equal(tab.lastAccessed, 1000, "lastAccessed value correct");
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_truncates_long_titles() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const longTitle = "A".repeat(150);
    const fakeWindow = createFakeWindow([
      createFakeTab("https://example.com", longTitle, 2000),
      createFakeTab("https://mozilla.org", "Short Title", 1000),
    ]);

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb);

    const tabs = await getOpenTabs();

    Assert.equal(tabs.length, 2, "Should return 2 tabs");
    Assert.equal(
      tabs[0].title.length,
      101,
      "Long title truncated to 100 chars + ellipsis"
    );
    Assert.equal(
      tabs[0].title,
      "A".repeat(100) + "\u2026",
      "100 chars + ellipsis"
    );
    Assert.equal(tabs[1].title, "Short Title", "Short title unchanged");
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_ignores_llm_params() {
  // Bug 2020796: LLM must not be able to control the tab limit.
  // getOpenTabs ignores any params passed to it; limit is always MAX_TABS=15.
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const tabs = [];
    for (let i = 0; i < 20; i++) {
      tabs.push(
        createFakeTab(`https://example${i}.com`, `Example ${i}`, i * 1000)
      );
    }
    const fakeWindow = createFakeWindow(tabs);
    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb);

    // Even if the LLM passes a large n, the result is always capped at 15
    const result = await getOpenTabs({ n: 9999 });
    Assert.equal(result.length, 15, "LLM-supplied n param has no effect");
  } finally {
    sb.restore();
  }
});

add_task(async function test_getOpenTabs_skips_null_url_tabs() {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  const sb = sinon.createSandbox();

  try {
    const fakeWindow = createFakeWindow([
      createFakeTab("https://example.com", "Example", 1000),
      // Tab with null URL (e.g. a tab still loading)
      {
        linkedBrowser: { currentURI: null },
        label: "Loading",
        lastAccessed: 2000,
      },
      // Tab with undefined currentURI
      { linkedBrowser: {}, label: "No URI", lastAccessed: 3000 },
    ]);

    sb.stub(BrowserWindowTracker, "orderedWindows").get(() => [fakeWindow]);
    setupPageDataServiceMock(sb);

    const tabs = await getOpenTabs();

    Assert.equal(tabs.length, 1, "Tabs with null/missing URL are skipped");
    Assert.equal(tabs[0].url, "https://example.com", "Valid tab returned");
  } finally {
    sb.restore();
  }
});
