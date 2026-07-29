/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * The system message is the first message of every request, so it is the prefix
 * the endpoint's prompt cache keys on. Rewriting it between turns invalidates
 * that cache for the tools block and the whole transcript behind it, which is
 * paid as prefill on every follow-up. These tests assert the assembled prompt
 * is reused across turns, and that callers asking for a specific build still
 * get one.
 *
 * The real prompt embeds a wall-clock timestamp, so a reassembly is observable
 * as a changed system message. head.js stubs the loadPrompt seam to a constant,
 * which would make an equality assertion pass whether or not the prompt was
 * reassembled, so these tests re-point that seam at a value that changes per
 * call — the same way the real assembly does.
 */

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

// head.js already imports _setLoadPromptForTesting into this scope.

const { MESSAGE_ROLE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs"
);

/**
 * @import { ChatConversation } from "../../modules/ChatConversation.sys.mjs"
 */

/**
 * Installs a loadPrompt seam that returns a different prompt on every call, so
 * a reassembled system message never matches a reused one. Returns a counter of
 * how many times the assembly actually ran.
 *
 * @returns {{callCount: number}}
 */
function trackVolatilePromptAssembly() {
  let callCount = 0;
  _setLoadPromptForTesting(
    async () => `Test system prompt. build=${++callCount}`
  );
  registerCleanupFunction(() => _setLoadPromptForTesting(null));
  return {
    get callCount() {
      return callCount;
    },
  };
}

/**
 * @param {ChatConversation} conversation
 * @returns {string|undefined}
 */
function getSystemPromptBody(conversation) {
  return conversation.messages.find(
    message => message.role === MESSAGE_ROLE.SYSTEM
  )?.content?.body;
}

function getAIWindowElement(browser) {
  return browser.contentDocument.querySelector("ai-window");
}

async function sendTurn(browser, text) {
  await typeInSmartbar(browser, text);
  await submitSmartbar(browser);
}

async function waitForTurnToFinish(browser) {
  const aiWindow = getAIWindowElement(browser);
  await TestUtils.waitForCondition(
    () => !aiWindow.isGenerating,
    "The turn should finish before the next prompt is submitted."
  );
}

add_task(async function test_system_prompt_reused_across_turns() {
  const assembly = trackVolatilePromptAssembly();
  const mockEngineManager = new MockEngineManager();
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  try {
    await sendTurn(browser, "first question");

    const firstTurn = await mockEngineManager.captureRequest({
      purpose: "chat",
    });
    const firstSystemMessage = firstTurn.request.args[0];
    Assert.equal(
      firstSystemMessage.role,
      "system",
      "The first message of the request is the system message, so it is the cache prefix."
    );
    Assert.ok(
      firstSystemMessage.content,
      "The system message carries the assembled prompt."
    );
    firstTurn.respond("Reply from mock.");

    await waitForTurnToFinish(browser);
    const assembliesAfterFirstTurn = assembly.callCount;
    Assert.greater(
      assembliesAfterFirstTurn,
      0,
      "The first turn assembles the prompt, so the seam under test really ran."
    );

    await sendTurn(browser, "second question");

    const secondTurn = await mockEngineManager.captureRequest({
      purpose: "chat",
    });
    const secondSystemMessage = secondTurn.request.args[0];
    secondTurn.respond("Reply from mock.");

    Assert.equal(
      assembly.callCount,
      assembliesAfterFirstTurn,
      "The follow-up turn does not reassemble the prompt, so the assembly is off the per-turn critical path."
    );
    Assert.equal(
      secondSystemMessage.content,
      firstSystemMessage.content,
      "The system message is byte-identical on the follow-up turn, so the cache prefix covers the tools block and the transcript behind it."
    );
    Assert.greater(
      secondTurn.request.args.length,
      firstTurn.request.args.length,
      "The transcript grew between the turns, so the comparison above is not vacuous."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_explicit_build_reassembles() {
  const assembly = trackVolatilePromptAssembly();
  const mockEngineManager = new MockEngineManager();
  const win = await openAIWindow();
  const browser = win.gBrowser.selectedBrowser;

  try {
    await sendTurn(browser, "first question");
    const firstTurn = await mockEngineManager.captureRequest({
      purpose: "chat",
    });
    firstTurn.respond("Reply from mock.");
    await waitForTurnToFinish(browser);

    /** @type {ChatConversation} */
    const conversation = getAIWindowElement(browser).conversation;
    const reusedPrompt = getSystemPromptBody(conversation);

    // What a model switch does: asks for a build against a specific model.
    await conversation.loadSystemPrompt({ model: "some-other-model" });
    const switchedPrompt = getSystemPromptBody(conversation);
    Assert.notEqual(
      switchedPrompt,
      reusedPrompt,
      "A caller naming a model gets a fresh build rather than the reused prompt."
    );

    // The explicit build resolved its model from opts, so the next per-turn
    // call rebuilds once against the engine's model and stabilizes after that.
    await conversation.loadSystemPrompt();
    const rebuiltPrompt = getSystemPromptBody(conversation);
    Assert.notEqual(
      rebuiltPrompt,
      switchedPrompt,
      "The first turn after an explicit build reassembles against the engine's model."
    );

    const assembliesBeforeReuse = assembly.callCount;
    await conversation.loadSystemPrompt();
    Assert.equal(
      assembly.callCount,
      assembliesBeforeReuse,
      "Later turns reuse the rebuilt prompt instead of reassembling every turn."
    );
    Assert.equal(
      getSystemPromptBody(conversation),
      rebuiltPrompt,
      "The reused prompt is left byte-identical."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
  }
});
