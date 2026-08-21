"use strict";

// devtools panel pages only get browser.devtools.*/runtime/i18n/extension —
// browser.tabs is not injected here, so the inspected page's URL has to
// come from inspectedWindow.eval() instead of browser.tabs.get().
const tabId = browser.devtools.inspectedWindow.tabId;

// None of these presets touch site-strategy (Google SERP / YouTube):
// DOMExtractor picks that automatically from sourceUrl alone (see
// getStrategyForUrl() in DOMExtractor.sys.mjs) — it isn't a GetTextOptions
// field a preset (or any caller) opts into. sourceUrl is already
// auto-filled from the inspected page, so just being on an actual Google
// Search results page or YouTube watch page when you click Extract is
// enough; check the profiler marker or the get_text telemetry event for
// this flowId to see the "siteStrategy" value, if any, that actually ran.
const PRESETS = {
  default: {},
  readerMode: { removeBoilerplate: true },
  viewportOnly: { justViewport: true },
  withImages: { includeCanvasSnapshots: true },
  shortSummary: { sufficientLength: 500 },
  longArticle: { sufficientLength: 50000, removeBoilerplate: true },
  everything: {
    removeBoilerplate: true,
    justViewport: true,
    includeCanvasSnapshots: true,
  },
  // The three real Smart Window call sites (Tools.sys.mjs /
  // SmartFormFillParent.sys.mjs), each with its own options. All three also
  // pass cleanWhitespace, but DOMExtractor never reads that key, so it's
  // omitted here as a no-op in every one of them.
  //
  // get_page_content tool (GetPageContent#runExtraction) — the
  // general-purpose "read this page" call.
  smartWindowDefault: { sufficientLength: 10000, removeBoilerplate: true },
  // run_search tool's SERP extraction (RunSearch#extractSerpContent) —
  // boilerplate/nav is kept since result.links comes from it.
  smartWindowSerp: { sufficientLength: 15000, removeBoilerplate: false },
  // Smart Form Fill (SmartFormFillParent#getPageText) — sufficientLength is
  // actually MAX_PAGE_CONTENT_LENGTH (10000) divided across however many
  // tabs are being read; 10000 here is the single-tab case.
  smartFormFill: { sufficientLength: 10000, removeBoilerplate: false },
};

const extractEls = {
  form: document.getElementById("options-form"),
  presets: document.getElementById("presets"),
  includeCanvasSnapshots: document.getElementById("includeCanvasSnapshots"),
  canvasFieldset: document.getElementById("canvas-fieldset"),
  sourceUrl: document.getElementById("sourceUrl"),
  output: document.getElementById("extract-output"),
  outputPerf: document.getElementById("extract-output-perf"),
  clearBoxes: document.getElementById("clear-boxes"),
  debugLayout: document.getElementById("debugLayout"),
  debugLayoutKindText: document.getElementById("debugLayoutKindText"),
  debugLayoutKindLink: document.getElementById("debugLayoutKindLink"),
  debugLayoutKindCanvas: document.getElementById("debugLayoutKindCanvas"),
  boxesWarning: document.getElementById("boxes-warning"),
  hoverInfo: document.getElementById("hover-info"),
  getPageMetadata: document.getElementById("get-page-metadata"),
  waitForPageReady: document.getElementById("wait-for-page-ready"),
  otherActionsOutput: document.getElementById("other-actions-output"),
  otherActionsPerf: document.getElementById("other-actions-perf"),
  headlessUrl: document.getElementById("headlessUrl"),
  headlessAnonymousFetch: document.getElementById("headlessAnonymousFetch"),
  headlessExtract: document.getElementById("headless-extract"),
  headlessOutput: document.getElementById("headless-output"),
  headlessOutputPerf: document.getElementById("headless-output-perf"),
};

const HOVER_POLL_INTERVAL_MS = 300;
let hoverPollId = null;

// There's no push channel from the content-process overlay to this panel
// (it would need to cross both the actor and WebExtension boundaries), so
// this polls the same way getText()/clearDebugOverlay() already do.
function startHoverPolling() {
  stopHoverPolling();
  hoverPollId = setInterval(async () => {
    let info;
    try {
      info = await browser.runtime.sendMessage({
        type: "pageExtractorDebug:getHoveredDebugBlock",
        tabId,
      });
    } catch {
      stopHoverPolling();
      return;
    }
    renderHoverInfo(info);
  }, HOVER_POLL_INTERVAL_MS);
}

function stopHoverPolling() {
  clearInterval(hoverPollId);
  hoverPollId = null;
}

