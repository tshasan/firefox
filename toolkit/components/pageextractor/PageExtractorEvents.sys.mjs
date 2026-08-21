/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  resolveMinCanvasSize,
  resolveMaxCanvasCount,
  resolveMaxCanvasDimension,
  resolveCanvasQuality,
} from "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs";

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
      { key: "host", label: "Host", format: "string", searchable: true },
      { key: "strategy", label: "Strategy", format: "string" },
      { key: "siteStrategy", label: "Site strategy", format: "string" },
      { key: "status", label: "Status", format: "string" },
      { key: "options", label: "Selected options", format: "string" },
      { key: "textLength", label: "Text length", format: "integer" },
      { key: "linkCount", label: "Links", format: "integer" },
      { key: "canvasCount", label: "Canvases", format: "integer" },
      { key: "errorName", label: "Error", format: "string" },
      { key: "color", hidden: true },
    ],
  });
}

/**
 * Every GetTextOptions field surfaced in the profiler marker's "options"
 * string and mirrored as a get_text Glean extra key, declared once so
 * adding a new option means adding exactly one entry here. This is
 * deliberately an allowlist rather than every key on the raw options
 * object: GetTextOptions also carries `sourceUrl`, which is PII and must
 * never reach the marker or telemetry, plus any options the actor rejects
 * or ignores (e.g. `cleanWhitespace`, which some callers pass but nothing
 * reads), and those must not leak through either.
 *
 * A new entry still needs a matching extra_key added to get_text in
 * metrics.yaml: Glean requires extra keys declared at build time, so that
 * one step can't be inferred from this list automatically. Forgetting it
 * makes the whole get_text event fail to record (Glean rejects unknown
 * extra keys), which the browser-chrome tests in
 * browser_page_extractor_telemetry.js will catch since they assert on the
 * recorded event.
 *
 * - `key`: the raw GetTextOptions field name, also used as the property
 *   name on the object resolveOptions() returns.
 * - `gleanKey`: the get_text extra_key name.
 * - `label`: marker display name, defaults to `key`.
 * - `resolve(rawValue)`: computes the effective value. Fields whose default
 *   depends on more than the raw value (e.g. maxCanvasCount) call the same
 *   resolve*() helper DOMExtractor/PageExtractorChild use, rather than
 *   re-deriving the default here, so the two can't drift out of sync.
 * - `formatMarker`/`formatGlean`: optional display/telemetry transforms.
 */
const OPTION_FIELDS = [
  {
    key: "sufficientLength",
    gleanKey: "sufficient_length",
    resolve: raw => raw ?? 0,
    formatMarker: value => value || "unbounded",
  },
  {
    key: "justViewport",
    gleanKey: "just_viewport",
    resolve: raw => raw ?? false,
  },
  {
    key: "removeBoilerplate",
    gleanKey: "remove_boilerplate",
    resolve: raw => raw ?? false,
  },
  {
    key: "_forceRemoveBoilerplate",
    gleanKey: "force_remove_boilerplate",
    label: "forceRemoveBoilerplate",
    resolve: raw => raw ?? false,
  },
  {
    key: "includeCanvasSnapshots",
    gleanKey: "include_canvas_snapshots",
    resolve: raw => raw ?? false,
  },
  {
    key: "minCanvasSize",
    gleanKey: "min_canvas_size",
    resolve: (raw, options) => resolveMinCanvasSize(options),
  },
  {
    key: "maxCanvasCount",
    gleanKey: "max_canvas_count",
    resolve: (raw, options) => resolveMaxCanvasCount(options),
  },
  {
    key: "maxCanvasDimension",
    gleanKey: "max_canvas_dimension",
    resolve: (raw, options) => resolveMaxCanvasDimension(options),
  },
  {
    key: "canvasQuality",
    gleanKey: "canvas_quality_percent",
    resolve: (raw, options) => resolveCanvasQuality(options),
    formatGlean: value => Math.round(value * 100),
  },
];

