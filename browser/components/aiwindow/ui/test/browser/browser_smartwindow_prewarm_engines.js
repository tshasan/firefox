/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * The engines a turn needs are built when the window opens rather than when the
 * first turn needs them, so the cold-start cost lands while the user is still
 * deciding what to ask. buildEngineForFeature measured 822ms on a cold build,
 * and the feature extraction engine behind memory retrieval is the stall that
 * browser.smartwindow.memories.retrievalTimeoutMs can only trade against - so
 * this removes it rather than relocating it.
 */

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { MemoriesManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs"
);

const { MemoryStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs"
);

add_task(async function test_chat_engine_is_built_at_window_open() {
  const mockEngineManager = new MockEngineManager();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.prewarmEngines.enabled", true]],
  });

  let win;
  try {
    win = await openAIWindow();

    // The chat engine is keyed by its purpose, and nothing else in an idle
    // window builds that purpose, so its presence here is the prewarm.
    await TestUtils.waitForCondition(
      () => mockEngineManager.engines.get("chat"),
      "The chat engine should be built at window open, before any prompt is sent."
    );
    Assert.ok(
      mockEngineManager.engines.get("chat"),
      "The chat engine exists before the user has typed anything."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_no_prewarm_when_disabled() {
  const mockEngineManager = new MockEngineManager();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.prewarmEngines.enabled", false]],
  });

  let win;
  try {
    win = await openAIWindow();

    // Absence needs a bound. The enabled case above is the control: it sees the
    // engine well inside this window, so timing out here is the real signal and
    // not just an unlucky wait.
    let chatEngineAppeared = true;
    try {
      await TestUtils.waitForCondition(
        () => mockEngineManager.engines.get("chat"),
        "Waiting to see whether a chat engine shows up.",
        100,
        20
      );
    } catch (e) {
      chatEngineAppeared = false;
    }

    Assert.ok(
      !chatEngineAppeared,
      "With the pref off, no chat engine is built until a turn needs one."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * The retrieval prewarm has to be skipped for a user who cannot get memories
 * injected, or it would build a feature extraction engine (and on a cold profile
 * download a model) for a feature they have off.
 */
add_task(async function test_memories_prewarm_respects_the_feature_being_off() {
  const mockEngineManager = new MockEngineManager();
  // MemoriesManager is a boundary from the window's point of view; what is under
  // test is whether the window decides to call it.
  const prewarmSpy = sinon.spy(MemoriesManager, "prewarmRelevantMemories");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.prewarmEngines.enabled", true],
      ["browser.smartwindow.memories.generateFromConversation", false],
      ["browser.smartwindow.memories.generateFromHistory", false],
    ],
  });

  let win;
  try {
    win = await openAIWindow();
    await TestUtils.waitForCondition(
      () => mockEngineManager.engines.get("chat"),
      "The chat engine still prewarms; only the memories side is gated."
    );
    Assert.ok(
      prewarmSpy.notCalled,
      "No retrieval prewarm for a user with memories generation off and none stored."
    );
  } finally {
    prewarmSpy.restore();
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * Nothing to embed means nothing to prewarm, and in particular no engine build.
 * This is the common case for a new profile, so it must not pay for one.
 */
add_task(async function test_prewarm_is_a_no_op_without_memories() {
  const memories = await MemoryStore.getMemories({ includeSoftDeleted: false });
  Assert.equal(
    memories.length,
    0,
    "Precondition: this profile has no stored memories."
  );

  MemoryStore.embeddingsGenerator = null;
  await MemoryStore.prewarmRelevantMemories();
  Assert.equal(
    MemoryStore.embeddingsGenerator,
    null,
    "Prewarm returns before creating an embeddings generator when there is nothing to embed."
  );
});