function renderHoverInfo(info) {
  extractEls.hoverInfo.replaceChildren();
  if (!info) {
    const dt = document.createElement("dt");
    dt.textContent = "Nothing selected";
    const dd = document.createElement("dd");
    dd.textContent = "Click a box on the page to see what it is, in full here.";
    extractEls.hoverInfo.append(dt, dd);
    return;
  }
  const fields = [
    ["kind", info.kind],
    ["tag", `<${info.tag}>`],
    ["text", info.text],
    ["href", info.href],
  ];
  for (const [label, value] of fields) {
    if (value === undefined) {
      continue;
    }
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    extractEls.hoverInfo.append(dt, dd);
  }
}

async function getInspectedUrl() {
  const [url] = await browser.devtools.inspectedWindow.eval("location.href");
  return url ?? "";
}

getInspectedUrl().then(url => {
  extractEls.sourceUrl.value = url;
});

// Keep sourceUrl following the inspected page without the user having to
// do anything, since site-specific strategies (Google/YouTube) depend on it.
browser.devtools.network.onNavigated.addListener(url => {
  extractEls.sourceUrl.value = url;
});

extractEls.presets.addEventListener("change", () => {
  applyPreset(extractEls.presets.value);
});

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) {
    return;
  }
  for (const element of extractEls.form.elements) {
    // sourceUrl and _debugLayout are panel-only controls, not part of any
    // preset's GetTextOptions.
    if (
      element.name === "sourceUrl" ||
      element.name === "_debugLayout" ||
      !element.name
    ) {
      continue;
    }
    if (element.type === "checkbox") {
      element.checked = Boolean(preset[element.name]);
    } else if (element.type === "number") {
      element.value = preset[element.name] ?? "";
    }
  }
  syncCanvasFieldsetDisabled();
}

// A checkbox placed in a <fieldset>'s <legend> is exempt from the fieldset's
// own disabled state (see the HTML fieldset spec), so this both disables the
// rest of the canvas options in one shot and leaves the checkbox itself
// always clickable. collectOptions() skips disabled elements itself, so a
// disabled canvas option never ends up in the collected options.
function syncCanvasFieldsetDisabled() {
  extractEls.canvasFieldset.disabled =
    !extractEls.includeCanvasSnapshots.checked;
}
extractEls.includeCanvasSnapshots.addEventListener(
  "change",
  syncCanvasFieldsetDisabled
);

function collectOptions() {
  const options = {};
  for (const element of extractEls.form.elements) {
    if (!element.name || element.disabled) {
      continue;
    }
    if (element.type === "checkbox") {
      if (element.checked) {
        options[element.name] = true;
      }
    } else if (element.value !== "") {
      options[element.name] =
        element.type === "number" ? Number(element.value) : element.value;
    }
  }
  // The kind checkboxes have no `name` (see debugLayoutKind* in
  // extractEls), so the loop above skips them; build the explicit list
  // PageExtractorChild uses to filter which boxes get drawn.
  options._debugLayoutKinds = [
    ["text", extractEls.debugLayoutKindText],
    ["link", extractEls.debugLayoutKindLink],
    ["canvas", extractEls.debugLayoutKindCanvas],
  ]
    .filter(([, checkbox]) => checkbox.checked)
    .map(([kind]) => kind);
  return options;
}

extractEls.form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!extractEls.sourceUrl.value.trim()) {
    extractEls.sourceUrl.value = await getInspectedUrl();
  }

  const options = collectOptions();
  extractEls.output.replaceChildren(document.createElement("p"));
  extractEls.output.firstChild.textContent = "Extracting…";

  try {
    // Panel contexts can't call browser.pageExtractorDebug (an experiment
    // API) directly — only the background script's "addon_parent" context
    // gets that, so this relays through runtime messaging. The real boxes
    // are drawn and kept tracking scroll/resize/reflow directly on the page
    // by chrome-privileged content-process code (DebugLayoutOverlay.sys.mjs)
    // as a side effect of this call — nothing further to do here.
    const { result, markers, telemetry } = await browser.runtime.sendMessage({
      type: "pageExtractorDebug:getText",
      tabId,
      options,
    });
    renderExtractOutput(result, options);
    renderPerfData(markers, telemetry, extractEls.outputPerf);
    // The "reader" strategy runs DOMExtractor against a detached document
    // DOMParser built from Readability's output, not the live page — its
    // elements were never part of the rendered DOM, so there's nothing to
    // select (see the note renderExtractOutput() shows for this case).
    const boxesShown =
      options._debugLayout && !!result && result.strategy !== "reader";
    extractEls.boxesWarning.hidden = !boxesShown;
    if (boxesShown) {
      startHoverPolling();
    }
  } catch (error) {
    const p = document.createElement("p");
    const mark = document.createElement("mark");
    mark.textContent = error.message ?? String(error);
    p.append(mark);
    extractEls.output.replaceChildren(p);
  }
});

