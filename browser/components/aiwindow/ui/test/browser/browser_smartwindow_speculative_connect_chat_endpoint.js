/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

// Nothing needs to listen here: the connection hash key is decided, and
// published, before the socket is attempted. It has to be a host the mochitest
// PAC leaves DIRECT, because a proxied URI skips speculative connections
// entirely (IOServiceProxyCallback::OnProxyAvailable).
const ENDPOINT_ORIGIN = "localhost:8443";

/**
 * The connection hash key nsHttpConnectionInfo::BuildHashKey builds for an
 * https, anonymous, non-private connection with default origin attributes: slot
 * 1 'S' is end-to-end TLS, slot 2 'A' is anonymous, and the key ending at the
 * origin with no suffix is what says "default origin attributes".
 *
 * Asserting the whole key is the point of this test. The real chat request is a
 * cross-origin fetch() issued by the system-principal ML engine worker, so it
 * sets LOAD_ANONYMOUS and hashes to this key; a warm with any other key lands in
 * a different pool entry the request can never reuse.
 *
 * This expectation previously omitted the 'A', which is exactly why this test
 * passed while the feature was broken - it asserted the warm's key against
 * itself rather than against the request's.
 *
 * Known limit, so nobody trusts this further than it goes: the key cannot be
 * compared against a real request's key from inside this test. The warm's
 * published key can never carry the HappyEyeballs 'H' that a real request has,
 * because nsHttpHandler publishes the notification before it calls
 * SetHappyEyeballsEnabled; and a chrome-context fetch with credentials "omit" is
 * not anonymous, so it is not a faithful stand-in for the worker's request.
 * Reuse was therefore verified by hand against the real endpoint via
 * nsIDashboard: a non-anonymous warm leaves the pool holding the unused warm
 * plus the request's own new connection, while an anonymous warm leaves a single
 * connection whose ttl goes from 4 to 114. Re-verify that way after touching
 * this, not by trusting the constant below.
 */
const EXPECTED_HASH_KEY = `.SA........[tlsflags0x00000000]${ENDPOINT_ORIGIN}`;

/**
 * Records the connection hash key of every speculative connection Gecko is
 * asked to open for the chat endpoint. network.http.debug-observations makes
 * nsHttpHandler publish the key it is about to use.
 *
 * @returns {{keys: string[], stop: Function}}
 */
function observeChatEndpointWarms() {
  const keys = [];
  const observer = (_subject, _topic, data) => {
    if (data.includes(ENDPOINT_ORIGIN)) {
      info(`Observed speculative connection: ${data}`);
      keys.push(data);
    }
  };
  Services.obs.addObserver(observer, "speculative-connect-request");
  return {
    keys,
    stop: () =>
      Services.obs.removeObserver(observer, "speculative-connect-request"),
  };
}

/**
 * The socket should be warm by the time a request is built: once when the AI
 * Window opens, for the case where the user asks immediately, and then shortly
 * after they stop typing.
 *
 * The warm rides a typing pause rather than the first keystroke because an
 * unused speculative connection is reaped in about five seconds, so a warm at
 * the first keystroke is already gone for anyone who spends longer composing.
 * A pause is the cheapest signal that a submit is imminent.
 */
