/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { MESSAGE_ROLE } from "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs";

/** The local OTLP/HTTP collector the evaluation harness runs. */
const ENDPOINT = "http://127.0.0.1:4318/v1/traces";

/** Spans per turn, so a looping tool chain cannot grow one trace unbounded. */
const MAX_SPANS = 128;

/** Characters kept from one content attribute, such as a prompt or a page. */
export const MAX_CONTENT_LENGTH = 131072;

/** Characters of content kept across all spans of one turn. */
const TURN_CONTENT_BUDGET = 1024 * 1024;

/** Characters kept from an attribute that is not content. */
const MAX_ATTRIBUTE_LENGTH = 1024;

/** Exports in flight before new turns are dropped, if the collector stalls. */
const MAX_PENDING_EXPORTS = 4;

const EXPORT_TIMEOUT_MS = 3000;

const CONTENT_ATTRIBUTES = new Set([
  "input.value",
  "output.value",
  "smartwindow.tool_definitions",
  "llm.invocation_parameters",
]);

/** OTLP SpanKind values. */
const SPAN_KIND = { INTERNAL: 1, CLIENT: 3 };

/** OTLP StatusCode values. */
const STATUS_CODE = { OK: 1, ERROR: 2 };

/** Exports that have not settled yet, awaited by `flush`. */
const pendingExports = new Set();

/** Whether an export failed or was dropped since the last `flush`. */
let exportFailed = false;

function id(length) {
  return crypto.randomUUID().replaceAll("-", "").slice(0, length);
}

function nowUnixNano(state) {
  return String(
    state.epoch + BigInt(Math.round((ChromeUtils.now() - state.start) * 1e6))
  );
}

/** A span in one explicitly passed, bounded development trace. */
class TraceSpan {
  /**
   * @param {object} state - The trace this span belongs to.
   * @param {string} name
   * @param {string} kind - The OpenInference span kind, such as "LLM".
   * @param {?TraceSpan} parent
   * @param {*} [input] - Recorded as `input.value`.
   * @param {object} [attributes]
   */
  constructor(state, name, kind, parent, input, attributes) {
    this.state = state;
    this.attributes = new Map();
    this.span = {
      traceId: state.traceId,
      spanId: id(16),
      name,
      kind: kind === "LLM" ? SPAN_KIND.CLIENT : SPAN_KIND.INTERNAL,
      startTimeUnixNano: nowUnixNano(state),
      status: { code: STATUS_CODE.OK },
    };
    if (parent) {
      this.span.parentSpanId = parent.span.spanId;
    }
    state.spans.push(this);
    this.set({
      "openinference.span.kind": kind,
      "input.value": input,
      ...attributes,
    });
  }

  set(attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null) {
        continue;
      }
      let encoded;
      if (typeof value === "number" && Number.isFinite(value)) {
        encoded = Number.isSafeInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value };
      } else if (typeof value === "boolean") {
        encoded = { boolValue: value };
      } else {
        let text;
        try {
          text = typeof value === "string" ? value : JSON.stringify(value);
        } catch {
          // Tool results can hold cycles or BigInts; mark rather than fail the turn.
          this.attributes.set("smartwindow.serialization_error", {
            boolValue: true,
          });
          continue;
        }
        const content = CONTENT_ATTRIBUTES.has(key);
        const limit = content
          ? Math.min(MAX_CONTENT_LENGTH, this.state.remaining)
          : MAX_ATTRIBUTE_LENGTH;
        encoded = { stringValue: text.slice(0, limit) };
        if (content) {
          this.state.remaining -= encoded.stringValue.length;
        }
        if (text.length > limit) {
          this.attributes.set("smartwindow.truncated", { boolValue: true });
        }
      }
      if (key === "input.value" || key === "output.value") {
        this.attributes.set(key.replace(".value", ".mime_type"), {
          stringValue:
            typeof value === "string" ? "text/plain" : "application/json",
        });
      }
      this.attributes.set(key, encoded);
    }
  }

  child(name, kind, input, attributes = {}) {
    if (this.state.spans.length >= MAX_SPANS) {
      this.set({ "smartwindow.truncated": true });
      return null;
    }
    return new TraceSpan(this.state, name, kind, this, input, attributes);
  }

  end(output, error, attributes = {}) {
    if (this.span.endTimeUnixNano) {
      return;
    }
    this.span.endTimeUnixNano = nowUnixNano(this.state);
    this.set({ "output.value": output, ...attributes });
    if (error) {
      const message = error.metadata?.errorMessage?.message || String(error);
      this.span.status = {
        code: STATUS_CODE.ERROR,
        message: message.slice(0, MAX_ATTRIBUTE_LENGTH),
      };
      this.set({
        "error.type":
          error.name || error.metadata?.errorMessage?.type || "Error",
        "exception.message": message,
      });
    }
    if (!this.span.parentSpanId) {
      for (const child of this.state.spans) {
        if (!child.span.endTimeUnixNano) {
          child.end(
            undefined,
            error || new Error("Turn ended before span completed")
          );
        }
      }
      exportTrace(this.state);
    }
  }

  /**
   * Ends a turn span, recording the assistant's reply.
   *
   * @param {ChatConversation} conversation
   * @param {?Error} error - The error the turn threw, if any.
   * @param {AbortSignal} [signal]
   */
  endTurn(conversation, error, signal) {
    this.end(
      conversation.messages.findLast(
        message => message.role === MESSAGE_ROLE.ASSISTANT
      )?.content,
      error || (signal?.aborted ? new Error("Turn cancelled") : null),
      { "smartwindow.cancelled": !!signal?.aborted }
    );
  }

  /**
   * @param {?string} model
   * @returns {?TraceSpan} The span for one model request.
   */
  startModelRequest(model) {
    return this.child("chat", "LLM", undefined, { "llm.model_name": model });
  }

  /**
   * @param {object[]} messages - The messages sent to the model.
   * @param {object[]} tools - The tool definitions offered to the model.
   * @param {object} parameters - The request parameters.
   */
  setModelRequest(messages, tools, parameters) {
    this.set({
      "input.value": messages,
      "smartwindow.tool_definitions": tools,
      "llm.invocation_parameters": parameters,
    });
  }

  /**
   * @param {object} response - The `receiveResponse` result.
   * @param {?Error} error
   */
  endModelRequest(response, error) {
    this.end(
      { text: response.fullResponseText, toolCalls: response.pendingToolCalls },
      error,
      {
        "llm.token_count.prompt": response.usage?.prompt_tokens,
        "llm.token_count.completion": response.usage?.completion_tokens,
      }
    );
  }

  /**
   * @param {object} toolCall - The model's tool call.
   * @returns {?TraceSpan} The span for one tool call, not yet executed.
   */
  startToolCall(toolCall) {
    return this.child(
      toolCall.function?.name || "unknown",
      "TOOL",
      toolCall.function?.arguments,
      {
        "gen_ai.tool.name": toolCall.function?.name,
        "gen_ai.tool.call.id": toolCall.id,
        "smartwindow.tool.executed": false,
      }
    );
  }

  /**
   * Records that a tool call passed its checks and started running.
   *
   * @param {object} toolParams - The parsed and expanded arguments.
   */
  markToolExecuted(toolParams) {
    this.set({ "input.value": toolParams, "smartwindow.tool.executed": true });
  }

  /**
   * @param {*} result - The tool's result.
   * @param {string} error - The tool_call event error, or "" on success.
   * @param {object} [outcome]
   * @param {boolean} [outcome.searchHandoff] - Whether the call handed the
   *   turn off to a search.
   * @param {boolean} [outcome.cancelled] - Whether the user stopped the turn.
   */
  endToolCall(result, error, { searchHandoff, cancelled } = {}) {
    this.end(result, error ? new Error(error) : null, {
      "smartwindow.search_handoff": searchHandoff,
      "smartwindow.cancelled": cancelled,
    });
  }
}

