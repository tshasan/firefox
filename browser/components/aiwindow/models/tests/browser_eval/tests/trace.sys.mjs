/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

import { HttpServer } from "resource://testing-common/httpd.sys.mjs";
import { Chat } from "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs";
import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs";
import { UserRoleOpts } from "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs";
import {
  MAX_CONTENT_LENGTH,
  SmartWindowTrace,
} from "moz-src:///browser/components/aiwindow/models/Trace.sys.mjs";
import { openAIEngine } from "moz-src:///browser/components/aiwindow/models/openAIEngine.sys.mjs";
import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";
import { buildEngineForFeature } from "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs";
import { EngineProcess } from "chrome://global/content/ml/EngineProcess.sys.mjs";
import { PageExtractorParent } from "resource://gre/actors/PageExtractorParent.sys.mjs";
import {
  MODEL_FEATURES,
  SERVICE_TYPES,
  PURPOSES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";

// eslint-disable-next-line sdl/no-insecure-url
const EVAL_SERVER = "http://127.0.0.1:4318";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const LOCAL_API_KEY = "local-evaluation";

function fixtureHTML(document, { title, body }) {
  const page = document.implementation.createHTMLDocument(title);
  page.documentElement.lang = "en";
  const article = page.body.appendChild(page.createElement("article"));
  article.appendChild(page.createElement("h1")).textContent = title;
  article.appendChild(page.createElement("p")).textContent = body;
  return `<!DOCTYPE html>${page.documentElement.outerHTML}`;
}

/**
 * Wraps PageExtractorParent.getText so each turn can record what every page
 * extraction returned.
 *
 * @returns {{setRecords: (records: ?object[]) => void, restore: () => void}}
 */
function recordExtractions() {
  let currentRecords = null;
  const originalGetText = PageExtractorParent.prototype.getText;
  PageExtractorParent.prototype.getText = async function (...args) {
    const records = currentRecords;
    if (!records) {
      return originalGetText.apply(this, args);
    }
    const started = ChromeUtils.now();
    const record = {
      url:
        args[0]?.sourceUrl ??
        this.browsingContext?.currentWindowGlobal?.documentURI?.spec,
      strategy:
        this.browsingContext?.currentWindowGlobal?.documentPrincipal
          ?.originNoSuffix === "resource://pdf.js"
          ? "pdf"
          : "html",
      sufficientLength: args[0]?.sufficientLength,
      success: false,
    };
    records.push(record);
    try {
      const result = await originalGetText.apply(this, args);
      const text = result?.text ?? "";
      Object.assign(record, {
        success: !!text,
        textLength: text.length,
        extractedText: text.slice(0, MAX_CONTENT_LENGTH),
        truncated: text.length > MAX_CONTENT_LENGTH,
      });
      return result;
    } catch (error) {
      record.error = String(error);
      throw error;
    } finally {
      record.elapsedMs = ChromeUtils.now() - started;
    }
  };
  return {
    setRecords: records => (currentRecords = records),
    restore: () => {
      currentRecords = null;
      PageExtractorParent.prototype.getText = originalGetText;
    },
  };
}

function isPDFViewer(browser) {
  return (
    browser.browsingContext.currentWindowGlobal?.documentPrincipal
      .originNoSuffix === "resource://pdf.js"
  );
}

/**
 * Opens a scenario's source documents and waits until each is readable.
 *
 * @param {object} scenario
 * @param {object} harness
 * @param {(path: string, page: object) => void} harness.servePage
 * @param {string} harness.origin - The origin of the fixture server.
 * @param {Function} harness.setupEvaluation
 * @param {object} harness.SpecialPowers
 * @param {Function} harness.info
 * @param {object[]} fixtures - Filled with each opened fixture, so the
 *   caller can close the ones that opened when a later one fails.
 */
async function openFixtures(
  scenario,
  { servePage, origin, setupEvaluation, SpecialPowers, info },
  fixtures
) {
  for (const [index, page] of scenario.tabs.entries()) {
    const path = `/${scenario.id}/${index}.html`;
    servePage(path, page);
    const fixture = await setupEvaluation({ url: page.url ?? origin + path });
    fixtures.push(fixture);
    info(`${scenario.id}: source ${index} loaded`);
    const browser = fixture.tab.linkedBrowser;
    if (
      page.mediaType === "application/pdf" ||
      new URL(browser.currentURI.spec).pathname.toLowerCase().endsWith(".pdf")
    ) {
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.wrappedJSObject.PDFViewerApplication?.pdfDocument,
          "The source PDF is loaded in Firefox"
        );
      });
    }
    if (page.waitForSelector) {
      await SpecialPowers.spawn(
        browser,
        [page.waitForSelector],
        async selector => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(selector),
            `Fixture ready: ${selector}`
          );
        }
      );
    }
  }
}