add_task(async function test_chat_endpoint_connection_is_warmed() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["network.http.debug-observations", true],
      ["browser.smartwindow.endpoint", `https://${ENDPOINT_ORIGIN}/v1`],
    ],
  });
  const warms = observeChatEndpointWarms();
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    await TestUtils.waitForCondition(
      () => warms.keys.length,
      "Opening the AI Window should warm the chat endpoint connection."
    );
    Assert.equal(
      warms.keys[0],
      EXPECTED_HASH_KEY,
      "The warmed connection is keyed exactly like the chat request's own load."
    );
    const afterOpen = warms.keys.length;

    // The window-open warm is still alive at this point, and the floor exists
    // precisely so a second connection is not opened next to a live one. Wait it
    // out, so what follows asserts the typing trigger rather than the floor.
    /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
    await new Promise(resolve => setTimeout(resolve, 4200));

    await typeInSmartbar(sidebarBrowser, "What is the weather?");

    await TestUtils.waitForCondition(
      () => warms.keys.length > afterOpen,
      "Pausing after typing should warm the endpoint, close enough to the submit that the connection is still pooled."
    );

    await submitSmartbar(sidebarBrowser);

    const answer = "It is sunny.";
    await mockEngineManager.respondTo({ purpose: "chat", response: answer });
    await mockEngineManager.respondTo({
      purpose: "title-generation",
      response: "Weather",
    });

    // Completing the turn is also the settle point for the warm requested while
    // the sentence above was typed: any connection Gecko was asked to open has
    // been reported by now.
    const rendered = await TestUtils.waitForCondition(async () => {
      const messages = await getSidebarChatMessages(sidebarBrowser);
      return messages.find(
        message => message.role === "assistant" && message.hasRendered
      );
    }, "The assistant should render a reply once the turn completes.");
    Assert.equal(rendered.message, answer, "The turn ran to completion.");

    const afterFirstTurn = warms.keys.length;

    // The floor is measured from the last warm, so a follow-up typed straight
    // away is exactly the case where a re-warm is suppressed as redundant. Wait
    // it out so this asserts the trigger, not the floor.
    /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
    await new Promise(resolve => setTimeout(resolve, 4200));

    await typeInSmartbar(sidebarBrowser, "And tomorrow?");
    await TestUtils.waitForCondition(
      () => warms.keys.length > afterFirstTurn,
      "Pausing while composing the follow-up should warm the endpoint again."
    );

    Assert.ok(
      warms.keys.every(key => key === EXPECTED_HASH_KEY),
      "Every warm used the connection key the chat request itself would use."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    warms.stop();
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * The debounce itself, which the flow test above cannot express: typeInSmartbar
 * fires a single input event no matter how long the string is, so a warm per
 * input event and a warm per typing pause are indistinguishable through it. This
 * drives the listener directly at a typing cadence instead - ten input events
 * spaced under the debounce, which is one pause, and so one warm.
 */
add_task(async function test_typing_cadence_warms_once_not_per_event() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["network.http.debug-observations", true],
      ["browser.smartwindow.endpoint", `https://${ENDPOINT_ORIGIN}/v1`],
    ],
  });
  const warms = observeChatEndpointWarms();
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await TestUtils.waitForCondition(
      () => warms.keys.length,
      "The window-open warm should land before this measures anything."
    );

    // Outlast the window-open warm, so this measures the trigger not the floor.
    /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
    await new Promise(resolve => setTimeout(resolve, 4200));
    const beforeTyping = warms.keys.length;

    const EVENTS = 10;
    await SpecialPowers.spawn(sidebarBrowser, [EVENTS], async count => {
      const aiWindow = content.document.querySelector("ai-window");
      const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
      for (let i = 0; i < count; i++) {
        smartbar.dispatchEvent(new content.Event("input", { bubbles: true }));
        // Under the debounce, so each event pushes the pending warm out.
        await new Promise(resolve => content.setTimeout(resolve, 50));
      }
    });

    await TestUtils.waitForCondition(
      () => warms.keys.length > beforeTyping,
      "The pause after the last input event should warm the endpoint."
    );
    Assert.equal(
      warms.keys.length - beforeTyping,
      1,
      `${EVENTS} input events at typing speed warm once, not once per event.`
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    warms.stop();
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * A slow typist pauses between words, and every pause clears the debounce. The
 * floor is what stops that becoming a connection per word: inside the interval
 * the previous warm is still pooled, so a second one buys nothing and only costs
 * a socket.
 */
add_task(async function test_pauses_inside_the_floor_do_not_rewarm() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["network.http.debug-observations", true],
      ["browser.smartwindow.endpoint", `https://${ENDPOINT_ORIGIN}/v1`],
    ],
  });
  const warms = observeChatEndpointWarms();
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await TestUtils.waitForCondition(
      () => warms.keys.length,
      "The window-open warm should land before this measures anything."
    );

    /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
    await new Promise(resolve => setTimeout(resolve, 4200));
    const beforeTyping = warms.keys.length;

    // Gaps longer than the debounce, so each is its own pause and each schedules
    // a warm, but all inside the floor.
    const PAUSES = 4;
    await SpecialPowers.spawn(sidebarBrowser, [PAUSES], async count => {
      const aiWindow = content.document.querySelector("ai-window");
      const smartbar = aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
      for (let i = 0; i < count; i++) {
        smartbar.dispatchEvent(new content.Event("input", { bubbles: true }));
        await new Promise(resolve => content.setTimeout(resolve, 700));
      }
    });

    await TestUtils.waitForCondition(
      () => warms.keys.length > beforeTyping,
      "The first pause should still warm."
    );
    Assert.equal(
      warms.keys.length - beforeTyping,
      1,
      `${PAUSES} separate pauses inside the floor warm once, not once per pause.`
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    warms.stop();
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * The pref is the kill switch for the whole lever, so nothing may reach the
 * network layer when it is off.
 */
add_task(async function test_no_warm_when_the_pref_is_off() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["network.http.debug-observations", true],
      ["browser.smartwindow.endpoint", `https://${ENDPOINT_ORIGIN}/v1`],
      ["browser.smartwindow.speculativeConnect.chatEndpoint.enabled", false],
    ],
  });
  const warms = observeChatEndpointWarms();
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();

  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    await typeInSmartbar(sidebarBrowser, "What is the weather?");
    await submitSmartbar(sidebarBrowser);

    const answer = "It is sunny.";
    await mockEngineManager.respondTo({ purpose: "chat", response: answer });
    await mockEngineManager.respondTo({
      purpose: "title-generation",
      response: "Weather",
    });

    // Waiting for a full turn gives any stray warm every chance to show up.
    await TestUtils.waitForCondition(async () => {
      const messages = await getSidebarChatMessages(sidebarBrowser);
      return messages.find(
        message => message.role === "assistant" && message.hasRendered
      );
    }, "The assistant should render a reply once the turn completes.");

    Assert.deepEqual(
      warms.keys,
      [],
      "With the pref off, opening and typing warm nothing."
    );
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    warms.stop();
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});