function exportTrace(state) {
  if (pendingExports.size >= MAX_PENDING_EXPORTS) {
    exportFailed = true;
    return;
  }
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "firefox-smart-window" },
            },
            {
              key: "openinference.project.name",
              value: { stringValue: "smart-window-evals" },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "firefox.smartwindow", version: "0.1" },
            spans: state.spans.map(({ span, attributes }) => ({
              ...span,
              attributes: Array.from(attributes, ([key, value]) => ({
                key,
                value,
              })),
            })),
          },
        ],
      },
    ],
  });
  const task = postTrace(body).finally(() => pendingExports.delete(task));
  pendingExports.add(task);
}

async function postTrace(body) {
  // AbortSignal.timeout needs a window's timers, which system modules lack.
  const controller = new AbortController();
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout -- Bound local collector requests.
  const timeout = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) {
      exportFailed = true;
    }
  } catch {
    exportFailed = true;
  } finally {
    clearTimeout(timeout);
  }
}

export const SmartWindowTrace = {
  /**
   * Starts the span for one chat turn, when local development tracing is on.
   *
   * @param {object} options - The `Chat.fetchWithHistory` options.
   * @returns {?TraceSpan}
   */
  startTurn(options) {
    const { conversation, mode, traceMetadata = {}, toolPolicy } = options;
    if (
      !Services.prefs.getBoolPref("browser.smartwindow.trace.enabled", false) ||
      (AppConstants.MOZILLA_OFFICIAL && !Cu.isInAutomation)
    ) {
      return null;
    }
    const state = {
      traceId: id(32),
      epoch: BigInt(Date.now()) * 1000000n,
      start: ChromeUtils.now(),
      spans: [],
      remaining: TURN_CONTENT_BUDGET,
    };
    return new TraceSpan(
      state,
      "smartwindow.turn",
      "CHAIN",
      null,
      conversation.messages.findLast(
        message => message.role === MESSAGE_ROLE.USER
      )?.content,
      {
        "session.id": conversation.id,
        "smartwindow.turn_index": conversation.currentTurnIndex(),
        "smartwindow.mode": mode,
        "smartwindow.run_id": traceMetadata.runId,
        "smartwindow.scenario_id": traceMetadata.scenarioId,
        "smartwindow.repetition": traceMetadata.repetition,
        "smartwindow.eval_turn_index": traceMetadata.turnIndex,
        "smartwindow.prompt_version": conversation.systemPromptVersion,
        "smartwindow.allowed_tools": toolPolicy?.allowedTools,
        "llm.model_name": conversation.engine?.model,
      }
    );
  },

  /**
   * @returns {Promise<boolean>} Whether every trace since the last flush
   *   reached the collector.
   */
  async flush() {
    await Promise.all([...pendingExports]);
    const success = !exportFailed;
    exportFailed = false;
    return success;
  },
};