function hideDebugBoxes() {
  browser.runtime.sendMessage({
    type: "pageExtractorDebug:clearDebugOverlay",
    tabId,
  });
  stopHoverPolling();
  renderHoverInfo(null);
  extractEls.boxesWarning.hidden = true;
}

extractEls.clearBoxes.addEventListener("click", hideDebugBoxes);

// Unchecking hides any boxes already on the page immediately, rather than
// only taking effect on the next extraction.
extractEls.debugLayout.addEventListener("change", () => {
  if (!extractEls.debugLayout.checked) {
    hideDebugBoxes();
  }
});

function renderOtherActionsOutput(fields) {
  extractEls.otherActionsOutput.replaceChildren();
  for (const [label, value] of fields) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    extractEls.otherActionsOutput.append(dt, dd);
  }
}

extractEls.getPageMetadata.addEventListener("click", async () => {
  try {
    const { result, markers, telemetry } = await browser.runtime.sendMessage({
      type: "pageExtractorDebug:getPageMetadata",
      tabId,
    });
    renderOtherActionsOutput([
      [
        "Structured data types",
        result.structuredDataTypes.length
          ? result.structuredDataTypes.join(", ")
          : "None found",
      ],
      ["Word count", result.wordCount.toLocaleString()],
      ["Language", result.language || "Not detected"],
      ["Readerable", result.isReaderable ? "Yes" : "No"],
    ]);
    renderPerfData(markers, telemetry, extractEls.otherActionsPerf);
  } catch (error) {
    renderOtherActionsOutput([["Error", error.message ?? String(error)]]);
  }
});

extractEls.waitForPageReady.addEventListener("click", async () => {
  const start = performance.now();
  try {
    const {
      result: status,
      markers,
      telemetry,
    } = await browser.runtime.sendMessage({
      type: "pageExtractorDebug:waitForPageReady",
      tabId,
    });
    const took = Math.round(performance.now() - start);
    renderOtherActionsOutput([
      ["Status", status],
      ["Took", `${took}ms`],
    ]);
    renderPerfData(markers, telemetry, extractEls.otherActionsPerf);
  } catch (error) {
    renderOtherActionsOutput([["Error", error.message ?? String(error)]]);
  }
});

extractEls.headlessExtract.addEventListener("click", async () => {
  const urlString = extractEls.headlessUrl.value.trim();
  if (!urlString) {
    extractEls.headlessUrl.focus();
    return;
  }

  // Reuse the same GetTextOptions fields as the tab-based Extract button
  // (removeBoilerplate, sufficientLength, canvas options, etc); sourceUrl
  // comes from the headless URL instead of the inspected tab, and the
  // debug-layout options are meaningless with no visible browser to draw on.
  const options = collectOptions();
  delete options._debugLayout;
  delete options._debugLayoutKinds;
  options.sourceUrl = urlString;

  extractEls.headlessOutput.replaceChildren(document.createElement("p"));
  extractEls.headlessOutput.firstChild.textContent = "Loading headlessly…";

  try {
    const { result, markers, telemetry } = await browser.runtime.sendMessage({
      type: "pageExtractorDebug:getHeadlessText",
      urlString,
      options,
      anonymousFetch: extractEls.headlessAnonymousFetch.checked,
    });
    renderExtractOutput(result, options, {
      target: extractEls.headlessOutput,
      showBoxLegend: false,
    });
    renderPerfData(markers, telemetry, extractEls.headlessOutputPerf);
  } catch (error) {
    const p = document.createElement("p");
    const mark = document.createElement("mark");
    mark.textContent = error.message ?? String(error);
    p.append(mark);
    extractEls.headlessOutput.replaceChildren(p);
  }
});

function makeCopyButton(getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(getText());
    button.textContent = "Copied!";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
  return button;
}

