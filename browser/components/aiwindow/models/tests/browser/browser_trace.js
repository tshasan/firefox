/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);
const { Chat } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs"
);
const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);
const { SmartWindowTrace } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Trace.sys.mjs"
);
const { MODEL_FEATURES, SERVICE_TYPES, PURPOSES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);
const { GET_OPEN_TABS, GET_USER_MEMORIES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const COLLECTOR = "http://127.0.0.1:4318/v1/traces";
const PROMPT = "Which tabs do I have open?";
const ANSWER = "You have the trace test page open.";
const PAGE_HTML = `<!DOCTYPE html><html><head><title>Trace Test</title></head>
  <body><p>A page for the trace test.</p></body></html>`;

/**
 * Runs real chat turns against a mocked model, with the trace collector
 * replaced by a stub so the test sees exactly what would be exported.
 *
 * @param {(fixture: object) => Promise<void>} task
 */
async function withTraceFixture(task) {
  const { url, server } = serveHTML(PAGE_HTML);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const activeWindowStub = sinon
    .stub(AIWindow, "isAIWindowActive")
    .callsFake(win => win === window);
  const sharedFetch = sinon
    .stub(Cu.getGlobalForObject(SmartWindowTrace), "fetch")
    .callThrough();
  const collector = sharedFetch.withArgs(COLLECTOR).resolves({ ok: true });
  const mockEngineManager = new MockEngineManager();
  const fetchPromises = [];

  const startTurn = async (options = {}) => {
    const conversation = new ChatConversation({
      pageUrl: new URL(url),
      pageMeta: {},
    });
    conversation.engine = await openAIEngine.build({
      model: "test-model",
      serviceType: SERVICE_TYPES.AI,
      purpose: PURPOSES.CHAT,
      flowId: null,
      feature: MODEL_FEATURES.CHAT,
    });
    conversation.addUserMessage(PROMPT);
    conversation.addAssistantMessage("text", "");
    const done = Chat.fetchWithHistory({
      conversation,
      browsingContext: tab.linkedBrowser.browsingContext,
      mode: "sidebar",
      ...options,
    });
    fetchPromises.push(done);
    return { conversation, done };
  };

  const captureChatRequest = () =>
    mockEngineManager.captureRequest({ purpose: PURPOSES.CHAT });

  const exportedSpans = call =>
    JSON.parse(call.args[1].body).resourceSpans[0].scopeSpans[0].spans;

  try {
    await task({ startTurn, captureChatRequest, collector, exportedSpans });
  } finally {
    await mockEngineManager.rejectAllRequests();
    await Promise.allSettled(fetchPromises);
    mockEngineManager.cleanupMocks();
    sharedFetch.restore();
    activeWindowStub.restore();
    BrowserTestUtils.removeTab(tab);
    await new Promise(resolve => server.stop(resolve));
  }
}

function attribute(span, key) {
  const value = span.attributes.find(attr => attr.key === key)?.value;
  return value && Object.values(value)[0];
}

add_task(async function test_disabled_tracing_exports_nothing() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.trace.enabled", false]],
  });
  await withTraceFixture(
    async ({ startTurn, captureChatRequest, collector }) => {
      const { done } = await startTurn();
      (await captureChatRequest()).respond(ANSWER);
      await done;
      Assert.ok(await SmartWindowTrace.flush(), "Nothing failed to export");
      Assert.equal(collector.callCount, 0, "Disabled tracing does not export");
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_turn_trace_records_model_and_tool_spans() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.trace.enabled", true]],
  });
  await withTraceFixture(
    async ({ startTurn, captureChatRequest, collector, exportedSpans }) => {
      const { conversation, done } = await startTurn({
        toolPolicy: { allowedTools: [GET_OPEN_TABS] },
        traceMetadata: { runId: "run-1", scenarioId: "tabs" },
      });
      (await captureChatRequest()).respond({
        text: "",
        toolCalls: [
          {
            id: "call_tabs",
            type: "function",
            function: { name: GET_OPEN_TABS, arguments: "{}" },
          },
          {
            id: "call_memories",
            type: "function",
            function: { name: GET_USER_MEMORIES, arguments: "{}" },
          },
        ],
      });
      (await captureChatRequest()).respond(ANSWER);
      await done;
      Assert.ok(await SmartWindowTrace.flush(), "The trace was exported");
      Assert.equal(collector.callCount, 1, "One turn exports one trace");

      const [, options] = collector.firstCall.args;
      Assert.equal(
        options.redirect,
        "error",
        "A local redirect cannot leak trace data"
      );
      Assert.equal(options.credentials, "omit");

      const spans = exportedSpans(collector.firstCall);
      const [root] = spans.filter(span => !span.parentSpanId);
      Assert.equal(root.name, "smartwindow.turn");
      Assert.stringMatches(
        root.traceId,
        /^[a-f0-9]{32}$/,
        "The trace id is OTLP hex"
      );
      Assert.equal(attribute(root, "session.id"), conversation.id);
      Assert.equal(attribute(root, "smartwindow.run_id"), "run-1");
      Assert.equal(attribute(root, "smartwindow.scenario_id"), "tabs");
      Assert.equal(JSON.parse(attribute(root, "input.value")).body, PROMPT);
      Assert.equal(JSON.parse(attribute(root, "output.value")).body, ANSWER);
      Assert.equal(root.status.code, 1, "The completed turn is not an error");

      Assert.deepEqual(
        spans.filter(span => span !== root).map(span => span.name),
        ["chat", GET_OPEN_TABS, GET_USER_MEMORIES, "chat"],
        "Model requests and tool calls are recorded in order"
      );
      for (const span of spans) {
        Assert.equal(span.traceId, root.traceId, `${span.name} is in the turn`);
        Assert.stringMatches(
          span.spanId,
          /^[a-f0-9]{16}$/,
          "The span id is OTLP hex"
        );
        Assert.greaterOrEqual(
          Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)),
          0,
          `${span.name} ends after it starts`
        );
        if (span !== root) {
          Assert.equal(span.parentSpanId, root.spanId, `${span.name} parent`);
        }
      }

      const [firstChat] = spans.filter(span => span.name === "chat");
      Assert.equal(attribute(firstChat, "openinference.span.kind"), "LLM");
      Assert.deepEqual(
        JSON.parse(attribute(firstChat, "smartwindow.tool_definitions")).map(
          tool => tool.function.name
        ),
        [GET_OPEN_TABS],
        "The model request records the tools it offered"
      );

      const tabsSpan = spans.find(span => span.name === GET_OPEN_TABS);
      Assert.equal(attribute(tabsSpan, "smartwindow.tool.executed"), true);
      Assert.equal(tabsSpan.status.code, 1);
      Assert.ok(
        JSON.parse(attribute(tabsSpan, "output.value")).some(tab =>
          tab.title.includes("Trace Test")
        ),
        "The tool span records the real open tab"
      );

      const memoriesSpan = spans.find(span => span.name === GET_USER_MEMORIES);
      Assert.equal(attribute(memoriesSpan, "smartwindow.tool.executed"), false);
      Assert.equal(memoriesSpan.status.code, 2, "A rejected call is an error");
      Assert.equal(
        memoriesSpan.status.message,
        "Error: tool_not_allowed",
        "The error status carries the message Langfuse shows"
      );
      Assert.equal(
        attribute(memoriesSpan, "exception.message"),
        "Error: tool_not_allowed"
      );
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_collector_failure_is_reported_by_flush() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.trace.enabled", true]],
  });
  await withTraceFixture(
    async ({ startTurn, captureChatRequest, collector }) => {
      collector.rejects(new Error("Collector unavailable"));
      const { done } = await startTurn();
      (await captureChatRequest()).respond(ANSWER);
      Assert.ok(
        await done,
        "A collector failure does not fail the turn it traces"
      );
      Assert.ok(
        !(await SmartWindowTrace.flush()),
        "The collector failure is reported by flush"
      );
      Assert.ok(await SmartWindowTrace.flush(), "flush resets the failure");
    }
  );
  await SpecialPowers.popPrefEnv();
});