/**
 * Resolves the effective GetTextOptions, applying the same defaults
 * DOMExtractor/PageExtractorChild apply when a field is omitted. Telemetry
 * extra_keys need a value for every field regardless of what the caller
 * passed in, so this is the single place those defaults are computed for
 * the get_text Glean event.
 *
 * @param {Record<string, any>} options
 */
function resolveOptions(options) {
  const resolved = {};
  for (const field of OPTION_FIELDS) {
    resolved[field.key] = field.resolve(options[field.key], options);
  }
  return resolved;
}

/**
 * Formats only the options the caller actually passed to getText(), rather
 * than the fully-resolved set from resolveOptions(): the marker should show
 * what was selected for this call, not enumerate every possible option.
 *
 * @param {Record<string, any>} options
 */
function formatOptions(options) {
  return OPTION_FIELDS.filter(field => options[field.key] !== undefined)
    .map(field => {
      const value = options[field.key];
      return `${field.label ?? field.key}=${field.formatMarker ? field.formatMarker(value) : value}`;
    })
    .join(", ");
}

/**
 * Builds the get_text extras derived from OPTION_FIELDS, so a new option
 * automatically reaches the Glean event once it's added to that list,
 * instead of needing a matching line hand-written into PHASES["get-text"].
 *
 * @param {Record<string, any>} resolvedOptions
 */
function optionExtras(resolvedOptions) {
  return Object.fromEntries(
    OPTION_FIELDS.map(field => {
      const value = resolvedOptions[field.key];
      return [
        field.gleanKey,
        field.formatGlean ? field.formatGlean(value) : value,
      ];
    })
  );
}

/**
 * Every phase's full metadata, declared once, so a new phase (or a change
 * to an existing one) touches exactly one place instead of several maps
 * that must be kept in sync by hand:
 *
 * - `label`: plain-language description for the marker's title/tooltip. The
 *   raw phase string (e.g. "dom-extract") stays in the marker's `phase`
 *   field for anyone searching or correlating with the code; `label` is
 *   only for what a non-developer reading a shared profile would see.
 * - `color`: one of Gecko's ten marker colors
 *   (mozglue/baseprofiler/public/BaseProfilerMarkersPrerequisites.h), so
 *   phases packed onto the same profiler row by time-overlap are still
 *   visually distinguishable without reading a truncated bar label.
 * - `recordGlean(base, data, resolvedOptions)`: only present for phases
 *   that report telemetry (the top-level, user-facing operations — firing
 *   an event for every one of the ~8 internal phases behind a single
 *   getText() call would multiply telemetry volume several times over for
 *   little analytical value, so only top-level operations get one; an
 *   internal phase's outcome is folded into the matching top-level event
 *   via addData() instead). Omitted entirely for phases that are
 *   profiler-marker-only.
 *
 * A phase missing from this registry (or missing `label`/`color`) still
 * shows *something* via the fallbacks in PageExtractorEvent's constructor,
 * rather than "undefined" or a crash — but won't record telemetry unless
 * it has a `recordGlean`.
 */
const PHASES = {
  "headless-extractor": {
    label: "Load page in the background",
    color: "purple",
    recordGlean: (base, data) =>
      Glean.pageextractorExtraction.headlessExtractor.record({
        ...base,
        strategy: data.strategy ?? "",
      }),
  },
  "headless-navigate": { label: "Navigate to page", color: "ink" },
  "wait-for-ready": {
    label: "Wait for page to finish loading",
    color: "yellow",
    recordGlean: base =>
      Glean.pageextractorExtraction.waitForReady.record(base),
  },
  "get-page-metadata": {
    label: "Read page details",
    color: "teal",
    recordGlean: (base, data) =>
      Glean.pageextractorExtraction.getPageMetadata.record({
        ...base,
        strategy: data.strategy ?? "",
      }),
  },
  "get-text": {
    label: "Extract page text",
    color: "blue",
    recordGlean: (base, data, resolvedOptions) =>
      Glean.pageextractorExtraction.getText.record({
        ...base,
        strategy: data.strategy ?? "",
        site_strategy: data.siteStrategy ?? "",
        text_length: data.textLength ?? 0,
        link_count: data.linkCount ?? 0,
        canvas_count: data.canvasCount ?? 0,
        ...optionExtras(resolvedOptions),
      }),
  },
  "pdf-extract": { label: "Read PDF text", color: "magenta" },
  "reader-parse": { label: "Simplify page (Reader Mode)", color: "orange" },
  "reader-output-parse": {
    label: "Process simplified page",
    color: "orange",
  },
  "dom-extract": { label: "Scan page content", color: "green" },
  "canvas-capture": { label: "Capture page images", color: "grey" },
  "youtube-extract": { label: "Read video transcript", color: "red" },
};