// target/showBoxLegend let the headless-load handler below reuse this for
// its own output area, where there's no live page to draw boxes on.
function renderExtractOutput(
  result,
  options,
  { target = extractEls.output, showBoxLegend = true } = {}
) {
  target.replaceChildren();
  if (!result) {
    const p = document.createElement("p");
    p.textContent = "getText() returned null (e.g. page not extractable).";
    target.append(p);
    return;
  }

  if (options._debugLayout && result.strategy === "reader") {
    const note = document.createElement("p");
    const mark = document.createElement("mark");
    mark.textContent =
      "No debug boxes: removeBoilerplate used reader mode here, which " +
      "extracts from a reconstructed document rather than the live page, " +
      "so there are no rendered elements left to box.";
    note.append(mark);
    target.append(note);
  }

  if (showBoxLegend) {
    const legend = document.createElement("p");
    legend.textContent = "text block · canvas · link";
    target.append(legend);
  }

  const textHeading = document.createElement("h3");
  textHeading.textContent = `Text (${result.text.length} chars) `;
  textHeading.append(makeCopyButton(() => result.text));
  const textArea = document.createElement("textarea");
  textArea.readOnly = true;
  textArea.rows = 15;
  textArea.cols = 80;
  textArea.value = result.text;
  target.append(textHeading, textArea);

  const linksHeading = document.createElement("h3");
  linksHeading.textContent = `Links (${result.links.length}) `;
  linksHeading.append(makeCopyButton(() => result.links.join("\n")));
  target.append(linksHeading);
  const linksList = document.createElement("ol");
  for (const href of result.links) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = href;
    li.append(a);
    linksList.append(li);
  }
  target.append(linksList);

  if (result.canvasSnapshots?.length) {
    const canvasHeading = document.createElement("h3");
    canvasHeading.textContent = `Canvas snapshots (${result.canvasSnapshots.length})`;
    target.append(canvasHeading);
    for (const snapshot of result.canvasSnapshots) {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = snapshot.dataUrl;
      img.width = 160;
      img.alt = `${snapshot.width}×${snapshot.height} canvas snapshot`;
      const caption = document.createElement("figcaption");
      caption.textContent = `${snapshot.width}×${snapshot.height}`;
      figure.append(img, caption);
      target.append(figure);
    }
  }
}

// Fields shown in a marker row's "Details" cell, beyond what already gets
// its own column (process/status/phase/duration) or isn't useful here
// (type/phaseLabel/flowId/color/options — options is the same for every
// marker in one call, already visible in the form above).
const MARKER_DETAIL_KEYS = [
  "strategy",
  "siteStrategy",
  "host",
  "textLength",
  "linkCount",
  "canvasCount",
  "errorName",
];

// Gecko's ten marker colors (mozglue/baseprofiler/public/
// BaseProfilerMarkersPrerequisites.h), matching the `color` PHASES assigns
// each phase in PageExtractorEvents.sys.mjs, so a phase reads the same color
// here as it would in a real captured profile.
const PHASE_COLORS = {
  blue: "#0060df",
  green: "#12bc00",
  grey: "#8f8f9d",
  ink: "#1d1133",
  magenta: "#b5007f",
  orange: "#d76e00",
  purple: "#7542e5",
  red: "#d70022",
  teal: "#00b3a4",
  yellow: "#d7b600",
};

// Markers from one getText()/waitForPageReady()/etc. call share a flowId
// across both processes (see PageExtractorEvents.sys.mjs's PageExtractorEvent
// constructor); grouping by it is what turns a flat list into "here's
// everything one call did, parent and content together".
function groupMarkersByFlow(markers) {
  const byFlow = new Map();
  for (const marker of markers) {
    const flowId = marker.flowId ?? "";
    if (!byFlow.has(flowId)) {
      byFlow.set(flowId, []);
    }
    byFlow.get(flowId).push(marker);
  }
  return [...byFlow.entries()]
    .map(([flowId, flowMarkers]) => ({
      flowId,
      markers: flowMarkers.sort((a, b) => a.startTime - b.startTime),
    }))
    .sort((a, b) => a.markers[0].startTime - b.markers[0].startTime);
}

