/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Security coverage for the get_open_tabs tool. Test 1 runs end-to-end:
 * the mocked language model deterministically returns a tool_call for
 * get_open_tabs so we exercise the real Chat -> Tools.getOpenTabs ->
 * ChatConversation path. Test 2 validates the MAX_TABS cap and sort order
 * by calling getOpenTabs directly with a stub conversation, since opening
 * MAX_TABS+1 foreground tabs doesn't need the chat round-trip on top.
 */

/**
 * @type {import("../../../../../../toolkit/components/ml/tests/MLTestUtils.sys.mjs")}
 */
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);

const { GET_OPEN_TABS, getOpenTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { MESSAGE_ROLE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs"
);

const { sanitizeUntrustedContent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs"
);

/**
 * @import { MockLLMEngine, MockedResponse } from "../../../../../../toolkit/components/ml/tests/MLTestUtils.sys.mjs"
 * @import { ChatConversation } from "../../modules/ChatConversation.sys.mjs"
 */

/**
 * Manages the MockLLMEngine for Smart Window in this test. Mirrors the
 * inline copy in browser_security_chat.js, with the polling-based wait
 * replaced by a Promise.withResolvers-based wait so respondTo() doesn't
 * spin while waiting for the engine to be created or for a request to
 * arrive.
 */
class MockEngineManager {
  /** @type {Map<string, MockLLMEngine>} */
  #engines = new Map();
  /** @type {Map<string, {promise: Promise<MockLLMEngine>, resolve: (engine: MockLLMEngine) => void, reject: (err: Error) => void}>} */
  #pendingEngineWaits = new Map();
  /** @type {any[]} */
  mocks;

  constructor() {
    this.mocks = [
      sinon.stub(openAIEngine, "_createEngine").callsFake(options => {
        const { purpose } = options;
        const engine = this.#engines.getOrInsertComputed(
          purpose,
          () => new MLTestUtils.MockLLMEngine(options)
        );
        const pending = this.#pendingEngineWaits.get(purpose);
        if (pending) {
          this.#pendingEngineWaits.delete(purpose);
          pending.resolve(engine);
        }
        return engine;
      }),
      sinon.stub(openAIEngine, "getFxAccountToken").resolves("mock-fxa-token"),
    ];
  }

  /**
   * Resolve as soon as the engine with the given purpose has been created,
   * without polling.
   *
   * @param {string} purpose
   * @returns {Promise<MockLLMEngine>}
   */
  #waitForEngine(purpose) {
    const existing = this.#engines.get(purpose);
    if (existing) {
      return Promise.resolve(existing);
    }
    let pending = this.#pendingEngineWaits.get(purpose);
    if (!pending) {
      const { promise, resolve, reject } = Promise.withResolvers();
      pending = { promise, resolve, reject };
      this.#pendingEngineWaits.set(purpose, pending);
    }
    return pending.promise;
  }

  /**
   * Provide the response for an engine. The engine purpose is the "purpose"
   * provided to the PipelineOptions when creating an engine.
   *
   * @param {object} options
   * @param {string} options.purpose
   * @param {MockedResponse} options.response
   */
  async respondTo({ purpose, response }) {
    info(`[MockEngineManager] Getting the engine with purpose "${purpose}"`);
    /** @type {MockLLMEngine} */
    const engine = await this.#waitForEngine(purpose);
    info(
      `[MockEngineManager] Waiting for the run request for the engine with purpose "${purpose}"`
    );
    await engine.waitForNextRequest();
    const [requestId] = engine.getNextRequest();
    if (typeof response === "string") {
      info(
        `[MockEngineManager] Responding to "${purpose}" engine: ${response}`
      );
    } else {
      info(`[MockEngineManager] Responding to "${purpose}" engine:`);
      console.log(response);
    }
    engine.respond(requestId, response);
  }

  rejectAllRequests() {
    for (const [purpose, engine] of this.#engines) {
      if (engine.runRequests.size) {
        info(
          `[MockEngineManager] Intentionally rejecting any pending requests for engine "${purpose}"`
        );
        engine.rejectAllRequests();
      }
    }
  }

  cleanupMocks() {
    for (const mock of this.mocks) {
      mock.restore();
    }
    for (const [, pending] of this.#pendingEngineWaits) {
      pending.reject(
        new Error("MockEngineManager torn down before engine was created.")
      );
    }
    this.#pendingEngineWaits.clear();
  }
}

