/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { GetPageContent, runExtraction } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

function createFakeBrowser(url, hasBrowsingContext = true) {
  const parsedUrl = new URL(url);
  const browser = {
    currentURI: {
      spec: url,
      hostPort: parsedUrl.host,
    },
  };

  if (hasBrowsingContext) {
    browser.browsingContext = {
      currentWindowContext: {
        getActor: sinon.stub().resolves({
          getText: sinon.stub().resolves({ text: "Sample page content" }),
          getReaderModeContent: sinon.stub().resolves(null),
        }),
      },
    };
  } else {
    browser.browsingContext = null;
  }

  return browser;
}

function createFakeTab(url, title, hasBrowsingContext = true) {
  return {
    linkedBrowser: createFakeBrowser(url, hasBrowsingContext),
    label: title,
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

function setupBrowserWindowTracker(sandbox, windows) {
  const BrowserWindowTracker = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  ).BrowserWindowTracker;

  let windowArray;
  if (windows === null) {
    windowArray = [];
  } else if (Array.isArray(windows)) {
    windowArray = windows;
  } else {
    windowArray = [windows];
  }
  sandbox.stub(BrowserWindowTracker, "orderedWindows").get(() => windowArray);
}

add_task(async function test_getPageContent_exact_url_match() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/page";
    const tabs = [
      createFakeTab("https://other.com", "Other"),
      createFakeTab(targetUrl, "Example Page"),
    ];

    setupBrowserWindowTracker(sb, createFakeWindow(tabs));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );

    const result = result_array[0];

    Assert.ok(result, "Result should have text property");
    Assert.ok(result.includes("Example Page"), "Should include page title");
    Assert.ok(
      result.includes("Sample page content"),
      "Should include page content"
    );
    Assert.ok(
      result.includes(targetUrl),
      "Should include URL in result message"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_hostname_match() {
  const sb = sinon.createSandbox();

  try {
    const tabs = [
      createFakeTab("https://example.com/page", "Example Page"),
      createFakeTab("https://other.com", "Other"),
    ];

    setupBrowserWindowTracker(sb, createFakeWindow(tabs));

    const result_array = await GetPageContent.getPageContent(
      { url_list: ["http://example.com/different"] },
      new Set(["http://example.com/different"])
    );

    const result = result_array[0];

    Assert.ok(
      result.includes("Example Page"),
      "Should match by hostname when exact match fails"
    );
    Assert.ok(
      result.includes("Sample page content"),
      "Should include page content"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_tab_not_found_with_allowed_url() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://external.com/article";
    const tabs = [
      createFakeTab("https://example.com", "Example"),
      createFakeTab("https://other.com", "Other"),
    ];

    setupBrowserWindowTracker(sb, createFakeWindow(tabs));

    const allowedUrls = new Set([targetUrl]);
    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      allowedUrls
    );

    const result = result_array[0];

    // Headless extraction doesn't work in xpcshell environment
    // In real usage, this would attempt headless extraction for allowed URLs
    Assert.ok(
      result.includes("Cannot find URL"),
      "Should return error when tab not found (headless doesn't work in xpcshell)"
    );
    Assert.ok(result.includes(targetUrl), "Should include target URL in error");
  } finally {
    sb.restore();
  }
});

add_task(
  async function test_getPageContent_tab_not_found_without_allowed_url() {
    const sb = sinon.createSandbox();

    try {
      const targetUrl = "https://notfound.com/page";
      const tabs = [
        createFakeTab("https://example.com", "Example"),
        createFakeTab("https://other.com", "Other"),
        createFakeTab("https://third.com", "Third"),
        createFakeTab("https://fourth.com", "Fourth"),
      ];

      setupBrowserWindowTracker(sb, createFakeWindow(tabs));

      const allowedUrls = new Set(["https://different.com"]);

      // When URL is not in allowedUrls, it attempts headless extraction
      // This doesn't work in xpcshell, so we expect an error
      let errorThrown = false;
      try {
        await GetPageContent.getPageContent(
          { url_list: [targetUrl] },
          allowedUrls
        );
      } catch (error) {
        errorThrown = true;
        Assert.ok(
          error.message.includes("addProgressListener"),
          "Should fail with headless browser error in xpcshell"
        );
      }

      Assert.ok(
        errorThrown,
        "Should throw error when attempting headless extraction in xpcshell"
      );
    } finally {
      sb.restore();
    }
  }
);

add_task(async function test_getPageContent_no_browsing_context() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/loading";
    const tabs = [createFakeTab(targetUrl, "Loading Page", false)];

    setupBrowserWindowTracker(sb, createFakeWindow(tabs));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );
    const result = result_array[0];

    Assert.ok(
      result.includes("Cannot access content"),
      "Should return error for unavailable browsing context"
    );
    Assert.ok(
      result.includes("Loading Page"),
      "Should include tab label in error"
    );
    Assert.ok(
      result.includes(targetUrl),
      "Should include URL in error message"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_successful_extraction() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/article";
    const pageContent = "This is a well-written article with lots of content.";

    const mockExtractor = {
      getText: sinon.stub().resolves({ text: pageContent }),
      getReaderModeContent: sinon.stub().resolves(null),
    };

    const tab = createFakeTab(targetUrl, "Article");
    tab.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor);

    setupBrowserWindowTracker(sb, createFakeWindow([tab]));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );

    const result = result_array[0];

    Assert.ok(result.includes("Content (full page)"), "Should indicate mode");
    Assert.ok(result.includes("Article"), "Should include tab title");
    Assert.ok(result.includes(targetUrl), "Should include URL");
    Assert.ok(result.includes(pageContent), "Should include extracted content");
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_passes_extraction_options() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/long";
    const longContent = "A".repeat(15000);

    const mockExtractor = {
      getText: sinon.stub().resolves({ text: longContent }),
      getReaderModeContent: sinon.stub().resolves(null),
    };

    const tab = createFakeTab(targetUrl, "Long Page");
    tab.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor);

    setupBrowserWindowTracker(sb, createFakeWindow([tab]));

    await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );

    const callArgs = mockExtractor.getText.firstCall.args[0];
    Assert.ok(
      callArgs.normalizeWhitespace,
      "Should pass normalizeWhitespace option to extractor"
    );
    Assert.equal(
      callArgs.maxLength,
      GetPageContent.MAX_CHARACTERS,
      "Should pass maxLength option to extractor"
    );
    Assert.equal(
      callArgs.sufficientLength,
      GetPageContent.MAX_CHARACTERS,
      "Should pass sufficientLength for early-stop optimization"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_empty_content() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/empty";

    // Simulate what a real extractor returns for whitespace-only content
    // after normalizeWhitespace collapses it to empty.
    const mockExtractor = {
      getText: sinon.stub().resolves({ text: "" }),
      getReaderModeContent: sinon.stub().resolves(null),
    };

    const tab = createFakeTab(targetUrl, "Empty Page");
    tab.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor);

    setupBrowserWindowTracker(sb, createFakeWindow([tab]));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );

    const result = result_array[0];

    Assert.ok(
      result.includes("returned no content"),
      "Should return no content message for empty page"
    );
    Assert.ok(result.includes("Empty Page"), "Should include tab label");
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_extraction_error() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/error";

    const mockExtractor = {
      getText: sinon.stub().rejects(new Error("Extraction failed")),
      getReaderModeContent: sinon.stub().resolves(null),
    };

    const tab = createFakeTab(targetUrl, "Error Page");
    tab.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor);

    setupBrowserWindowTracker(sb, createFakeWindow([tab]));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );

    const result = result_array[0];

    Assert.ok(
      result.includes("returned no content"),
      "Should handle extraction error gracefully"
    );
    Assert.ok(result.includes("Error Page"), "Should include tab label");
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_reader_mode_string() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/reader";
    const readerContent = "Clean reader mode text";

    const mockExtractor = {
      getText: sinon.stub().resolves({ text: "Full content" }),
      getReaderModeContent: sinon.stub().resolves({ text: readerContent }),
    };

    const tab = createFakeTab(targetUrl, "Reader Test");
    tab.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor);

    setupBrowserWindowTracker(sb, createFakeWindow([tab]));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );

    const result = result_array[0];

    Assert.ok(
      result.includes("Content (reader mode)"),
      "Should use reader mode by default"
    );
    Assert.ok(
      result.includes(readerContent),
      "Should include reader mode content"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_invalid_url_format() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "not-a-valid-url";
    const tabs = [createFakeTab("https://example.com", "Example")];

    setupBrowserWindowTracker(sb, createFakeWindow(tabs));

    // Add URL to allowed list so it searches tabs instead of trying headless
    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );
    const result = result_array[0];

    Assert.ok(
      result.includes("Cannot find URL"),
      "Should handle invalid URL format"
    );
  } finally {
    sb.restore();
  }
});

