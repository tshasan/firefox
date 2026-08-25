/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let gSchemaRegistered = false;

function ensureSchemaRegistered() {
  if (gSchemaRegistered) {
    return;
  }
  gSchemaRegistered = true;

  ChromeUtils.registerMarkerSchema({
    name: "PageExtractor",
    tooltipLabel: "{marker.data.phaseLabel}",
    tableLabel: "{marker.data.process}: {marker.data.phaseLabel}",
    chartLabel: "{marker.data.phaseLabel}",
    display: ["marker-chart", "marker-table"],
    colorField: "color",
    data: [
      { key: "process", label: "Process", format: "string" },
      {
        key: "phaseLabel",
        label: "Description",
        format: "string",
        searchable: true,
      },
      { key: "phase", label: "Phase", format: "string", searchable: true },
      {
        key: "flowId",
        label: "Flow ID",
        format: "string",
        searchable: true,
      },
      {
        key: "strategy",
        label: "Strategy",
        format: "string",
        searchable: true,
      },
      {
        key: "siteStrategy",
        label: "Site strategy",
        format: "string",
        searchable: true,
      },
      { key: "status", label: "Status", format: "string", searchable: true },
      { key: "options", label: "Selected options", format: "string" },
      { key: "textLength", label: "Text length", format: "integer" },
      { key: "linkCount", label: "Links", format: "integer" },
      { key: "canvasCount", label: "Canvases", format: "integer" },
      {
        key: "errorName",
        label: "Error",
        format: "string",
        searchable: true,
      },
      { key: "color", hidden: true },
    ],
  });
}

/**
 * Formats only the options the caller passed to getText(), so the marker
 * shows what was selected, not defaults it never applied.
 *
 * @param {Record<string, any>} options
 */
function formatOptions(options) {
  return Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

/**
 * Plain-language label for each phase, kept in one place so adding or
 * renaming a phase only touches this file. The raw phase string (e.g.
 * "dom-extract") stays in the marker's `phase` field for correlating with
 * code; `label` is what a non-developer reading a shared profile sees.
 *
 * A phase missing here falls back to a label in PageExtractorEvent's
 * constructor instead of "undefined".
 */
const PHASES = {
  "headless-extractor": { label: "Load page in the background" },
  "headless-navigate": { label: "Navigate to page" },
  "wait-for-ready": { label: "Wait for page to finish loading" },
  "get-page-metadata": { label: "Read page details" },
  "get-text": { label: "Extract page text" },
  "pdf-extract": { label: "Read PDF text" },
  "reader-parse": { label: "Simplify page (Reader Mode)" },
  "reader-output-parse": { label: "Process simplified page" },
  "dom-extract": { label: "Scan page content" },
  "canvas-capture": { label: "Capture page images" },
  "youtube-extract": { label: "Read video transcript" },
  "access-denied": { label: "Blocked: untrusted content in conversation" },
};

// Each marker is named with a small integer (e.g. "PageExtractor #3") so
// concurrent top-level calls get separate profiler tracks; nested phases
// share their call's number to land on the same track.
//
// The number is minted once at the root and travels as an `<instance>:`
// prefix on flowId, not a process-local table, since parent and content
// processes don't share memory and flowId is what already crosses the IPC
// boundary.
let gNextInstance = 1;

/**
 * @param {string} token - A bare flowId for a new flow or one handed in
 *   from outside this scheme, or an `<instance>:<uuid>` token forwarded
 *   from where the flow began.
 * @returns {{ instance: number, flowId: string, correlationId: string }}
 */
export function parseFlowToken(token) {
  const separatorIndex = token.indexOf(":");
  if (separatorIndex === -1) {
    return { instance: gNextInstance++, flowId: token, correlationId: token };
  }
  return {
    instance: Number(token.slice(0, separatorIndex)),
    flowId: token,
    correlationId: token.slice(separatorIndex + 1),
  };
}

const DEFAULT_MARKER_COLOR = "blue";
// Statuses other than "success" or "error" (e.g. "unavailable",
// "document-hidden", "empty") are handled outcomes, not thrown exceptions.
const HANDLED_OUTCOME_MARKER_COLOR = "yellow";
const ERROR_MARKER_COLOR = "red";

/**
 * Accumulates data for one PageExtractor instrumentation event. `finish()`
 * always records a `page_extractor.phase` Glean event, and a profiler
 * marker only while profiling; both are keyed by `flowId` so parent- and
 * content-process records describe the same request.
 */
export class PageExtractorEvent {
  #data;
  #innerWindowId;
  #startTime;
  #options;
  #instance;
  #correlationId;
  #finished = false;

  /**
   * @param {string} phase
   * @param {Record<string, any>} data
   */
  constructor(phase, data) {
    this.#startTime = ChromeUtils.now();
    this.#innerWindowId = data.innerWindowId;
    this.#options = data.options;
    const token = data.flowId ?? `${gNextInstance++}:${crypto.randomUUID()}`;
    const { instance, flowId, correlationId } = parseFlowToken(token);
    this.#instance = instance;
    this.#correlationId = correlationId;
    this.#data = {
      type: "PageExtractor",
      process: data.process,
      phase,
      phaseLabel: PHASES[phase]?.label ?? phase,
      flowId,
    };
    if (data.strategy) {
      this.#data.strategy = data.strategy;
    }
  }

  get flowId() {
    return this.#data.flowId;
  }

  addData(data) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        this.#data[key] = value;
      }
    }
  }

  // Idempotent so racing outcomes (e.g. navigation vs. timeout) can each
  // call finish() unconditionally; the first call wins.
  finish(data = {}) {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.addData(data);

    // Recorded before the profiler-active check: Glean is the permanent
    // record, the profiler marker isn't.
    Glean.pageExtractor.phase.record({
      // flowId's `<instance>:` prefix is a profiler display detail; not
      // carried into permanent telemetry.
      flow_id: this.#correlationId,
      process: this.#data.process,
      phase: this.#data.phase,
      strategy: this.#data.strategy,
      site_strategy: this.#data.siteStrategy,
      status: this.#data.status,
      error_name: this.#data.errorName,
      text_length: this.#data.textLength,
      link_count: this.#data.linkCount,
      canvas_count: this.#data.canvasCount,
      duration_ms: Math.round(ChromeUtils.now() - this.#startTime),
    });

    if (!Services.profiler.IsActive()) {
      return;
    }
    ensureSchemaRegistered();
    if (this.#data.status === "success") {
      this.#data.color = DEFAULT_MARKER_COLOR;
    } else if (this.#data.status === "error") {
      this.#data.color = ERROR_MARKER_COLOR;
    } else {
      this.#data.color = HANDLED_OUTCOME_MARKER_COLOR;
    }
    const formatted = this.#options ? formatOptions(this.#options) : "";
    if (formatted) {
      this.#data.options = formatted;
    }
    ChromeUtils.addProfilerMarker(
      `PageExtractor #${this.#instance}`,
      {
        category: "JavaScript",
        innerWindowId: this.#innerWindowId,
        startTime: this.#startTime,
      },
      this.#data
    );
  }

  /**
   * Runs `task`, finishing with "success" on resolve or "error" (and
   * rethrowing) on throw. `task` can call `finish()` itself first for a
   * more specific status (e.g. "unavailable"); since finish() is
   * idempotent, the status set here is then a no-op.
   *
   * @template T
   * @param {() => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  async run(task) {
    try {
      const result = await task();
      this.finish({ status: "success" });
      return result;
    } catch (error) {
      this.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }
}