// Mirrors the constants the implementation uses. If either of these change,
// the implementation has to revisit security review, so this test should
// also be updated.
const MAX_METADATA_LENGTH = 100;
const MAX_TABS = 15;

/**
 * Wait until the get_open_tabs tool result message has been appended to the
 * conversation, then return it.
 *
 * @param {ChatConversation} conversation
 */
async function waitForGetOpenTabsResult(conversation) {
  return BrowserTestUtils.waitForCondition(
    () =>
      conversation.messages.find(
        m => m.role === MESSAGE_ROLE.TOOL && m.content?.name === GET_OPEN_TABS
      ),
    "A tool result for get_open_tabs should be added to the conversation."
  );
}

/**
 * Verifies end to end that the data returned to the model is exactly the
 * sanitized url/title/lastAccessed triple the tool produces, that titles are
 * spotlighted and truncated, that internal pages are filtered out, and that
 * the conversation security flags transition correctly.
 */
add_task(async function test_get_open_tabs_returns_sanitized_data() {
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();
  const mockEngineManager = new MockEngineManager();
  const server = await MLTestUtils.serveSharedHTMLInTab({
    browser: win.gBrowser,
  });

  // serveSharedHTMLInTab opens each tab as the foreground tab, so the natural
  // order for lastAccessed is openOrder[0] < openOrder[1] < openOrder[2].
  // After sort-by-lastAccessed-desc, get_open_tabs returns the reverse.
  const shortTitle = "Short News Article";
  const longTitle = "A".repeat(MAX_METADATA_LENGTH + 10);
  const trickyTitle = `Sneaky "quote" and \\ backslash`;

  info("Opening three http tabs with controlled titles.");
  const httpTab1 = await server.openTab({
    title: shortTitle,
    body: "<p>Tab body</p>",
  });
  const httpTab2 = await server.openTab({
    title: longTitle,
    body: "<p>Tab body</p>",
  });
  const httpTab3 = await server.openTab({
    title: trickyTitle,
    body: "<p>Tab body</p>",
  });

  info("Opening an about: tab that should be filtered out.");
  const aboutTab = await BrowserTestUtils.openNewForegroundTab(
    win.gBrowser,
    "about:preferences",
    true
  );

  // Drain any sidebar conversation-starter requests fired by the page
  // navigations above so they don't interfere with the chat flow.
  mockEngineManager.rejectAllRequests();

  info("Submit a user message in the smartbar.");
  await typeInSmartbar(sidebarBrowser, "What do I have open?");
  await submitSmartbar(sidebarBrowser);

  /** @type {ChatConversation} */
  const conversation = await BrowserTestUtils.waitForCondition(
    () => AIWindow.getActiveConversation(win),
    "Conversation should be created when the first message is sent."
  );

  // get_open_tabs has no security preconditions: it should run regardless
  // of the current flag values. Capture the initial state for comparison.
  Assert.equal(
    conversation.securityProperties.privateData,
    false,
    "privateData starts false."
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    false,
    "untrustedInput starts false."
  );

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_get_open_tabs_1",
          function: { name: GET_OPEN_TABS, arguments: "{}" },
        },
      ],
    },
  });

  const toolMessage = await waitForGetOpenTabsResult(conversation);
  const tabs = toolMessage.content.body;
  Assert.ok(Array.isArray(tabs), "Tool result body is an array of tabs.");

  // Only the three http tabs survive the allow-list filter. The initial
  // about:blank tab and the explicit about:preferences tab are both
  // filtered out by isAllowedURL.
  Assert.equal(
    tabs.length,
    3,
    "Only http/https tabs are returned; about: tabs are excluded."
  );
  Assert.ok(
    tabs.every(
      t =>
        // eslint-disable-next-line @microsoft/sdl/no-insecure-url
        t.url.startsWith("http://") || t.url.startsWith("https://")
    ),
    "Every returned tab uses http or https."
  );

  Assert.deepEqual(
    tabs.map(t => t.url),
    [httpTab3.url, httpTab2.url, httpTab1.url],
    "Tabs are sorted by lastAccessed (most recent first)."
  );

  // Each entry exposes exactly url / title / lastAccessed in that order. If
  // a new field ever appears, the security model needs to be revisited
  // because the sanitization above doesn't cover it. Asserting key creation
  // order (not just set membership) also pins the implementation to a single
  // object literal site, so every returned record shares one Shape.
  for (const tab of tabs) {
    Assert.deepEqual(
      Object.keys(tab),
      ["url", "title", "lastAccessed"],
      "Tab info exposes url, title, lastAccessed in that order."
    );
    Assert.equal(typeof tab.url, "string", "url is a string.");
    Assert.equal(typeof tab.title, "string", "title is a string.");
    Assert.equal(
      typeof tab.lastAccessed,
      "number",
      "lastAccessed is a number."
    );
    Assert.greater(tab.lastAccessed, 0, "lastAccessed is non-zero.");
  }

  const [recordTricky, recordLong, recordShort] = tabs;

  Assert.equal(
    recordShort.title,
    sanitizeUntrustedContent(shortTitle),
    "Short title matches the sanitizeUntrustedContent output exactly."
  );
  Assert.ok(
    recordShort.title.startsWith('"') && recordShort.title.includes(shortTitle),
    "Short title is wrapped in quotes for spotlighting."
  );
  Assert.ok(
    recordShort.title.endsWith("(Untrusted webpage data)"),
    "Short title is suffixed with the spotlighting tag."
  );

  Assert.equal(
    recordLong.title,
    sanitizeUntrustedContent(longTitle),
    "Long title matches the sanitizeUntrustedContent output exactly."
  );
  Assert.ok(
    recordLong.title.includes("A".repeat(MAX_METADATA_LENGTH) + "…"),
    "Long title is truncated to MAX_METADATA_LENGTH and ends with an ellipsis."
  );
  Assert.ok(
    !recordLong.title.includes("A".repeat(MAX_METADATA_LENGTH + 1)),
    "No content past the truncation cap leaks through."
  );

  // Quotes and backslashes inside a title are escaped so the spotlighted
  // wrapper can't be broken out of by adversarial titles.
  Assert.ok(
    recordTricky.title.includes('\\"quote\\"'),
    "Embedded double quotes are backslash-escaped."
  );
  Assert.ok(
    recordTricky.title.includes("\\\\"),
    "Embedded backslashes are escaped."
  );

  // The conversation flags advance to reflect that private user data was
  // surfaced. untrustedInput stays false because the title truncation +
  // spotlighting are considered enough to relax that flag (see the comment
  // in getOpenTabs and MAX_METADATA_LENGTH in ChatUtils.sys.mjs).
  Assert.equal(
    conversation.securityProperties.privateData,
    true,
    "privateData becomes true once tab info enters the conversation."
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    false,
    "untrustedInput stays false because titles are truncated and spotlighted."
  );

  // Every returned URL must also be tracked in the conversation's seen URLs
  // so that later URL-token expansion works.
  for (const tab of tabs) {
    Assert.ok(
      conversation.seenUrls.has(tab.url),
      `URL ${tab.url} is recorded in the conversation seen URLs.`
    );
  }

  // Let the chat round-trip finish so the conversation isn't left in a
  // generating state.
  await mockEngineManager.respondTo({
    purpose: "chat",
    response: "You have three tabs open.",
  });
  await mockEngineManager.respondTo({
    purpose: "title-generation",
    response: "Open tabs question",
  });

  BrowserTestUtils.removeTab(aboutTab);
  await server.cleanup();
  mockEngineManager.rejectAllRequests();
  mockEngineManager.cleanupMocks();
  await BrowserTestUtils.closeWindow(win);
});

