"use strict";

var { ExtensionError } = ExtensionUtils;

var { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);

// The four PageExtractor Glean event metrics (see metrics.yaml). Listed here
// once so withPerfData() can diff each one's testGetValue() before/after a
// call to pick out just the records that call produced, without needing a
// flowId (getPageMetadata()/waitForPageReady() don't take one).
const TELEMETRY_METRICS = [
  ["wait_for_ready", () => Glean.pageextractorExtraction.waitForReady],
  ["get_page_metadata", () => Glean.pageextractorExtraction.getPageMetadata],
  ["get_text", () => Glean.pageextractorExtraction.getText],
  ["headless_extractor", () => Glean.pageextractorExtraction.headlessExtractor],
];

// testGetValue() is a real, always-available WebIDL method (see
// dom/webidl/GleanMetrics.webidl) — not gated to automation — but this tool
// still treats it as best-effort: FOG being uninitialized, or a metric
// missing entirely, should degrade to "no telemetry shown", never break the
// actual extraction the panel is trying to demonstrate.
function testGetTelemetry(metric) {
  try {
    return metric().testGetValue() ?? [];
  } catch {
    return [];
  }
}

function snapshotTelemetryCounts() {
  return TELEMETRY_METRICS.map(([, metric]) => testGetTelemetry(metric).length);
}

function collectNewTelemetry(beforeCounts) {
  const events = [];
  TELEMETRY_METRICS.forEach(([name, metric], i) => {
    for (const record of testGetTelemetry(metric).slice(beforeCounts[i])) {
      events.push({ name, ...record });
    }
  });
  return events;
}

// Applies a profiler thread's marker schema to its raw marker tuples, the
// same shape ProfilerTestUtils.getInflatedMarkerData() produces (that module
// lives under resource://testing-common/, which isn't registered outside the
// test harness, so this tool can't import it and re-does the same thing).
function inflateMarkers(thread) {
  const { markers, stringTable } = thread;
  return markers.data.map(tuple => {
    const marker = {};
    for (const [key, index] of Object.entries(markers.schema)) {
      marker[key] = tuple[index];
    }
    if (typeof marker.name === "number" && stringTable) {
      marker.name = stringTable[marker.name];
    }
    return marker;
  });
}

// Recurses into profile.processes the same way
// ProfilerTestUtils.getPayloadsOfTypeFromAllThreads() does, since a getText()
// call's markers are split across the parent and content processes.
function collectPageExtractorMarkers(profile, target = []) {
  for (const thread of profile.threads ?? []) {
    for (const marker of inflateMarkers(thread)) {
      if (marker.data?.type !== "PageExtractor") {
        continue;
      }
      const { data, startTime, endTime } = marker;
      target.push({
        ...data,
        startTime,
        durationMs:
          typeof endTime === "number" && typeof startTime === "number"
            ? Math.round(endTime - startTime)
            : null,
      });
    }
  }
  for (const subProcess of profile.processes ?? []) {
    collectPageExtractorMarkers(subProcess, target);
  }
  return target;
}

// Wraps a PageExtractorParent call with the real Firefox Profiler so its
// "PageExtractor" markers, and the Glean telemetry events it records, can be
// shown back in the panel — reusing the same instrumentation real callers
// already produce rather than adding any tooling to PageExtractor itself.
// If the profiler is already recording (e.g. the user has their own
// about:profiling session going), this leaves it running and just takes a
// snapshot, rather than stopping someone else's capture.
async function withPerfData(run) {
  const wasAlreadyRecording = Services.profiler.IsActive();
  if (!wasAlreadyRecording) {
    await Services.profiler.StartProfiler(
      8 * 1024 * 1024, // entries
      1, // interval (ms); no sampling needed, only markers matter here
      ["nostacksampling", "js"],
      ["GeckoMain", "DOM Worker"]
    );
  }
  const beforeCounts = snapshotTelemetryCounts();

  let result;
  let callError;
  try {
    result = await run();
  } catch (error) {
    callError = error;
  }

  let markers = [];
  try {
    if (!wasAlreadyRecording) {
      Services.profiler.Pause();
    }
    const buffer = await Services.profiler.getProfileDataAsArrayBuffer();
    const profile = JSON.parse(
      new TextDecoder("utf-8").decode(new Uint8Array(buffer))
    );
    markers = collectPageExtractorMarkers(profile);
  } catch {
    // Perf data is a debugging nicety; a capture failure here should never
    // mask the real result/error from the call itself.
  } finally {
    if (!wasAlreadyRecording) {
      await Services.profiler.StopProfiler();
    }
  }

  const telemetry = collectNewTelemetry(beforeCounts);
  if (callError) {
    throw Object.assign(callError, {
      pageExtractorMarkers: markers,
      pageExtractorTelemetry: telemetry,
    });
  }
  return { result, markers, telemetry };
}

this.pageExtractorDebug = class extends ExtensionAPI {
  getAPI(context) {
    function getActor(tabId) {
      const tab = context.extension.tabManager.get(tabId);
      const windowGlobal = tab.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        throw new ExtensionError(`Tab ${tabId} has no content window.`);
      }
      return windowGlobal.getActor("PageExtractor");
    }

    // Canvas snapshots cross the actor boundary as Blobs, which aren't a
    // useful shape for a devtools panel page to render directly; a data URL
    // can go straight into an <img src>.
    function blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    // Shared by getText() and getHeadlessText(): both return the same
    // ExtractionResult shape, with canvasSnapshots' Blobs swapped for data
    // URLs before crossing into the panel page.
    async function withDataUrlCanvases(result) {
      if (!result) {
        return null;
      }
      const canvasSnapshots = await Promise.all(
        (result.canvasSnapshots ?? []).map(async snapshot => ({
          dataUrl: await blobToDataURL(snapshot.blob),
          width: snapshot.width,
          height: snapshot.height,
        }))
      );
      return { ...result, canvasSnapshots };
    }

    return {
      pageExtractorDebug: {
        async getText(tabId, options) {
          const { result, markers, telemetry } = await withPerfData(() =>
            getActor(tabId).getText(options)
          );
          return {
            result: await withDataUrlCanvases(result),
            markers,
            telemetry,
          };
        },

        async getPageMetadata(tabId) {
          return withPerfData(() => getActor(tabId).getPageMetadata());
        },

        async waitForPageReady(tabId) {
          return withPerfData(() => getActor(tabId).waitForPageReady());
        },

        async clearDebugOverlay(tabId) {
          return getActor(tabId).clearDebugOverlay();
        },

        async getHoveredDebugBlock(tabId) {
          return getActor(tabId).getHoveredDebugBlock();
        },

        // Independent of any open tab: loads urlString in a hidden
        // background browser the same way PageExtractorParent.getText()'s
        // real callers do (e.g. run_search's anonymous SERP fetches), then
        // extracts from it. _debugLayout is meaningless here — there's no
        // visible browser to draw an overlay on.
        async getHeadlessText(urlString, options, anonymousFetch) {
          const { result, markers, telemetry } = await withPerfData(() =>
            PageExtractorParent.getHeadlessExtractor({
              urlString,
              anonymousFetch,
              callback: (actor, flowId) => actor.getText(options, flowId),
            })
          );
          return {
            result: await withDataUrlCanvases(result),
            markers,
            telemetry,
          };
        },
      },
    };
  }
};