/**
 * Records the Glean event for `data.phase`, a no-op for any phase without a
 * `recordGlean` in PHASES. `data` is the fully-accumulated event data (the
 * same shape the profiler marker for this phase would have received), and
 * `resolvedOptions` is the output of resolveOptions(), so the extra_keys
 * mirror exactly what the profiler marker's `options` string shows.
 *
 * @param {Record<string, any>} data
 * @param {Record<string, any> | undefined} resolvedOptions
 * @param {number} durationMs
 */
function recordGleanEvent(data, resolvedOptions, durationMs) {
  const recordGlean = PHASES[data.phase]?.recordGlean;
  if (!recordGlean) {
    return;
  }
  const base = {
    flow_id: data.flowId,
    status: data.status ?? "",
    error_type: data.errorName ?? "",
    duration_ms: Math.round(durationMs),
  };
  recordGlean(base, data, resolvedOptions);
}

/**
 * Accumulates data for one PageExtractor instrumentation event, and on
 * `finish()` fans it out to a profiler marker (only while profiling) and a
 * Glean telemetry event (only for phases with a PHASES entry's
 * `recordGlean`), keyed by the same `flowId` so a captured profile and a
 * telemetry row describe the same request.
 */
export class PageExtractorEvent {
  #data;
  #resolvedOptions;
  #innerWindowId;
  #startTime;
  #hasMarker;
  #recordsTelemetry;
  #finished = false;

  constructor(phase, data) {
    this.#startTime = ChromeUtils.now();
    this.#innerWindowId = data.innerWindowId;
    this.#hasMarker = Services.profiler.IsActive();
    this.#recordsTelemetry =
      data.process === "parent" && !!PHASES[phase]?.recordGlean;
    const flowId = data.flowId ?? crypto.randomUUID();
    this.#data = {
      type: "PageExtractor",
      process: data.process,
      phase,
      phaseLabel: PHASES[phase]?.label ?? phase,
      flowId,
      color: PHASES[phase]?.color ?? "grey",
    };
    if (this.#recordsTelemetry && data.options) {
      this.#resolvedOptions = resolveOptions(data.options);
    }
    if (this.#hasMarker) {
      ensureSchemaRegistered();
      const formatted = data.options ? formatOptions(data.options) : "";
      if (formatted) {
        this.#data.options = formatted;
      }
    }
    if (data.strategy) {
      this.#data.strategy = data.strategy;
    }
    if (data.host) {
      this.#data.host = data.host;
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

  // Idempotent so callers racing multiple outcomes (e.g. a navigation vs. a
  // timeout) can all call finish() unconditionally and let whichever comes
  // first win.
  finish(data = {}) {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.addData(data);
    if (this.#hasMarker) {
      // The marker chart groups markers into rows by this literal name (not
      // by the registered schema, which is matched separately via
      // this.#data.type below), stacking same-name overlapping markers into
      // shared sub-rows. Suffixing a per-flow tag gives every flow its own
      // row instead of several concurrent flows (e.g. a batch of headless
      // extractions) getting packed together indistinguishably.
      ChromeUtils.addProfilerMarker(
        `PageExtractor ${this.#data.flowId.slice(0, 8)}`,
        {
          category: "JavaScript",
          innerWindowId: this.#innerWindowId,
          startTime: this.#startTime,
        },
        this.#data
      );
    }
    if (this.#recordsTelemetry) {
      recordGleanEvent(
        this.#data,
        this.#resolvedOptions,
        ChromeUtils.now() - this.#startTime
      );
    }
  }
}
