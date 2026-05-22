/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * End-to-end security coverage for the run_search tool. A mock model returns a
 * run_search tool_call and a SearchTestUtils extension serves a controlled SERP
 * from MLTestUtils' HTTP server. Each task pins one path through Tools.runSearch:
 * verbatim-query, generated-query, and extraction-failure.
 */

/**
 * @type {import("../../../../../../toolkit/components/ml/tests/MLTestUtils.sys.mjs")}
 */
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs"
);

const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

const { RUN_SEARCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { MESSAGE_ROLE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs"
);

/**
 * @import { ChatConversation } from "../../modules/ChatConversation.sys.mjs"
 */

SearchTestUtils.init(this);

const SERP_LINKS = Object.freeze([
  "https://example.com/result-a",
  "https://example.com/result-b",
]);

const SERP_BODY_MARKER = "Description of the first result.";

/**
 * Wait for the run_search tool result message, then return it.
 *
 * @param {ChatConversation} conversation
 */
async function waitForRunSearchResult(conversation) {
  return BrowserTestUtils.waitForCondition(
    () =>
      conversation.messages.find(
        m => m.role === MESSAGE_ROLE.TOOL && m.content?.name === RUN_SEARCH
      ),
    "A tool result for run_search should be added to the conversation."
  );
}

/**
 * Build the SERP HTML for a query. The body carries a marker string (to assert
 * PageExtractor pulled real content) and fixed absolute-URL links (to compare
 * against conversation.seenUrls).
 *
 * @param {string} query
 * @param {object} [overrides]
 * @param {boolean} [overrides.empty] - Return an empty body so PageExtractor
 *   extracts nothing; used by the extraction-failure test.
 */
function serpHtml(query, { empty = false } = {}) {
  if (empty) {
    return `<!DOCTYPE html><html><head><title></title></head><body></body></html>`;
  }
  const safeQuery = query.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html>
  <head><title>Results for ${safeQuery}</title></head>
  <body>
    <h1>Search results for "${safeQuery}"</h1>
    <article>
      <a href="${SERP_LINKS[0]}">First result</a>
      <p>${SERP_BODY_MARKER}</p>
    </article>
    <article>
      <a href="${SERP_LINKS[1]}">Second result</a>
      <p>Description of the second result.</p>
    </article>
  </body>
</html>`;
}

/**
 * Wire up the deterministic environment shared by every run_search task:
 * a MockEngineManager for the model, a shared HttpServer serving the SERP
 * route (capturing each query string), a SearchTestUtils extension pointed at
 * that route and set as default, and an AI window with the sidebar open over
 * an about:blank content tab (not an AI-window content page, so runSearch
 * skips moveConversationToSidebar).
 *
 * cleanup() unloads the extension explicitly (skipUnload bypasses
 * registerCleanupFunction) so consecutive tasks can install distinct engines
 * without LIFO-cleanup reference conflicts.
 *
 * @param {object} [options]
 * @param {boolean} [options.emptySerp] - Serve an empty body so PageExtractor
 *   extracts nothing; used by the extraction-failure task.
 * @param {string} [options.engineName] - Mock engine name. Each task must pass
 *   a unique value; reusing one trips LIFO cleanup over stale engine entries
 *   ("Unable to find the new engine in the engine store").
 */
async function setupRunSearchTest({
  emptySerp = false,
  engineName = "MockRunSearchEngine",
} = {}) {
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();
  const server = await MLTestUtils.serveSharedHTMLInTab({
    browser: win.gBrowser,
  });

  const serpUrl = `${server.origin}/serp.html`;

  /** @type {string[]} */
  const capturedQueries = [];

  const encoder = new TextEncoder();

  server.registerPathHandler("/serp.html", (request, response) => {
    capturedQueries.push(request.queryString);
    const params = new URLSearchParams(request.queryString);
    const query = params.get("q") ?? "";
    const htmlUtf8 = encoder.encode(serpHtml(query, { empty: emptySerp }));
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setStatusLine(request.httpVersion, 200, "OK");
    const binaryOutputStream = Cc[
      "@mozilla.org/binaryoutputstream;1"
    ].createInstance(Ci.nsIBinaryOutputStream);
    binaryOutputStream.setOutputStream(response.bodyOutputStream);
    binaryOutputStream.writeByteArray(htmlUtf8);
  });

  const previousDefaultEngine = await SearchService.getDefault();

  const searchExtension = await SearchTestUtils.installSearchExtension(
    {
      name: engineName,
      search_url: serpUrl,
      search_url_get_params: "?q={searchTerms}",
    },
    { setAsDefault: true, skipUnload: true }
  );

  const defaultEngine = await SearchService.getDefault();
  Assert.equal(
    defaultEngine.name,
    engineName,
    "Mock engine is the active default before any chat turn."
  );

  function getCapturedQueries() {
    return capturedQueries.slice();
  }

  async function cleanup() {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await server.cleanup();
    await BrowserTestUtils.closeWindow(win);
    if (previousDefaultEngine) {
      // Restore the previous default before unloading so SearchService never
      // observes a missing default engine.
      await SearchService.setDefault(
        previousDefaultEngine,
        SearchService.CHANGE_REASON.UNKNOWN
      );
    }
    await searchExtension.unload();
  }

  return {
    win,
    sidebarBrowser,
    mockEngineManager,
    serpUrl,
    getCapturedQueries,
    cleanup,
  };
}

/**
 * When the model returns tool_call run_search({}), the tool must resolve the
 * query from the most recent user message. This verifies:
 *  - The exact user message string reached the search engine via the q= param.
 *  - PageExtractor returned content from the SERP body (the marker string).
 *  - Every <a href> on the SERP is recorded in conversation.seenUrls.
 *  - Both security flags (privateData, untrustedInput) flip to true.
 */
add_task(async function test_run_search_verbatim_query_path() {
  const {
    win,
    sidebarBrowser,
    mockEngineManager,
    serpUrl,
    getCapturedQueries,
    cleanup,
  } = await setupRunSearchTest();

  const userQuery = "what is the latest tech news";

  await typeInSmartbar(sidebarBrowser, userQuery);
  await submitSmartbar(sidebarBrowser);

  /** @type {ChatConversation} */
  const conversation = await BrowserTestUtils.waitForCondition(
    () => AIWindow.getActiveConversation(win),
    "Conversation should be created when the first message is sent."
  );

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

  // Drain the sidebar conversation-starter request; the conversation must
  // exist first so the engine has been lazily created.
  mockEngineManager.rejectAllRequests();

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_run_search_verbatim_1",
          function: { name: RUN_SEARCH, arguments: "{}" },
        },
      ],
    },
  });

  const targetBrowser = win.gBrowser.selectedBrowser;
  await BrowserTestUtils.waitForCondition(
    () => targetBrowser.currentURI?.spec?.startsWith(serpUrl),
    "Foreground tab navigates to the mock SERP URL."
  );

  const toolMessage = await waitForRunSearchResult(conversation);

  Assert.equal(
    typeof toolMessage.content.body,
    "string",
    "run_search tool body is a string."
  );
  Assert.ok(
    toolMessage.content.body.startsWith("Search results from "),
    "Tool result has the run_search header."
  );
  Assert.ok(
    toolMessage.content.body.includes(serpUrl),
    "Tool result header includes the SERP URL."
  );
  Assert.ok(
    toolMessage.content.body.includes(SERP_BODY_MARKER),
    "Tool result includes content extracted from the SERP body."
  );

  const queries = getCapturedQueries();
  Assert.ok(
    queries.length,
    "The mock SERP route received at least one request."
  );
  const params = new URLSearchParams(queries[queries.length - 1]);
  Assert.equal(
    params.get("q"),
    userQuery,
    "The verbatim user message reached the search engine."
  );

  for (const url of SERP_LINKS) {
    Assert.ok(
      conversation.seenUrls.has(url),
      `SERP link ${url} is recorded in conversation.seenUrls.`
    );
  }

  // The smartbar implicitly mentions the current tab (about:blank here), so
  // seenUrls is exactly that mention plus the two extracted SERP links.
  // Asserting the precise set guards against lost entries and extras.
  Assert.deepEqual(
    [...conversation.seenUrls].sort(),
    ["about:blank", ...SERP_LINKS].sort(),
    "seenUrls contains exactly about:blank (from the implicit context mention) " +
      "plus the two SERP links — no extras, no missing entries."
  );

  Assert.equal(
    conversation.securityProperties.privateData,
    true,
    "privateData flips to true after run_search."
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    true,
    "untrustedInput flips to true after run_search."
  );

  // Drain the follow-up turn and title generation so teardown isn't left
  // mid-generation.
  await mockEngineManager.respondTo({
    purpose: "chat",
    response: "Here is what I found.",
  });
  await mockEngineManager.respondTo({
    purpose: "title-generation",
    response: "Latest tech news",
  });

  await cleanup();
});

/**
 * Guardrail: a model-supplied query must be ignored on the first turn. The
 * model supplies its own query on turn 0; Chat.sys.mjs strips it
 * (isVerbatimQuery branch) so the search falls back to the verbatim user
 * message. Without the strip, the captured q= would be the model string rather
 * than what the user typed.
 */
add_task(async function test_run_search_turn0_strips_model_query() {
  const {
    win,
    sidebarBrowser,
    mockEngineManager,
    serpUrl,
    getCapturedQueries,
    cleanup,
  } = await setupRunSearchTest({ engineName: "MockRunSearchEngineStrip" });

  const userQuery = "what the user actually typed";
  const strippedQuery = "model injected query that must be ignored on turn 0";

  await typeInSmartbar(sidebarBrowser, userQuery);
  await submitSmartbar(sidebarBrowser);

  /** @type {ChatConversation} */
  const conversation = await BrowserTestUtils.waitForCondition(
    () => AIWindow.getActiveConversation(win),
    "Conversation should be created when the first message is sent."
  );

  // Drain the sidebar conversation-starter request; the conversation must
  // exist first so the engine has been lazily created.
  mockEngineManager.rejectAllRequests();

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_run_search_strip_1",
          function: {
            name: RUN_SEARCH,
            arguments: JSON.stringify({ query: strippedQuery }),
          },
        },
      ],
    },
  });

  const targetBrowser = win.gBrowser.selectedBrowser;
  await BrowserTestUtils.waitForCondition(
    () => targetBrowser.currentURI?.spec?.startsWith(serpUrl),
    "Foreground tab navigates to the mock SERP URL."
  );

  await waitForRunSearchResult(conversation);

  const queries = getCapturedQueries();
  Assert.ok(
    queries.length,
    "The mock SERP route received at least one request."
  );
  const lastQuery = new URLSearchParams(queries[queries.length - 1]).get("q");

  Assert.equal(
    lastQuery,
    userQuery,
    "On turn 0 the verbatim user message is used as the search query."
  );
  Assert.notEqual(
    lastQuery,
    strippedQuery,
    "The model-supplied query is stripped on turn 0 (isVerbatimQuery guardrail) " +
      "and never reaches the search engine."
  );

  // Drain the follow-up turn and title generation so teardown isn't left
  // mid-generation.
  await mockEngineManager.respondTo({
    purpose: "chat",
    response: "Here is what I found.",
  });
  await mockEngineManager.respondTo({
    purpose: "title-generation",
    response: "Turn zero strip",
  });

  await cleanup();
});

/**
 * On a turn > 0, run_search({ query: "..." }) must use that exact string and
 * NOT fall back to the most recent user message. The silent first turn is
 * load-bearing: turn 0 strips a model-supplied query (isVerbatimQuery branch),
 * so the generated query only reaches runSearch once that flips to false on
 * turn > 0.
 */
add_task(async function test_run_search_generated_query_path() {
  const {
    win,
    sidebarBrowser,
    mockEngineManager,
    serpUrl,
    getCapturedQueries,
    cleanup,
  } = await setupRunSearchTest({ engineName: "MockRunSearchEngineGenerated" });

  const userMessage = "ignore me";
  const generatedQuery = "explicit generated query";

  // Turn 0: a plain-text reply advances past the verbatim-query-only first
  // turn so the generated-query path is active next request.
  await typeInSmartbar(sidebarBrowser, "start conversation");
  await submitSmartbar(sidebarBrowser);

  /** @type {ChatConversation} */
  const conversation = await BrowserTestUtils.waitForCondition(
    () => AIWindow.getActiveConversation(win),
    "Conversation should be created when the first message is sent."
  );

  // Drain the sidebar conversation-starter request; the conversation must
  // exist first so the engine has been lazily created.
  mockEngineManager.rejectAllRequests();

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: "Ready.",
  });
  await mockEngineManager.respondTo({
    purpose: "title-generation",
    response: "Start",
  });

  // Turn 1: submit the message the model should ignore. submitSmartbar waits
  // for the action to leave "stop", so it won't fire until turn 0 finished.
  await typeInSmartbar(sidebarBrowser, userMessage);
  await submitSmartbar(sidebarBrowser);

  // Drain any new starters request that may have queued during turn 0.
  mockEngineManager.rejectAllRequests();

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_run_search_generated_1",
          function: {
            name: RUN_SEARCH,
            arguments: JSON.stringify({ query: generatedQuery }),
          },
        },
      ],
    },
  });

  const targetBrowser = win.gBrowser.selectedBrowser;
  await BrowserTestUtils.waitForCondition(
    () => targetBrowser.currentURI?.spec?.startsWith(serpUrl),
    "Foreground tab navigates to the mock SERP URL."
  );

  const toolMessage = await waitForRunSearchResult(conversation);
  Assert.ok(
    toolMessage.content.body.includes(SERP_BODY_MARKER),
    "Tool result includes extracted SERP content."
  );
  Assert.ok(
    toolMessage.content.body.includes(serpUrl),
    "Tool result header includes the SERP URL."
  );

  const queries = getCapturedQueries();
  Assert.ok(
    queries.length,
    "The mock SERP route received at least one request."
  );
  const lastQuery = new URLSearchParams(queries[queries.length - 1]).get("q");

  Assert.equal(
    lastQuery,
    generatedQuery,
    "The generated query (not the user message) reached the search engine."
  );
  Assert.notEqual(
    lastQuery,
    userMessage,
    "The user message does NOT leak into the search query when the model supplies one."
  );

  Assert.deepEqual(
    [...conversation.seenUrls].sort(),
    ["about:blank", ...SERP_LINKS].sort(),
    "seenUrls contains exactly about:blank (from the implicit context mention) " +
      "plus the two SERP links — no extras, no missing entries."
  );

  Assert.equal(
    conversation.securityProperties.privateData,
    true,
    "privateData flips to true after run_search."
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    true,
    "untrustedInput flips to true after run_search."
  );

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: "Here is what I found.",
  });

  // Wait for the follow-up response to commit so the conversation isn't still
  // generating when cleanup tears down the window and extension.
  await BrowserTestUtils.waitForCondition(
    () =>
      conversation.messages.find(
        m =>
          m.role === MESSAGE_ROLE.ASSISTANT &&
          m.content?.type === "text" &&
          m.content?.body === "Here is what I found."
      ),
    "Follow-up assistant reply should be committed to the conversation."
  );

  await cleanup();
});

/**
 * When the SERP loads but PageExtractor extracts nothing (empty body),
 * getText() returns a non-null result with result.text === "", so the tool
 * emits the header-only form "Search results from <url>:\n\n" — NOT the "No
 * content could be extracted..." string, which only fires when getText()
 * returns null.
 *
 * Pins that the security flags still flip to true regardless of extraction
 * success, since the query itself can derive from private context.
 */
add_task(async function test_run_search_extraction_failure_flags_still_flip() {
  const { win, sidebarBrowser, mockEngineManager, serpUrl, cleanup } =
    await setupRunSearchTest({
      emptySerp: true,
      engineName: "MockRunSearchEngineEmpty",
    });

  await typeInSmartbar(sidebarBrowser, "an empty serp query");
  await submitSmartbar(sidebarBrowser);

  /** @type {ChatConversation} */
  const conversation = await BrowserTestUtils.waitForCondition(
    () => AIWindow.getActiveConversation(win),
    "Conversation should be created when the first message is sent."
  );

  // Drain the sidebar conversation-starter request; the conversation must
  // exist first so the engine has been lazily created.
  mockEngineManager.rejectAllRequests();

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_run_search_empty_1",
          function: { name: RUN_SEARCH, arguments: "{}" },
        },
      ],
    },
  });

  const targetBrowser = win.gBrowser.selectedBrowser;
  await BrowserTestUtils.waitForCondition(
    () => targetBrowser.currentURI?.spec?.startsWith(serpUrl),
    "Foreground tab navigates to the mock (empty) SERP URL."
  );

  const navigatedUrl = targetBrowser.currentURI.spec;
  const toolMessage = await waitForRunSearchResult(conversation);

  Assert.equal(
    toolMessage.content.body,
    `Search results from ${navigatedUrl}:\n\n`,
    "Tool result is exactly the header-only form when PageExtractor yields empty text; pins the URL and the empty-body terminator together."
  );

  Assert.deepEqual(
    [...conversation.seenUrls].sort(),
    ["about:blank"].sort(),
    "seenUrls contains only the implicit about:blank context mention; no SERP " +
      "links are added because PageExtractor extracted nothing."
  );

  Assert.equal(
    conversation.securityProperties.privateData,
    true,
    "privateData still flips to true on extraction failure (the query was used)."
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    true,
    "untrustedInput still flips to true on extraction failure."
  );

  await mockEngineManager.respondTo({
    purpose: "chat",
    response: "I could not find anything.",
  });
  await mockEngineManager.respondTo({
    purpose: "title-generation",
    response: "Empty SERP",
  });

  await BrowserTestUtils.waitForCondition(
    () =>
      conversation.messages.find(
        m =>
          m.role === MESSAGE_ROLE.ASSISTANT &&
          m.content?.type === "text" &&
          m.content?.body === "I could not find anything."
      ),
    "Assistant follow-up message lands before teardown."
  );

  await cleanup();
});