add_task(
  {
    pref_set: [["browser.smartwindow.checkSecurityFlags", true]],
  },
  async function test_getPageContent_refuses_both_security_flags() {
    const result = await GetPageContent.getPageContent(
      { url_list: ["https://example.com"] },
      new Set(),
      { untrusted_input: true, private_data: true }
    );
    Assert.equal(result.length, 1, "Should return one message");
    Assert.ok(
      result[0].includes("not available"),
      "Should return refusal message when both security flags are set"
    );
  }
);

add_task(
  {
    pref_set: [["browser.smartwindow.checkSecurityFlags", false]],
  },
  async function test_getPageContent_pref_disables_security_check() {
    const sb = sinon.createSandbox();
    try {
      const targetUrl = "https://example.com/page";
      const tabs = [createFakeTab(targetUrl, "Example Page")];
      setupBrowserWindowTracker(sb, createFakeWindow(tabs));

      const result = await GetPageContent.getPageContent(
        { url_list: [targetUrl] },
        new Set([targetUrl]),
        { untrusted_input: true, private_data: true }
      );
      Assert.equal(result.length, 1, "Should return one result");
      Assert.ok(
        result[0].includes("Example Page"),
        "Should return real content, not a refusal, when pref is false"
      );
    } finally {
      sb.restore();
    }
  }
);

