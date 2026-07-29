/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Chat.fetchWithHistory awaits the FxA token after the prompt has been
 * assembled, which puts an FxAccounts round trip between the user's submit and
 * the request leaving. Starting it on the first keystroke of the turn overlaps it
 * with typing, by which point it has resolved.
 *
 * Not covered here: that the prefetched fetch is handed to exactly one caller
 * rather than cached. getFxAccountToken is itself the boundary the test harness
 * replaces, so a test can only reach that handoff by restating it, which would
 * assert nothing. The 401 retry paths invalidate the prefetch for the same
 * reason it is a one-shot handoff and not a cache.
 */

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { openAIEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/openAIEngine.sys.mjs"
);

add_task(async function test_token_is_fetched_while_the_user_types() {
  // MockEngineManager stubs getFxAccountToken, which is the boundary here: what
  // is under test is when the window asks for a token, not how FxA answers.
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    const tokenStub = openAIEngine.getFxAccountToken;
    Assert.ok(
      tokenStub.resetHistory,
      "Precondition: getFxAccountToken is the mock's stub, so calls are counted."
    );
    tokenStub.resetHistory();

    await typeInSmartbar(sidebarBrowser, "What is the weather?");

    Assert.ok(
      tokenStub.called,
      "Typing starts the token fetch, so submit does not wait on FxAccounts."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
  }
});