function renderMarkerRow(marker, flowSpanMs) {
  const row = document.createElement("div");
  row.className = "perf-marker-row";

  const process = document.createElement("span");
  const isParent = marker.process === "parent";
  process.className = `perf-process perf-process-${isParent ? "parent" : "content"}`;
  process.textContent = marker.process ?? "?";
  row.append(process);

  const status = document.createElement("span");
  status.textContent = marker.status ?? "";
  status.className = marker.status === "error" ? "perf-status-error" : "";
  row.append(status);

  const phase = document.createElement("span");
  phase.className = "perf-phase";
  phase.title = marker.phaseLabel ?? "";
  const swatch = document.createElement("span");
  swatch.className = "perf-swatch";
  swatch.style.background = PHASE_COLORS[marker.color] ?? "#999";
  phase.append(swatch, document.createTextNode(marker.phase ?? ""));
  row.append(phase);

  const durationCell = document.createElement("span");
  durationCell.style.display = "flex";
  durationCell.style.alignItems = "center";
  durationCell.style.gap = "4px";
  const barTrack = document.createElement("span");
  barTrack.className = "perf-bar-track";
  barTrack.style.flex = "1";
  if (marker.durationMs != null && flowSpanMs > 0) {
    const fill = document.createElement("span");
    fill.className = "perf-bar-fill";
    fill.style.width = `${Math.min(100, (marker.durationMs / flowSpanMs) * 100)}%`;
    fill.style.background = PHASE_COLORS[marker.color] ?? "#999";
    barTrack.append(fill);
  }
  const durationLabel = document.createElement("span");
  durationLabel.textContent =
    marker.durationMs != null ? `${marker.durationMs}ms` : "—";
  durationCell.append(barTrack, durationLabel);
  row.append(durationCell);

  const details = document.createElement("span");
  const detailText = MARKER_DETAIL_KEYS.filter(key => marker[key] !== undefined)
    .map(key => `${key}=${marker[key]}`)
    .join(", ");
  details.className = "perf-details";
  details.textContent = detailText;
  details.title = detailText;
  row.append(details);

  return row;
}

function renderMarkerFlow(flow) {
  const container = document.createElement("div");
  container.className = "perf-flow";

  const flowStart = flow.markers[0].startTime;
  const flowEnd = Math.max(
    ...flow.markers.map(m => m.startTime + (m.durationMs ?? 0))
  );
  const flowSpanMs = flowEnd - flowStart;
  const parentCount = flow.markers.filter(m => m.process === "parent").length;
  const contentCount = flow.markers.length - parentCount;

  const header = document.createElement("div");
  header.className = "perf-flow-header";
  header.textContent =
    `Flow ${flow.flowId ? flow.flowId.slice(0, 8) : "(none)"} — ` +
    `${parentCount} parent, ${contentCount} content, ` +
    `${Math.round(flowSpanMs)}ms span`;
  container.append(header);

  for (const marker of flow.markers) {
    container.append(renderMarkerRow(marker, flowSpanMs));
  }
  return container;
}

// flow_id/status/duration_ms/error_type get their own columns; the rest
// (site_strategy, text_length, and get_text's ~10 option extras) are
// phase-specific, so they're joined into one cell instead of one column each.
const TELEMETRY_OWN_COLUMN_KEYS = [
  "flow_id",
  "status",
  "duration_ms",
  "error_type",
];

function renderTelemetryTable(telemetry) {
  const table = document.createElement("table");
  table.className = "perf-table";
  const headerRow = document.createElement("tr");
  for (const label of ["Event", "Flow", "Status", "Duration", "Extras"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.append(th);
  }
  table.append(headerRow);

  for (const record of telemetry) {
    const extra = record.extra ?? {};
    const otherExtras = Object.entries(extra)
      .filter(([key]) => !TELEMETRY_OWN_COLUMN_KEYS.includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    const row = document.createElement("tr");
    for (const value of [
      record.name,
      extra.flow_id ? extra.flow_id.slice(0, 8) : "",
      extra.error_type ? `error (${extra.error_type})` : (extra.status ?? ""),
      extra.duration_ms != null ? `${extra.duration_ms}ms` : "",
      otherExtras,
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    table.append(row);
  }
  return table;
}

// Shows the real "PageExtractor" profiler markers (grouped by flow, parent
// and content process together) and Glean telemetry events this call
// produced — the same data a captured profile or a Redash query would show,
// surfaced here instead so there's no separate profiler recording step to
// demonstrate performance behavior (see withPerfData() in the experiment
// API, which captures this via the real Firefox Profiler and Glean's
// testGetValue(), not anything PageExtractor-specific).
function renderPerfData(markers, telemetry, target) {
  target.replaceChildren();
  if (!markers?.length && !telemetry?.length) {
    return;
  }

  const heading = document.createElement("h3");
  heading.textContent = "Performance";
  target.append(heading);

  if (markers?.length) {
    const markersHeading = document.createElement("h4");
    markersHeading.textContent = `Profiler markers (${markers.length})`;
    target.append(markersHeading);
    for (const flow of groupMarkersByFlow(markers)) {
      target.append(renderMarkerFlow(flow));
    }
  }

  const telemetryHeading = document.createElement("h4");
  telemetryHeading.textContent = `Recorded telemetry (${telemetry?.length ?? 0})`;
  target.append(telemetryHeading);
  if (telemetry?.length) {
    target.append(renderTelemetryTable(telemetry));
  } else {
    const note = document.createElement("p");
    note.textContent =
      "None recorded (Glean testGetValue() found nothing new, or is unavailable in this context).";
    target.append(note);
  }
}
