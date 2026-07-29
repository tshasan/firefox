/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Streamed assistant text is delivered to the chat content document at most once
 * per interval rather than once per chunk, because each delivery clones the whole
 * accumulated message across the process boundary and the renderer reparses all
 * of it - quadratic in the length of the answer.
 *
 * The risk that buys is dropped text: coalescing keeps only the latest state, so
 * a missing flush loses the tail of an answer. That is what these tests are for.
 * They do not measure the saving itself, which is structural rather than
 * observable here - one delivery per interval instead of one per chunk.
 */

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

// Enough chunks that several land inside one coalescing interval, so the test
// exercises dropping intermediate states rather than passing them all through.
const CHUNKS = Array.from({ length: 40 }, (_, i) => `chunk-${i} `);
const FULL_ANSWER = CHUNKS.join("");

async function streamAnswerAndGetRendered(sidebarBrowser, mockEngineManager) {
  await typeInSmartbar(sidebarBrowser, "Tell me something long.");
  await submitSmartbar(sidebarBrowser);

  await mockEngineManager.respondTo({ purpose: "chat", response: CHUNKS });
  await mockEngineManager.respondTo({
    purpose: "title-generation",
    response: "Something long",
  });

  return TestUtils.waitForCondition(async () => {
    const messages = await getSidebarChatMessages(sidebarBrowser);
    const assistant = messages.find(
      message => message.role === "assistant" && message.hasRendered
    );
    return assistant?.message === FULL_ANSWER ? assistant : null;
  }, "The whole streamed answer should render, with no chunks dropped.");
}

add_task(async function test_coalescing_delivers_every_chunk() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.coalesceStreamUpdates.enabled", true]],
  });
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    const rendered = await streamAnswerAndGetRendered(
      sidebarBrowser,
      mockEngineManager
    );
    Assert.equal(
      rendered.message,
      FULL_ANSWER,
      "Coalesced delivery still ends with the complete answer, tail included."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * The pref is the kill switch, and the uncoalesced path has to keep working
 * identically - it is also the control for the assertion above.
 */
add_task(async function test_uncoalesced_delivery_is_unchanged() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.coalesceStreamUpdates.enabled", false]],
  });
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    const rendered = await streamAnswerAndGetRendered(
      sidebarBrowser,
      mockEngineManager
    );
    Assert.equal(
      rendered.message,
      FULL_ANSWER,
      "Dispatching every chunk renders the same answer as coalescing them."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});
