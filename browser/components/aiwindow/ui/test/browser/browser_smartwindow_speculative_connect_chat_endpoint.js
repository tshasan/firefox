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
 * https connection that is not anonymous, not private, and carries default
 * origin attributes: slot 1 'S' is end-to-end TLS, slot 2 staying '.' is what
 * says "not anonymous", and the key ending at the origin with no suffix is what
 * says "default origin attributes".
 *
 * Asserting the whole key is the point of this test. The real chat request is a
 * fetch() issued by the system-principal ML engine worker, which hashes to this
 * same key, so a warm with any other key would land in a different connection
 * pool entry that the request could never reuse.
 */
const EXPECTED_HASH_KEY = `.S.........[tlsflags0x00000000]${ENDPOINT_ORIGIN}`;

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
 * The endpoint is known before the first message is, so the socket to it should
 * already be warm by the time a request is built: once when the AI Window
 * opens, and again on the first keystroke of each turn, which is what recovers
 * a socket that network.http.keep-alive.timeout closed while the user was
 * reading the previous answer.
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

    await typeInSmartbar(sidebarBrowser, "What is the weather?");
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

    Assert.equal(
      warms.keys.length,
      afterOpen + 1,
      "Typing a whole sentence warms the endpoint once, not once per keystroke."
    );

    await typeInSmartbar(sidebarBrowser, "And tomorrow?");
    await TestUtils.waitForCondition(
      () => warms.keys.length > afterOpen + 1,
      "The first keystroke of the next turn should warm the endpoint again."
    );
    Assert.equal(
      warms.keys.length,
      afterOpen + 2,
      "The follow-up turn warms once more, and only once."
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