/**
 * A minimal ChatConversation-shaped stub for the direct getOpenTabs call:
 * captures the security side-effects (setPrivateData / addSeenUrls) so they
 * can be asserted on without needing a real conversation.
 */
function createStubConversation() {
  return {
    seenUrls: [],
    securityProperties: {
      setPrivateData: sinon.spy(),
    },
    addSeenUrls(urls) {
      this.seenUrls.push(...urls);
    },
  };
}

/**
 * Direct-call coverage for getOpenTabs against a stub conversation. Skips the
 * chat round-trip because both behaviors under test (empty result with no
 * http tabs, and the MAX_TABS cap with sort order) are independent of it.
 * Two phases share a single AI window to avoid paying for a second
 * openAIWindow() — the test_get_open_tabs_returns_sanitized_data task above
 * covers the full chat path.
 */
add_task(async function test_get_open_tabs_direct_call() {
  const win = await openAIWindow();

  info("Phase 1: no http tabs are open, result should be empty.");
  const emptyStub = createStubConversation();
  const emptyTabs = await getOpenTabs(emptyStub);

  Assert.deepEqual(
    emptyTabs,
    [],
    "Returns empty array when no http tabs are open."
  );
  Assert.ok(
    emptyStub.securityProperties.setPrivateData.calledOnce,
    "setPrivateData is still called exactly once even with no matching tabs."
  );
  Assert.deepEqual(
    emptyStub.seenUrls,
    [],
    "No URLs are recorded in seenUrls when the result is empty."
  );

  info(`Phase 2: open ${MAX_TABS + 1} http tabs and verify cap + sort.`);
  const server = await MLTestUtils.serveSharedHTMLInTab({
    browser: win.gBrowser,
  });
  const openedTabs = [];
  for (let i = 0; i < MAX_TABS + 1; i++) {
    openedTabs.push(await server.openTab({ body: `<p>Tab ${i}</p>` }));
  }

  const cappedStub = createStubConversation();
  const tabs = await getOpenTabs(cappedStub);

  Assert.equal(
    tabs.length,
    MAX_TABS,
    "At most MAX_TABS tabs are returned even when more are open."
  );

  Assert.ok(
    !tabs.some(t => t.url === openedTabs[0].url),
    "The least-recently-accessed tab is dropped to fit the cap."
  );

  const expectedUrls = openedTabs
    .slice(1)
    .reverse()
    .map(t => t.url);
  Assert.deepEqual(
    tabs.map(t => t.url),
    expectedUrls,
    "Returned tabs are sorted most-recent-first."
  );

  Assert.ok(
    cappedStub.securityProperties.setPrivateData.calledOnce,
    "setPrivateData was called exactly once on the conversation."
  );
  Assert.deepEqual(
    cappedStub.seenUrls,
    tabs.map(t => t.url),
    "addSeenUrls was called with exactly the returned URLs."
  );

  await server.cleanup();
  await BrowserTestUtils.closeWindow(win);
});

