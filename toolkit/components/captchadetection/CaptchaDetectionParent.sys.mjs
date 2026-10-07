/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** @type {lazy} */
const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "console", () => {
  return console.createInstance({
    prefix: "CaptchaDetectionParent",
    maxLogLevelPref: "captchadetection.loglevel",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  BLOCKING_CAPTCHA_EVENTS:
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs",
  CAPTCHA_EVENT_LABELS:
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs",
  CAPTCHA_PROVIDER_NAMES:
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs",
  CaptchaDetectionPingUtils:
    "moz-src:///toolkit/components/captchadetection/CaptchaDetectionPingUtils.sys.mjs",
  CaptchaResponseObserver:
    "moz-src:///toolkit/components/captchadetection/CaptchaResponseObserver.sys.mjs",
  HiddenFrame: "resource://gre/modules/HiddenFrame.sys.mjs",
});

/**
 * Holds the state of captchas for each top document.
 * Currently, only used by google reCAPTCHA v2 and hCaptcha.
 * The state is an object with the following structure:
 * [key: topBrowsingContextId]: typeof ReturnType<TopDocState.#defaultValue()>
 */
class DocCaptchaState {
  #state;

  constructor() {
    this.#state = new Map();
  }

  /**
   * @param {number} topId - The top bc id.
   * @returns {Map<any, any>} - The state of the top bc.
   */
  get(topId) {
    return this.#state.get(topId);
  }

  static #defaultValue() {
    return new Map();
  }

  /**
   * @param {number} topId - The top bc id.
   * @param {(state: ReturnType<DocCaptchaState['get']>) => void} updateFunction - The function to update the state.
   */
  update(topId, updateFunction) {
    if (!this.#state.has(topId)) {
      this.#state.set(topId, DocCaptchaState.#defaultValue());
    }
    updateFunction(this.#state.get(topId));
  }

  /**
   * @param {number} topId - The top doc id.
   */
  clear(topId) {
    this.#state.delete(topId);
  }
}

const docState = new DocCaptchaState();

/**
 * Notified for every captcha state change, so a feature can react to a
 * captcha in a page it loaded. The subject is the <browser> showing the
 * page; the data is a JSON `CaptchaDetectionUpdate`.
 */
export const CAPTCHA_DETECTION_UPDATE_TOPIC = "captcha-detection-update";

/**
 * @typedef CaptchaDetectionUpdate
 * @type {object}
 * @property {string} type - The captcha provider, e.g. "cf-turnstile".
 * @property {"shown"|"challenge"|"blocked"|"failed"|"passed"} event -
 *   "shown" means the widget loaded, which on its own is not evidence that
 *   anything is gated behind it. "challenge" means a puzzle was presented,
 *   "blocked" that the provider refused the visitor outright, and "failed"
 *   or "passed" the verdict of a check.
 */

/** @type {boolean} */
let markerSchemaRegistered = false;

/**
 * @param {{captchaType: string, event: string, hiddenBrowser: string}} data
 * @param {number} innerWindowId - The top window the captcha is in, so the
 *   marker lands on that page's track.
 */
function addCaptchaMarker(data, innerWindowId) {
  if (!markerSchemaRegistered) {
    markerSchemaRegistered = true;
    ChromeUtils.registerMarkerSchema({
      name: "CaptchaDetection",
      tooltipLabel:
        "Captcha from {marker.data.provider} ({marker.data.eventLabel})",
      tableLabel:
        "Captcha from {marker.data.provider} ({marker.data.eventLabel})",
      chartLabel: "{marker.data.provider} ({marker.data.eventLabel})",
      display: ["marker-chart", "marker-table"],
      colorField: "color",
      data: [
        {
          key: "provider",
          label: "Provider",
          format: "string",
          searchable: true,
        },
        {
          key: "eventLabel",
          label: "What happened",
          format: "string",
          searchable: true,
        },
        {
          key: "captchaType",
          label: "Provider id",
          format: "string",
          searchable: true,
        },
        { key: "event", label: "Event", format: "string", searchable: true },
        { key: "hiddenBrowser", label: "Hidden browser", format: "string" },
        { key: "color", hidden: true },
      ],
    });
  }
  ChromeUtils.addProfilerMarker(
    "CaptchaDetection",
    { category: "JavaScript", innerWindowId },
    {
      type: "CaptchaDetection",
      ...data,
      provider: lazy.CAPTCHA_PROVIDER_NAMES.get(data.captchaType),
      eventLabel: lazy.CAPTCHA_EVENT_LABELS.get(data.event),
      // A check that went against the visitor is drawn like any other
      // outcome a caller handles, the rest like a success.
      color: lazy.BLOCKING_CAPTCHA_EVENTS.has(data.event) ? "yellow" : "blue",
    }
  );
}

/** @type {Map<string, CaptchaDetectionUpdate["event"]>} */
const RECAPTCHA_UPDATE_EVENTS = new Map([
  ["ImagesShown", "challenge"],
  ["GotCheckmark", "passed"],
]);

/** @type {Map<string, CaptchaDetectionUpdate["event"]>} */
const HCAPTCHA_UPDATE_EVENTS = new Map([
  ["shown", "challenge"],
  ["passed", "passed"],
]);

/**
 * Maps a provider-specific "CaptchaState:Update" message to the shared
 * `CaptchaDetectionUpdate` event vocabulary.
 *
 * @param {object} data - The message data.
 * @returns {CaptchaDetectionUpdate["event"] | null}
 */
function toUpdateEvent(data) {
  switch (data.type) {
    case "g-recaptcha-v2":
      return RECAPTCHA_UPDATE_EVENTS.get(data.changes) ?? null;
    case "cf-turnstile":
      return data.result === "Succeeded" ? "passed" : "failed";
    case "datadome":
      if (data.event === "passed") {
        return "passed";
      }
      if (data.blocked) {
        return "blocked";
      }
      return data.captchaShown ? "challenge" : null;
    case "hCaptcha":
      return HCAPTCHA_UPDATE_EVENTS.get(data.changes) ?? null;
  }
  return null;
}

/**
 * This actor parent is responsible for recording the state of captchas
 * or communicating with parent browsing context.
 */
class CaptchaDetectionParent extends JSWindowActorParent {
  #responseObserver;
  /** @type {?boolean} */
  #hiddenBrowser = null;

  actorCreated() {
    lazy.console.debug("actorCreated");
  }

  actorDestroy() {
    lazy.console.debug("actorDestroy()");

    this.#onPageHidden();
  }

  /** @type {CaptchaStateUpdateFunction} */
  #updateGRecaptchaV2State({ changes, type }) {
    lazy.console.debug("updateGRecaptchaV2State", changes);

    const topId = this.#topInnerWindowId;
    const isPBM = this.browsingContext.usePrivateBrowsing;

    if (changes === "ImagesShown") {
      docState.update(topId, state => {
        state.set(type + changes, true);
      });

      // We don't call maybeSubmitPing here because we might end up
      // submitting the ping without the "GotCheckmark" event.
      // maybeSubmitPing will be called when "GotCheckmark" event is
      // received, or when the daily maybeSubmitPing is called.
      const shownMetric = "googleRecaptchaV2Ps" + (isPBM ? "Pbm" : "");
      Glean.captchaDetection[shownMetric].add(1);
    } else if (changes === "GotCheckmark") {
      const autoCompleted = !docState.get(topId)?.has(type + "ImagesShown");
      const resultMetric =
        "googleRecaptchaV2" +
        (autoCompleted ? "Ac" : "Pc") +
        (isPBM ? "Pbm" : "");
      Glean.captchaDetection[resultMetric].add(1);
      lazy.console.debug("Incremented metric", resultMetric);
      docState.clear(topId);
      this.#onMetricSet();
    }
  }

  /** @type {CaptchaStateUpdateFunction} */
  #recordCFTurnstileResult({ result }) {
    lazy.console.debug("recordCFTurnstileResult", result);

    const isPBM = this.browsingContext.usePrivateBrowsing;
    const resultMetric =
      "cloudflareTurnstile" +
      (result === "Succeeded" ? "Cc" : "Cf") +
      (isPBM ? "Pbm" : "");
    Glean.captchaDetection[resultMetric].add(1);
    lazy.console.debug("Incremented metric", resultMetric);
    this.#onMetricSet();
  }

  async #datadomeInit() {
    const parent = this.browsingContext.parentWindowContext;
    if (!parent) {
      lazy.console.error("Datadome captcha loaded in a top-level window?");
      return;
    }

    let actor = null;
    try {
      actor = parent.getActor("CaptchaDetectionCommunication");
      if (!actor) {
        lazy.console.error("CaptchaDetection actor not found in parent window");
        return;
      }
    } catch (e) {
      lazy.console.error("Error getting actor", e);
      return;
    }

    await actor.sendQuery("Datadome:AddMessageListener");
  }

  /** @type {CaptchaStateUpdateFunction} */
  #recordDatadomeEvent({ event, ...payload }) {
    lazy.console.debug("recordDatadomeEvent", { event, payload });

    const suffix = this.browsingContext.usePrivateBrowsing ? "Pbm" : "";
    let metricName = "datadome";
    if (event === "load") {
      if (payload.captchaShown) {
        metricName += "Ps";
      } else if (payload.blocked) {
        metricName += "Bl";
      }
    } else if (event === "passed") {
      metricName += "Pc";
    } else {
      lazy.console.error("Unknown Datadome event", event);
      return;
    }

    metricName += suffix;
    Glean.captchaDetection[metricName].add(1);
    lazy.console.debug("Incremented metric", metricName);

    this.#onMetricSet(0);
  }

  /** @type {CaptchaStateUpdateFunction} */
  #recordHCaptchaState({ changes, type }) {
    lazy.console.debug("recordHCaptchaEvent", changes);

    const topId = this.#topInnerWindowId;
    const isPBM = this.browsingContext.usePrivateBrowsing;

    if (changes === "shown") {
      // I don't think HCaptcha supports auto-completion, but we act
      // as if it does just in case.
      docState.update(topId, state => {
        state.set(type + changes, true);
      });

      // We don't call maybeSubmitPing here because we might end up
      // submitting the ping without the "passed" event.
      // maybeSubmitPing will be called when "passed" event is
      // received, or when the daily maybeSubmitPing is called.
      const shownMetric = "hcaptchaPs" + (isPBM ? "Pbm" : "");
      Glean.captchaDetection[shownMetric].add(1);
      lazy.console.debug("Incremented metric", shownMetric);
    } else if (changes === "passed") {
      const autoCompleted = !docState.get(topId)?.has(type + "shown");
      const resultMetric =
        "hcaptcha" + (autoCompleted ? "Ac" : "Pc") + (isPBM ? "Pbm" : "");
      Glean.captchaDetection[resultMetric].add(1);
      lazy.console.debug("Incremented metric", resultMetric);
      docState.clear(topId);
      this.#onMetricSet();
    }
  }

  /** @type {CaptchaStateUpdateFunction} */
  #recordArkoseLabsEvent({ event, solved, solutionsSubmitted }) {
    lazy.console.debug("recordArkoseLabsEvent", {
      event,
      solved,
      solutionsSubmitted,
    });

    this.#notifyUpdate("arkoseLabs", solved ? "passed" : "failed");
    if (this.#inHiddenBrowser) {
      return;
    }

    const isPBM = this.browsingContext.usePrivateBrowsing;

    const suffix = isPBM ? "Pbm" : "";
    const resultMetric = "arkoselabs" + (solved ? "Pc" : "Pf") + suffix;
    Glean.captchaDetection[resultMetric].add(1);
    lazy.console.debug("Incremented metric", resultMetric);

    const metricName = "arkoselabsSolutionsRequired" + suffix;
    Glean.captchaDetection[metricName].accumulateSingleSample(
      solutionsSubmitted
    );
    lazy.console.debug("Sampled", metricName, "with", solutionsSubmitted);

    this.#onMetricSet();
  }

  async #arkoseLabsInit() {
    let solutionsSubmitted = 0;
    this.#responseObserver = new lazy.CaptchaResponseObserver(
      channel =>
        channel.loadInfo?.browsingContextID === this.browsingContext.id &&
        channel.URI &&
        (Cu.isInAutomation
          ? channel.URI.filePath.endsWith("arkose_labs_api.sjs")
          : channel.URI.spec === "https://client-api.arkoselabs.com/fc/ca/"),
      (_channel, statusCode, responseBody) => {
        if (statusCode !== Cr.NS_OK) {
          return;
        }

        let body;
        try {
          body = JSON.parse(responseBody);
          if (!body) {
            lazy.console.debug(
              "ResponseObserver:ResponseBody",
              "Failed to parse JSON"
            );
            return;
          }
        } catch (e) {
          lazy.console.debug(
            "ResponseObserver:ResponseBody",
            "Failed to parse JSON",
            e,
            responseBody
          );
          return;
        }

        // Check for the presence of the expected keys
        if (["response", "solved"].some(key => !body.hasOwnProperty(key))) {
          lazy.console.debug(
            "ResponseObserver:ResponseBody",
            "Missing keys",
            body
          );
          return;
        }

        solutionsSubmitted++;
        if (typeof body.solved !== "boolean") {
          return;
        }

        this.#recordArkoseLabsEvent({
          event: "completed",
          solved: body.solved,
          solutionsSubmitted,
        });

        solutionsSubmitted = 0;
      }
    );
    this.#responseObserver.register();
  }

  /**
   * A hidden browser loads pages on Firefox's behalf rather than the user's,
   * so its captchas stay out of the captcha-detection ping, which measures
   * what users run into.
   */
  get #inHiddenBrowser() {
    this.#hiddenBrowser ??= lazy.HiddenFrame.isHiddenDocument(
      this.browsingContext.top.embedderElement?.ownerDocument
    );
    return this.#hiddenBrowser;
  }

  /**
   * @param {string} type
   * @param {CaptchaDetectionUpdate["event"] | null} event
   */
  #notifyUpdate(type, event) {
    if (!event) {
      return;
    }
    const hiddenBrowser = this.#inHiddenBrowser;
    if (Services.profiler.IsActive()) {
      addCaptchaMarker(
        { captchaType: type, event, hiddenBrowser: String(hiddenBrowser) },
        this.#topInnerWindowId
      );
    }
    Services.obs.notifyObservers(
      this.browsingContext.top.embedderElement,
      CAPTCHA_DETECTION_UPDATE_TOPIC,
      JSON.stringify({ type, event })
    );
  }

  get #topInnerWindowId() {
    return this.browsingContext.topWindowContext.innerWindowId;
  }

  #onPageHidden() {
    docState.clear(this.#topInnerWindowId);

    if (this.#responseObserver) {
      this.#responseObserver.unregister();
    }
  }

  async #onMetricSet(parentDepth = 1) {
    lazy.CaptchaDetectionPingUtils.maybeSubmitPing();
    if (Cu.isInAutomation) {
      await this.#notifyTestMetricIsSet(parentDepth);
    }
  }

  /**
   * Notify the `parentDepth`'nth parent browsing context that the test metric is set.
   *
   * @param {number} parentDepth - The depth of the parent window context.
   * The reason we need this param is because Datadome calls this method
   * not from the captcha iframe, but its parent browsing context. So
   * it overrides the depth to 0.
   */
  async #notifyTestMetricIsSet(parentDepth = 1) {
    if (!Cu.isInAutomation) {
      throw new Error("This method should only be called in automation");
    }

    let parent = this.browsingContext.currentWindowContext;
    for (let i = 0; i < parentDepth; i++) {
      parent = parent.parentWindowContext;
      if (!parent) {
        lazy.console.error("No parent window context");
        return;
      }
    }

    let actor = null;
    try {
      actor = parent.getActor("CaptchaDetectionCommunication");
      if (!actor) {
        lazy.console.error("CaptchaDetection actor not found in parent window");
        return;
      }
    } catch (e) {
      lazy.console.error("Error getting actor", e);
      return;
    }

    await actor.sendQuery("Testing:MetricIsSet");
  }

  recordCaptchaHandlerConstructed({ type }) {
    lazy.console.debug("recordCaptchaHandlerConstructed", type);

    let metric = "";
    switch (type) {
      case "g-recaptcha-v2":
        metric = "googleRecaptchaV2Oc";
        break;
      case "cf-turnstile":
        metric = "cloudflareTurnstileOc";
        break;
      case "datadome":
        metric = "datadomeOc";
        break;
      case "hCaptcha":
        metric = "hcaptchaOc";
        break;
      case "arkoseLabs":
        metric = "arkoselabsOc";
        break;
    }
    metric += this.browsingContext.usePrivateBrowsing ? "Pbm" : "";
    Glean.captchaDetection[metric].add(1);
    lazy.console.debug("Incremented metric", metric);
  }

  async receiveMessage(message) {
    lazy.console.debug("receiveMessage", message);

    switch (message.name) {
      case "CaptchaState:Update":
        this.#notifyUpdate(message.data.type, toUpdateEvent(message.data));
        if (this.#inHiddenBrowser) {
          break;
        }
        switch (message.data.type) {
          case "g-recaptcha-v2":
            this.#updateGRecaptchaV2State(message.data);
            break;
          case "cf-turnstile":
            this.#recordCFTurnstileResult(message.data);
            break;
          case "datadome":
            this.#recordDatadomeEvent(message.data);
            break;
          case "hCaptcha":
            this.#recordHCaptchaState(message.data);
            break;
        }
        break;
      case "CaptchaHandler:Constructed":
        // message.name === "CaptchaHandler:Constructed"
        // => message.data = {
        //   type: string,
        // }
        this.#notifyUpdate(message.data.type, "shown");
        if (this.#inHiddenBrowser) {
          break;
        }
        this.recordCaptchaHandlerConstructed(message.data);
        break;
      case "Page:Hide":
        // message.name === "TabState:Closed"
        // => message.data = undefined
        this.#onPageHidden();
        break;
      case "CaptchaDetection:Init":
        // message.name === "CaptchaDetection:Init"
        // => message.data = {
        //   type: string,
        // }
        switch (message.data.type) {
          case "datadome":
            return this.#datadomeInit();
          case "arkoseLabs":
            return this.#arkoseLabsInit();
        }
        break;
      default:
        lazy.console.error("Unknown message", message);
    }
    return null;
  }
}

export {
  CaptchaDetectionParent,
  CaptchaDetectionParent as CaptchaDetectionCommunicationParent,
};

/**
 * @typedef lazy
 * @type {object}
 * @property {ConsoleInstance} console - console instance.
 * @property {typeof import("./CaptchaDetectionPingUtils.sys.mjs").CaptchaDetectionPingUtils} CaptchaDetectionPingUtils - CaptchaDetectionPingUtils module.
 * @property {typeof import("./CaptchaResponseObserver.sys.mjs").CaptchaResponseObserver} CaptchaResponseObserver - CaptchaResponseObserver module.
 */

/**
 * @typedef CaptchaStateUpdateMessageData
 * @type {object}
 * @property {string} type - The type of the captcha.
 *
 * @typedef {(message: CaptchaStateUpdateMessageData) => void} CaptchaStateUpdateFunction
 */