add_task(
  {
    pref_set: [["browser.smartwindow.checkSecurityFlags", true]],
  },
  async function test_getPageContent_allows_untrusted_input_only() {
    const sb = sinon.createSandbox();
    try {
      const targetUrl = "https://example.com/page";
      const tabs = [createFakeTab(targetUrl, "Example Page")];
      setupBrowserWindowTracker(sb, createFakeWindow(tabs));

      const result = await GetPageContent.getPageContent(
        { url_list: [targetUrl] },
        new Set([targetUrl]),
        { untrusted_input: true, private_data: false }
      );
      Assert.equal(result.length, 1, "Should return one result");
      Assert.ok(
        result[0].includes("Example Page"),
        "Should return real content, not a refusal"
      );
    } finally {
      sb.restore();
    }
  }
);

add_task(async function test_getPageContent_does_not_mutate_security_flags() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/page";
    const tabs = [createFakeTab(targetUrl, "Example Page")];
    setupBrowserWindowTracker(sb, createFakeWindow(tabs));

    const secProps = { untrusted_input: false, private_data: false };
    await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl]),
      secProps
    );

    Assert.strictEqual(
      secProps.untrusted_input,
      false,
      "getPageContent should not mutate untrusted_input"
    );
    Assert.strictEqual(
      secProps.private_data,
      false,
      "getPageContent should not mutate private_data"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_includes_links_in_output() {
  const sb = sinon.createSandbox();

  try {
    const targetUrl = "https://example.com/links";
    const pageLinks = [
      "https://example.com/about",
      "https://example.com/contact",
    ];

    const mockExtractor = {
      getText: sinon.stub().resolves({ text: "Page text", links: pageLinks }),
      getReaderModeContent: sinon.stub().resolves(null),
    };

    const tab = createFakeTab(targetUrl, "Links Page");
    tab.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor);

    setupBrowserWindowTracker(sb, createFakeWindow([tab]));

    const result_array = await GetPageContent.getPageContent(
      { url_list: [targetUrl] },
      new Set([targetUrl])
    );
    const result = result_array[0];

    Assert.ok(
      result.includes("Links found on page"),
      "Should have links section"
    );
    Assert.ok(
      result.includes("https://example.com/about"),
      "Should include first link"
    );
    Assert.ok(
      result.includes("https://example.com/contact"),
      "Should include second link"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPageContent_tab_index_efficiency() {
  const sb = sinon.createSandbox();

  try {
    const url1 = "https://example.com/page1";
    const url2 = "https://other.com/page2";

    const mockExtractor1 = {
      getText: sinon.stub().resolves({ text: "Content 1" }),
      getReaderModeContent: sinon.stub().resolves(null),
    };
    const mockExtractor2 = {
      getText: sinon.stub().resolves({ text: "Content 2" }),
      getReaderModeContent: sinon.stub().resolves(null),
    };

    const tab1 = createFakeTab(url1, "Page 1");
    tab1.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor1);
    const tab2 = createFakeTab(url2, "Page 2");
    tab2.linkedBrowser.browsingContext.currentWindowContext.getActor = sinon
      .stub()
      .resolves(mockExtractor2);

    setupBrowserWindowTracker(sb, createFakeWindow([tab1, tab2]));

    const results = await GetPageContent.getPageContent(
      { url_list: [url1, url2] },
      new Set([url1, url2])
    );

    Assert.equal(results.length, 2, "Should return results for both URLs");
    Assert.ok(results[0].includes("Content 1"), "First result matches");
    Assert.ok(results[1].includes("Content 2"), "Second result matches");
  } finally {
    sb.restore();
  }
});

add_task(async function test_runExtraction_sufficientLength_is_passed() {
  const maxLen = 5000;
  const mockExtractor = {
    getText: sinon.stub().resolves({ text: "content" }),
    getReaderModeContent: sinon.stub().resolves(null),
  };

  await runExtraction(mockExtractor, {
    mode: "full",
    label: "test",
    maxLength: maxLen,
  });

  const opts = mockExtractor.getText.firstCall.args[0];
  Assert.equal(opts.maxLength, maxLen, "maxLength forwarded");
  Assert.equal(
    opts.sufficientLength,
    maxLen,
    "sufficientLength set equal to maxLength for early-stop"
  );
  Assert.ok(opts.normalizeWhitespace, "normalizeWhitespace enabled");
});

add_task(async function test_runExtraction_reader_fallback_to_full() {
  const mockExtractor = {
    getReaderModeContent: sinon.stub().resolves(null),
    getText: sinon.stub().resolves({ text: "full page fallback" }),
  };

  const result = await runExtraction(mockExtractor, {
    mode: "reader",
    label: "fallback test",
  });

  Assert.ok(
    mockExtractor.getReaderModeContent.calledOnce,
    "Tried reader mode first"
  );
  Assert.ok(mockExtractor.getText.calledOnce, "Fell back to full mode");
  Assert.ok(result.includes("full page"), "Mode label indicates full page");
  Assert.ok(result.includes("full page fallback"), "Content from getText");
});

add_task(async function test_runExtraction_includes_links() {
  const links = ["https://a.com", "https://b.com"];
  const mockExtractor = {
    getReaderModeContent: sinon.stub().resolves(null),
    getText: sinon.stub().resolves({ text: "body text", links }),
  };

  const result = await runExtraction(mockExtractor, {
    mode: "full",
    label: "link test",
  });

  Assert.ok(result.includes("Links found on page"), "Links section present");
  Assert.ok(result.includes("https://a.com"), "First link included");
  Assert.ok(result.includes("https://b.com"), "Second link included");
});

add_task(async function test_runExtraction_no_links_section_when_empty() {
  const mockExtractor = {
    getReaderModeContent: sinon.stub().resolves(null),
    getText: sinon.stub().resolves({ text: "body text", links: [] }),
  };

  const result = await runExtraction(mockExtractor, {
    mode: "full",
    label: "no links",
  });

  Assert.ok(
    !result.includes("Links found on page"),
    "No links section when links array is empty"
  );
});

add_task(async function test_runExtraction_no_content() {
  const mockExtractor = {
    getReaderModeContent: sinon.stub().resolves(null),
    getText: sinon.stub().resolves({ text: "" }),
  };

  const result = await runExtraction(mockExtractor, {
    mode: "reader",
    label: "empty label",
  });

  Assert.ok(
    result.includes("returned no content"),
    "Returns no-content message"
  );
  Assert.ok(result.includes("empty label"), "Label included in message");
});

add_task(async function test_runExtraction_viewport_mode() {
  const mockExtractor = {
    getText: sinon.stub().resolves({ text: "viewport text" }),
  };

  const result = await runExtraction(mockExtractor, {
    mode: "viewport",
    label: "vp test",
  });

  Assert.ok(result.includes("current viewport"), "Mode label is viewport");
  Assert.ok(result.includes("viewport text"), "Content from viewport");

  const opts = mockExtractor.getText.firstCall.args[0];
  Assert.ok(opts.justViewport, "justViewport flag set for viewport mode");
});

add_task(async function test_runExtraction_invalid_mode_defaults_to_reader() {
  const mockExtractor = {
    getReaderModeContent: sinon.stub().resolves({ text: "reader content" }),
    getText: sinon.stub(),
  };

  const result = await runExtraction(mockExtractor, {
    mode: "bogus_mode",
    label: "test",
  });

  Assert.ok(
    mockExtractor.getReaderModeContent.calledOnce,
    "Invalid mode falls back to reader"
  );
  Assert.ok(result.includes("reader mode"), "Mode label is reader");
});