/**
 * Verifies that getOpenTabs aggregates tabs from every AI window in the
 * tracker (and only from AI windows). Opens two AI windows plus places a
 * noise http tab in the main non-AI window, then asserts the noise tab is
 * excluded and the two AI-window tabs are merged into one sorted result.
 */
add_task(async function test_get_open_tabs_aggregates_across_ai_windows() {
  const winA = await openAIWindow();
  const winB = await openAIWindow();
  const server = await MLTestUtils.serveSharedHTMLInTab({
    browser: winA.gBrowser,
  });

  const tabInWinA = await server.openTab({
    title: "Tab in AI window A",
    body: "<p>A</p>",
  });

  // Opened second, so it should sort first by lastAccessed.
  const tabInWinB = await server.openTab({
    title: "Tab in AI window B",
    body: "<p>B</p>",
    browser: winB.gBrowser,
  });

  const noiseTab = await server.openTab({
    title: "Tab in non-AI window",
    body: "<p>noise</p>",
    browser: gBrowser,
  });

  const stubConversation = createStubConversation();
  const tabs = await getOpenTabs(stubConversation);

  Assert.equal(
    tabs.length,
    2,
    "Only the two AI-window tabs are returned; non-AI window is filtered out."
  );
  Assert.deepEqual(
    new Set(tabs.map(t => t.url)),
    new Set([tabInWinA.url, tabInWinB.url]),
    "Result contains exactly the tabs from both AI windows."
  );
  Assert.ok(
    !tabs.some(t => t.url === noiseTab.url),
    "Tabs from non-AI windows are excluded."
  );
  Assert.equal(
    tabs[0].url,
    tabInWinB.url,
    "Most-recently-accessed tab (winB's, opened later) sorts first across windows."
  );

  BrowserTestUtils.removeTab(noiseTab.tab);
  await server.cleanup();
  await BrowserTestUtils.closeWindow(winA);
  await BrowserTestUtils.closeWindow(winB);
});