async function closeFixtures(fixtures, SpecialPowers) {
  for (const fixture of fixtures.toReversed()) {
    if (isPDFViewer(fixture.tab.linkedBrowser)) {
      await SpecialPowers.spawn(fixture.tab.linkedBrowser, [], async () => {
        await content.wrappedJSObject.PDFViewerApplication.testingClose();
      });
    }
    await fixture.cleanup();
  }
}

/**
 * Converts an execution record into the payload RecordedScores expects. A
 * model failure leaves its scores unavailable rather than failing the run.
 *
 * @param {object} record
 * @returns {object}
 */
function recordedScores(record) {
  const scores = [];
  const unavailableScores = [];
  for (const { name, status, value, comment } of record.scores) {
    if (status === "scored") {
      scores.push({ name, score: value });
    } else if (status === "error") {
      scores.push({ name, error: comment });
    } else {
      unavailableScores.push({ name, reason: comment });
    }
  }
  return {
    caseId: record.caseId,
    repetition: record.repetition,
    turnIndex: record.turnIndex,
    status: record.status,
    error: null,
    scores,
    unavailableScores,
  };
}

async function evalRequest(path, payload, signal) {
  const response = await fetch(`${EVAL_SERVER}${path}`, {
    method: payload ? "POST" : "GET",
    ...(payload && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Evaluation server ${path}: HTTP ${response.status}: ${await response.text()}`
    );
  }
  return response.json();
}

export async function runTraceEvaluation({
  Assert,
  SpecialPowers,
  setupEvaluation,
  reportEvalResult,
  registerCleanupFunction,
  info,
  gBrowser,
  document,
}) {
  const windowAbortSignal = document.defaultView.AbortSignal;
  const sendEvalRequest = (path, payload) =>
    evalRequest(path, payload, windowAbortSignal.timeout(240_000));
  const config = await sendEvalRequest("/config");
  const { runId, model, repetitions = 1, toolPolicy } = config;
  const scenarios = await sendEvalRequest("/scenarios");
  Assert.ok(scenarios.length, "The benchmark has scenarios");
  Assert.ok(
    Number.isInteger(repetitions) && repetitions > 0,
    "Valid repetition count"
  );
  const isFirefoxModel = model.kind === "firefox";
  const prefs = [
    ["browser.smartwindow.enabled", true],
    ["browser.smartwindow.trace.enabled", true],
    ["browser.ml.enable", true],
    ["browser.ml.checkForMemory", false],
  ];
  const clearPrefs = [];
  let token, engineHost;
  if (isFirefoxModel) {
    token = Services.env.get("MOZ_FXA_BEARER_TOKEN");
    Assert.ok(
      token,
      "MOZ_FXA_BEARER_TOKEN must be set in the environment. Please run ./mach eval-tools login."
    );
    prefs.push(["sidebar.notification.badge.aichat", false]);
    clearPrefs.push(
      ["nimbus.migrations.after-remote-settings-update"],
      ["browser.ml.chat.onboarding.config"],
      ["browser.ml.chat.nimbus"]
    );
    engineHost = new URL(
      openAIEngine.resolveEndpointConfig(model.choice).baseURL
    ).hostname;
  } else {
    token = Services.env.get(model.apiKeyEnv) || LOCAL_API_KEY;
    prefs.push(
      ["browser.smartwindow.model", model.model],
      ["browser.smartwindow.firstrun.modelChoice", "0"],
      ["browser.smartwindow.customEndpoint", model.endpoint]
    );
    engineHost = new URL(model.endpoint).hostname;
  }
  const allowedHosts = new Set([...LOOPBACK_HOSTS, engineHost]);
  prefs.push([
    "network.socket.allowed_nonlocal_domains",
    LOOPBACK_HOSTS.includes(engineHost) ? "" : engineHost,
  ]);
  const blockedNetworkHosts = new Set();
  if (config.offline) {
    const offlineObserver = subject => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const host = channel.URI.host;
      if (!allowedHosts.has(host)) {
        blockedNetworkHosts.add(host);
        channel.cancel(Cr.NS_ERROR_OFFLINE);
      }
    };
    Services.obs.addObserver(offlineObserver, "http-on-modify-request");
    registerCleanupFunction(() =>
      Services.obs.removeObserver(offlineObserver, "http-on-modify-request")
    );
  }
  await SpecialPowers.pushPrefEnv({
    set: prefs,
    clear: clearPrefs,
  });

  const root = document.documentElement;
  const previousAIWindow = root.getAttribute("ai-window");
  root.setAttribute("ai-window", "true");
  const server = new HttpServer();
  const pages = new Map();
  server.registerPrefixHandler("/", (request, response) => {
    const page = pages.get(request.path);
    if (!page) {
      response.setStatusLine(request.httpVersion, 404, "Not found");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.write(page.html ?? fixtureHTML(document, page));
  });
  server.start(-1);
  const harness = {
    servePage: (path, page) => pages.set(path, page),
    // eslint-disable-next-line sdl/no-insecure-url
    origin: `http://127.0.0.1:${server.identity.primaryPort}`,
    setupEvaluation,
    SpecialPowers,
    info,
  };

  const extractionRecorder = recordExtractions();
  let originalGetToken = null;
  let stopReason = null;
  try {
    let engine;
    if (isFirefoxModel) {
      originalGetToken = AuthProvider.getToken;
      // Tools, title generation and the 401 retry fetch their own token.
      AuthProvider.getToken = async () => token;
      ({ engine } = await buildEngineForFeature(MODEL_FEATURES.CHAT, {
        modelChoiceIdOverride: model.choice,
      }));
    } else {
      engine = await openAIEngine.build({
        model: model.model,
        serviceType: SERVICE_TYPES.AI,
        purpose: PURPOSES.CHAT,
        feature: MODEL_FEATURES.CHAT,
        baseURL: model.endpoint,
        apiKey: token,
      });
    }

    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const scenario of scenarios) {
        info(`${scenario.id}: opening source documents`);
        const fixtures = [];
        try {
          await openFixtures(scenario, harness, fixtures);
          const tabs = fixtures.map(({ tab }, index) => ({
            index,
            url: tab.linkedBrowser.currentURI.spec,
            title: tab.label,
          }));
          const firstTab = fixtures[scenario.activeTab ?? 0].tab;
          const conversation = new ChatConversation({
            title: scenario.id,
            pageUrl: new URL(firstTab.linkedBrowser.currentURI.spec),
            pageMeta: {},
          });
          conversation.engine = engine;
          conversation.parameters = model.parameters;
          const turns = scenario.turns ?? [{ prompt: scenario.prompt }];
          for (const [turnIndex, turn] of turns.entries()) {
            const activeIndex = turn.activeTab ?? scenario.activeTab ?? 0;
            const activeTab = fixtures[activeIndex].tab;
            gBrowser.selectedTab = activeTab;
            const pageUrl = new URL(activeTab.linkedBrowser.currentURI.spec);
            const originalQuestion = turn.prompt;
            const { outputInstruction } = config;
            const prompt =
              tabs.reduce(
                (text, tab, index) =>
                  text.replaceAll(`{{url${index}}}`, tab.url),
                turn.prompt
              ) + outputInstruction;
            const contextIndices =
              turn.contextTabIndices ?? scenario.contextTabIndices ?? [];
            const userOpts = new UserRoleOpts({
              memoriesEnabled: false,
              contextMentions: contextIndices.map(index => ({
                type: index === activeIndex ? "currentTab" : "tab",
                url: tabs[index].url,
                label: tabs[index].title,
              })),
            });
            const beforeMessages =
              conversation.getMessagesInChatCompletionsFormat().length;
            const extractions = [];
            extractionRecorder.setRecords(extractions);
            let error = null;
            const signal = windowAbortSignal.timeout(config.caseTimeoutMs);
            try {
              info(`${scenario.id}/${turnIndex}: building the prompt`);
              await conversation.generatePrompt(prompt, pageUrl, userOpts);
              info(`${scenario.id}/${turnIndex}: running chat`);
              conversation.addAssistantMessage("text", "");
              await Chat.fetchWithHistory({
                conversation,
                browsingContext: activeTab.linkedBrowser.browsingContext,
                mode: "sidebar",
                signal,
                tokenPromise: Promise.resolve(token),
                toolPolicy: {
                  allowedTools: toolPolicy.allowedTools,
                  maxModelRequests: config.modelCallsPerCase,
                  allowedUrls: toolPolicy.restrictUrlsToSources
                    ? tabs.map(tab => tab.url)
                    : undefined,
                },
                traceMetadata: {
                  runId,
                  scenarioId: scenario.id,
                  repetition,
                  turnIndex,
                },
              });
              if (signal.aborted) {
                error = "Scenario timed out";
              }
            } catch (exception) {
              error =
                exception.metadata?.errorMessage?.message || String(exception);
            } finally {
              extractionRecorder.setRecords(null);
            }
            const messages = conversation.getMessagesInChatCompletionsFormat();
            const turnMessages = messages.slice(beforeMessages);
            const responseText =
              turnMessages.findLast(message => message.role === "assistant")
                ?.content ?? "";
            const toolCalls = turnMessages.flatMap(
              message => message.tool_calls ?? []
            );
            const exported = await SmartWindowTrace.flush();
            const result = await sendEvalRequest("/results", {
              runId,
              scenarioId: scenario.id,
              conversationId: conversation.id,
              repetition,
              turnIndex,
              model: model.model || model.choice,
              promptVersion: conversation.systemPromptVersion,
              firefoxBuild: {
                version: Services.appinfo.version,
                buildId: Services.appinfo.appBuildID,
              },
              originalQuestion,
              outputInstruction,
              prompt,
              responseText,
              toolCalls,
              evidence: turnMessages.filter(message => message.role === "tool"),
              tabs,
              extractions,
              blockedNetworkHosts: [...blockedNetworkHosts],
              error,
            });
            // Model failures are reported through the recorded scores and
            // the runner's exit code rather than failing this test.
            reportEvalResult(recordedScores(result));
            Assert.ok(
              exported,
              `${scenario.id}/${turnIndex}: traces reached the local collector`
            );
            info(
              `${scenario.id}/${turnIndex}: ${error ? `model failed: ${error}` : "model completed"}`
            );
            for (const score of result.scores) {
              Assert.notEqual(
                score.status,
                "error",
                `${scenario.id}/${turnIndex}: ${score.name} was scored: ${score.comment}`
              );
            }
            if (!result.continue) {
              stopReason = result.stopReason;
              info(`Stopping the evaluation: ${stopReason}`);
            }
            if (error || stopReason) {
              break;
            }
          }
        } finally {
          extractionRecorder.setRecords(null);
          await closeFixtures(fixtures, SpecialPowers);
          pages.clear();
        }
        if (stopReason) {
          break;
        }
      }
      if (stopReason) {
        break;
      }
    }
  } finally {
    extractionRecorder.restore();
    if (originalGetToken) {
      AuthProvider.getToken = originalGetToken;
    }
    await new Promise(resolve => server.stop(resolve));
    await EngineProcess.destroyMLEngine();
    if (previousAIWindow === null) {
      root.removeAttribute("ai-window");
    } else {
      root.setAttribute("ai-window", previousAIWindow);
    }
    await SpecialPowers.popPrefEnv();
  }
}
