/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { HiddenFrame } from "resource://gre/modules/HiddenFrame.sys.mjs"
 * @import { GetTextOptions, ExtractionResult, PageMetadata } from './PageExtractor.d.ts'
 * @import { PageExtractorChild } from './PageExtractorChild.sys.mjs'
 * @import { PageExtractorEvent, PageExtractorPhase, TraceId } from './PageExtractorEvents.sys.mjs'
 * @import { CaptchaDetectionUpdate } from "moz-src:///toolkit/components/captchadetection/CaptchaDetectionParent.sys.mjs"
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  BLOCKING_CAPTCHA_EVENTS:
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs",
  CAPTCHA_DETECTION_UPDATE_TOPIC:
    "moz-src:///toolkit/components/captchadetection/CaptchaDetectionParent.sys.mjs",
  findCaptchaFrame:
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs",
  captchaTypeForLoaderScript:
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  HiddenBrowserManager: "resource://gre/modules/HiddenFrame.sys.mjs",
  console: () =>
    console.createInstance({
      prefix: "PageExtractorChild",
      maxLogLevelPref: "browser.ml.logLevel",
    }),
  collapseWhitespace:
    "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs",
  PageExtractorEvent:
    "moz-src:///toolkit/components/pageextractor/PageExtractorEvents.sys.mjs",
  Phase: () => lazy.PageExtractorEvent.Phase,
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  headlessTimeoutMs: {
    pref: "browser.ml.pageExtractor.headlessTimeoutMs",
    default: 15000,
  },
  useCaptchaDetection: {
    pref: "browser.ml.pageExtractor.captchaDetection.enabled",
    default: true,
  },
});

// A read shorter than this, in UTF-16 code units, of a page with a captcha
// widget on it is taken to be the bot check rather than the page.
const CAPTCHA_PAGE_MAX_TEXT_LENGTH = 1000;

// How long a read waits for a captcha widget whose script the page has
// requested to show up, before reading the page without it.
const CAPTCHA_WIDGET_WAIT_MS = 1500;

/**
 * How many anonymous fetches are loading. They share one private container,
 * which is cleared once none are left.
 */
let anonymousFetchCount = 0;

/**
 * Settles once the anonymous fetches' container has been cleared of
 * everything queued for clearing so far. A fetch waits on it before loading,
 * so a clear still running can't wipe a page mid-load.
 *
 * @type {Promise<void> | null}
 */
let anonymousContainerCleared = null;

/**
 * The private container anonymous fetches load in, so the pages read neither
 * the user's cookies and storage nor leave their own in the user's profile.
 *
 * @returns {number}
 */
function getAnonymousUserContextId() {
  const identity = lazy.ContextualIdentityService.getPrivateIdentity(
    "userContextIdInternal.pageExtractor"
  );
  if (!identity) {
    throw new Error("The anonymous fetch container is missing.");
  }
  return identity.userContextId;
}

/**
 * Queues clearing all data in the anonymous fetches' container.
 */
function clearAnonymousContainer() {
  anonymousContainerCleared = (anonymousContainerCleared ?? Promise.resolve())
    .then(
      () =>
        new Promise(resolve =>
          Services.clearData.deleteDataFromOriginAttributesPattern(
            { userContextId: getAnonymousUserContextId() },
            { onDataDeleted: () => resolve() }
          )
        )
    )
    // Every later fetch waits on this, so a failed clear must not fail them.
    .catch(error =>
      lazy.console.error("Could not clear the anonymous fetch container", error)
    );
}

/**
 * Starts a fetch in the anonymous fetches' container, resolving once the
 * container is empty of anything an earlier fetch left. Every call must be
 * matched by leaveAnonymousContainer().
 */
async function enterAnonymousContainer() {
  if (!anonymousContainerCleared) {
    // Clears what a fetch in an earlier session may have left behind.
    clearAnonymousContainer();
  }
  anonymousFetchCount++;
  await anonymousContainerCleared;
}

function leaveAnonymousContainer() {
  if (--anonymousFetchCount === 0) {
    clearAnonymousContainer();
  }
}

/**
 * @typedef {object} BlockDetails
 * @property {"off-site"|"captcha"} blockReason - Whether the load ended up
 *   on another site or a bot check stood in front of the content.
 * @property {string} [captchaType] - The captcha provider, for "captcha".
 * @property {CaptchaDetectionUpdate["event"]} [captchaEvent] - The latest
 *   captcha state seen, for "captcha".
 */

/**
 * A "BlockedError" carrying why the site kept the page from being read, so
 * a caller can explain it without parsing the message.
 *
 * @param {string} message
 * @param {BlockDetails} details
 * @returns {DOMException & BlockDetails}
 */
function blockedError(message, details) {
  return Object.assign(new DOMException(message, "BlockedError"), details);
}

/**
 * @param {CaptchaDetectionUpdate} captcha
 * @returns {BlockDetails}
 */
function captchaBlockDetails(captcha) {
  return {
    blockReason: "captcha",
    captchaType: captcha.type,
    captchaEvent: captcha.event,
  };
}

/**
 * Watches a hidden <browser> for captchas while getHeadlessExtractor loads a
 * page in it, so that a blocking captcha ends the load, and getText can judge
 * whether the text it read is the page or the bot check in front of it.
 */
class HeadlessCaptchaWatcher {
  /** @type {WeakMap<Element, HeadlessCaptchaWatcher>} */
  static #watchers = new WeakMap();

  /**
   * @param {Element} browser
   * @returns {HeadlessCaptchaWatcher | null} The watcher of a hidden browser
   *   getHeadlessExtractor is loading with captcha detection on.
   */
  static forBrowser(browser) {
    return HeadlessCaptchaWatcher.#watchers.get(browser) ?? null;
  }

  /**
   * The latest captcha CaptchaDetection reported in the page.
   *
   * @type {CaptchaDetectionUpdate | null}
   */
  captcha = null;

  /** @type {Element} */
  #browser;
  /** @type {PageExtractorEvent} */
  #loadEvent;
  /** @type {PageExtractorEvent} */
  #detectedEvent;
  /** @type {PromiseWithResolvers<never>} */
  #blocked = Promise.withResolvers();
  /**
   * Set once the page requests a captcha widget's script, and resolved once
   * CaptchaDetection reports a captcha in it.
   *
   * @type {PromiseWithResolvers<void> | null}
   */
  #widgetReported = null;

  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);

  /**
   * @param {Element} browser - The hidden <browser>, before it loads the page.
   * @param {PageExtractorEvent} loadEvent - The load's headless-extractor
   *   event, which records the latest captcha seen.
   */
  constructor(browser, loadEvent) {
    this.#browser = browser;
    this.#loadEvent = loadEvent;
    // Only finished, and so only recorded, if a captcha shows up: its
    // duration is how long into the load that took.
    this.#detectedEvent = new lazy.PageExtractorEvent(
      lazy.Phase.captchaDetected,
      { process: "parent", traceId: loadEvent.traceId }
    );
  }

  /**
   * Rejects with a "BlockedError" once a captcha blocks the page, so that a
   * read in progress stops there.
   *
   * @returns {Promise<never>}
   */
  get blocked() {
    return this.#blocked.promise;
  }

  start() {
    HeadlessCaptchaWatcher.#watchers.set(this.#browser, this);
    Services.obs.addObserver(this, lazy.CAPTCHA_DETECTION_UPDATE_TOPIC);
    Services.obs.addObserver(this, "http-on-modify-request");
  }

  stop() {
    HeadlessCaptchaWatcher.#watchers.delete(this.#browser);
    Services.obs.removeObserver(this, lazy.CAPTCHA_DETECTION_UPDATE_TOPIC);
    Services.obs.removeObserver(this, "http-on-modify-request");
  }

  /**
   * Waits briefly for a captcha widget whose script the page has requested.
   * The script runs and inserts the widget's frame after a fast page can
   * already be read.
   *
   * @param {PageExtractorEvent} readEvent - The read's get-text event, which
   *   records how long it waited.
   */
  async waitForRequestedWidget(readEvent) {
    if (!this.#widgetReported) {
      return;
    }
    const waitStart = ChromeUtils.now();
    let timeoutId;
    try {
      await lazy.PageExtractorEvent.trace(
        lazy.Phase.captchaWait,
        { process: "parent", traceId: readEvent.traceId },
        async waitEvent => {
          const appeared = await Promise.race([
            this.#widgetReported.promise.then(() => true),
            this.blocked,
            new Promise(resolve => {
              timeoutId = lazy.setTimeout(
                () => resolve(false),
                CAPTCHA_WIDGET_WAIT_MS
              );
            }),
          ]);
          waitEvent.finish({ status: appeared ? "appeared" : "gave-up" });
        }
      );
    } finally {
      lazy.clearTimeout(timeoutId);
      readEvent.addData({
        captchaWaitMs: Math.round(ChromeUtils.now() - waitStart),
      });
    }
  }

  /**
   * The captcha a read of `textLength` code units got instead of the page,
   * if any. A captcha frame may not have reported in by the time the read
   * ends, so its URL is checked too.
   *
   * @param {number} textLength
   * @returns {CaptchaDetectionUpdate | null}
   */
  captchaInsteadOfPage(textLength) {
    if (textLength >= CAPTCHA_PAGE_MAX_TEXT_LENGTH) {
      return null;
    }
    let captcha = this.captcha;
    if (!captcha) {
      captcha = lazy.findCaptchaFrame(this.#browser.browsingContext);
      if (captcha) {
        this.#detectedEvent.finish({
          status: "detected",
          captchaType: captcha.type,
          captchaEvent: captcha.event,
          detectedBy: "its frame's URL, when the page was read",
        });
      }
    }
    return captcha?.event === "passed" ? null : captcha;
  }

  /**
   * @param {nsISupports} subject
   * @param {string} topic
   * @param {string} data
   */
  observe(subject, topic, data) {
    if (topic === "http-on-modify-request") {
      this.#onRequest(subject);
    } else if (subject === this.#browser) {
      this.#onCaptchaUpdate(JSON.parse(data));
    }
  }

  /** @param {nsISupports} channel */
  #onRequest(channel) {
    if (
      this.#widgetReported ||
      !(channel instanceof Ci.nsIHttpChannel) ||
      BrowsingContext.get(channel.loadInfo.browsingContextID)?.browserId !==
        this.#browser.browserId
    ) {
      return;
    }
    const type = lazy.captchaTypeForLoaderScript(channel.URI);
    if (!type) {
      return;
    }
    this.#widgetReported = Promise.withResolvers();
    new lazy.PageExtractorEvent(lazy.Phase.captchaScript, {
      process: "parent",
      traceId: this.#loadEvent.traceId,
    }).finish({ status: "requested", captchaType: type });
  }

  /** @param {CaptchaDetectionUpdate} update */
  #onCaptchaUpdate(update) {
    this.#widgetReported?.resolve();
    lazy.console.log("Captcha update in headless page", update);
    // Nobody solves a captcha in a hidden browser, so a presented puzzle or a
    // verdict against us means the content stays out of reach. A widget that
    // merely loaded ("shown") may sit on a form beside readable content.
    const blocking = lazy.BLOCKING_CAPTCHA_EVENTS.has(update.event);
    if (this.captcha) {
      new lazy.PageExtractorEvent(lazy.Phase.captchaChanged, {
        process: "parent",
        traceId: this.#loadEvent.traceId,
      }).finish({
        status: blocking ? "blocked" : "detected",
        blockReason: blocking ? "captcha" : undefined,
        captchaType: update.type,
        captchaEvent: update.event,
      });
    } else {
      this.#detectedEvent.finish({
        status: "detected",
        captchaType: update.type,
        captchaEvent: update.event,
        detectedBy: "its frame reporting in",
      });
    }
    // A second widget loading must not mask a verdict already in.
    if (
      this.captcha &&
      lazy.BLOCKING_CAPTCHA_EVENTS.has(this.captcha.event) &&
      update.event === "shown"
    ) {
      return;
    }
    this.captcha = update;
    this.#loadEvent.addData({
      captchaType: update.type,
      captchaEvent: update.event,
    });
    if (blocking) {
      this.#blocked.reject(
        blockedError(
          `The page is behind a ${update.type} bot check (${update.event}).`,
          captchaBlockDetails(update)
        )
      );
    }
  }
}

// NOTE: Copied from nsSandboxFlags.h.
// Blocks window.open / target="_blank" popups.
const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;
// Blocks the page from navigating its own top to an attacker-controlled URL.
const SANDBOXED_TOPLEVEL_NAVIGATION = 0x4;
// Blocks form submissions.
const SANDBOXED_FORMS = 0x20;
// Blocks the Pointer Lock API.
const SANDBOXED_POINTER_LOCK = 0x40;
// Blocks automatically triggered features such as autoplay, autofocus, and
// auto-form-submission.
const SANDBOXED_AUTOMATIC_FEATURES = 0x100;
// Blocks modal dialogs (alert, confirm, prompt, print, etc).
const SANDBOXED_MODALS = 0x800;
// Blocks the Screen Orientation API from locking orientation.
const SANDBOXED_ORIENTATION_LOCK = 0x2000;
// Blocks the Presentation API.
const SANDBOXED_PRESENTATION = 0x4000;
// Blocks the Storage Access API.
const SANDBOXED_STORAGE_ACCESS = 0x8000;
// Blocks downloads initiated by the page.
const SANDBOXED_DOWNLOADS = 0x10000;

/**
 * Whether a redirect landed on the requested site. A shared name is not
 * enough: the suffix list hands out github.io, so nytimes.github.io would
 * match nytimes.com. On a host with no suffix, each port is its own service.
 *
 * @param {nsIURI} requested
 * @param {nsIURI} location
 * @returns {boolean}
 */
function isSameSite(requested, location) {
  const { eTLD } = Services;
  if (
    !eTLD.hasKnownPublicSuffix(requested) ||
    !eTLD.hasKnownPublicSuffix(location)
  ) {
    return requested.asciiHostPort === location.asciiHostPort;
  }
  return eTLD.getSchemelessSite(requested) === eTLD.getSchemelessSite(location);
}

/**
 * Whether the document a read was bound to has been replaced. A destroyed
 * actor cannot answer for its window global, so a throw means replaced.
 *
 * @param {PageExtractorParent} actor
 * @returns {boolean}
 */
function wasReplaced(actor) {
  try {
    return !actor.manager.isCurrentGlobal;
  } catch {
    return true;
  }
}

/**
 * Extract a variety of content from pages for use in a smart window.
 */
export class PageExtractorParent extends JSWindowActorParent {
  /**
   * Waits for DOMContentLoaded.
   *
   * @see PageExtractorChild#waitForPageReady
   *
   * @param {TraceId} [traceId] - Correlates this call with an enclosing
   *   headless-extractor request's profiler markers. Internal only, not a
   *   GetTextOptions field: starts its own trace when omitted.
   * @param {number} [refreshWithinMs] - A refresh only counts as a pending
   *   navigation when it fires within this many milliseconds.
   * @returns {Promise<{hasPendingNavigation: boolean}>}
   */
  async waitForPageReady(traceId, refreshWithinMs) {
    const { browsingContext } = this;
    return this.#trace(lazy.Phase.waitForReady, { traceId }, async event => {
      try {
        return await this.sendQuery("PageExtractorParent:WaitForPageReady", {
          traceId: event.traceId,
          refreshWithinMs,
        });
      } catch (error) {
        // The document was replaced or its browser torn down before it was
        // ready. A replacement is read in its place, and a teardown is
        // already reported by the phase that caused it.
        if (error?.name === "AbortError") {
          event.finish({
            status: browsingContext.isDiscarded
              ? "browser-closed"
              : "document-unloaded",
          });
        }
        throw error;
      }
    });
  }

  /**
   * Get metadata related to the page.
   *
   * @see PageExtractorChild#getPageMetadata
   *
   * @returns {Promise<PageMetadata>}
   */
  async getPageMetadata() {
    return this.#trace(lazy.Phase.getPageMetadata, {}, event =>
      this.sendQuery("PageExtractorParent:GetPageMetadata", {
        traceId: event.traceId,
      })
    );
  }

  /**
   * Gets the visible text from the page. This function is a bit smarter than just
   * document.body.innerText. See GetTextOptions
   *
   * @see PageExtractorChild#getText
   *
   * @param {Partial<GetTextOptions>} options
   * @param {TraceId} [traceId] - Correlates this call with an enclosing
   *   headless-extractor request's profiler markers. Internal only, not a
   *   GetTextOptions field: starts its own trace when omitted.
   * @returns {Promise<ExtractionResult | null>}
   */
  async getText(options = {}, traceId) {
    if (options._forceRemoveBoilerplate && !Cu.isInAutomation) {
      throw new Error(
        "The _forceRemoveBoilerplate option from GetTextOptions can only be used in tests."
      );
    }

    return this.#trace(
      lazy.Phase.getText,
      { options, traceId },
      async event => {
        if (this.#isPDF()) {
          const result = await this.#getTextFromPDF(options, event.traceId);
          event.finish({
            status: result.text ? "success" : "empty",
            strategy: "pdf",
            textLength: result.text.length,
            linkCount: result.links.length,
            canvasCount: result.canvasSnapshots.length,
          });
          return result;
        }

        const captchaWatcher = HeadlessCaptchaWatcher.forBrowser(
          this.browsingContext.top.embedderElement
        );
        await captchaWatcher?.waitForRequestedWidget(event);

        const query = this.sendQuery("PageExtractorParent:GetText", {
          options,
          traceId: event.traceId,
        });
        const result = await (captchaWatcher
          ? Promise.race([query, captchaWatcher.blocked])
          : query);
        if (!result) {
          event.finish({ status: "unavailable" });
          return null;
        }
        const captcha = captchaWatcher?.captchaInsteadOfPage(
          result.text.length
        );
        if (captcha) {
          event.addData({ textLength: result.text.length });
          throw blockedError(
            `The page shows a ${captcha.type} bot check instead of its content.`,
            captchaBlockDetails(captcha)
          );
        }
        event.finish({
          status: result.text ? "success" : "empty",
          textLength: result.text.length,
          linkCount: result.links.length,
          canvasCount: result.canvasSnapshots.length,
        });
        return result;
      }
    );
  }

  /**
   * Call out to pdf.js to get the text content and apply the GetTextOptions.
   *
   * @param {GetTextOptions} options
   * @param {TraceId} traceId
   */
  async #getTextFromPDF(options, traceId) {
    return this.#trace(
      lazy.Phase.pdfExtract,
      { traceId, strategy: "pdf" },
      async event => {
        let text = await this.browsingContext.currentWindowGlobal
          .getActor("PdfJs")
          .getTextContent();

        if (
          options.sufficientLength &&
          text.length > options.sufficientLength
        ) {
          // Try to cut at a sentence boundary within the last 100 characters of the
          // end.
          //
          // TODO(Bug 2023932) Make this internationalized, splitting on a "." only works
          // in certain scripts like Latin.
          const truncatePoint = text.lastIndexOf(".", options.sufficientLength);
          if (truncatePoint > options.sufficientLength - 100) {
            text = text.substring(0, truncatePoint + 1);
          } else {
            text = text.substring(0, options.sufficientLength) + "…";
          }
        }

        text = lazy.collapseWhitespace(text).trim();

        event.finish({
          status: text ? "success" : "empty",
          textLength: text.length,
        });
        return { text, links: [], canvasSnapshots: [] };
      }
    );
  }

  #isPDF() {
    return (
      this.browsingContext.currentWindowGlobal.documentPrincipal
        .originNoSuffix == "resource://pdf.js"
    );
  }

  /**
   * @see PageExtractorEvent.trace for docs
   *
   * @template T
   * @param {PageExtractorPhase} phase
   * @param {Record<string, any>} data
   * @param {(event: import('./PageExtractorEvents.sys.mjs').PageExtractorEvent) => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  #trace(phase, data, task) {
    return lazy.PageExtractorEvent.trace(
      phase,
      {
        process: "parent",
        innerWindowId:
          this.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0,
        ...data,
      },
      task
    );
  }

  /**
   * Get a Headless PageExtractor. It is available until the callback's returned
   * Promise is resolved. Then the headless browser is cleaned up.
   *
   * A redirect is only followed within the requested site, and an anonymous
   * fetch is never followed down to http. However the page got there, a
   * location off the site is refused with a "BlockedError" and never read.
   *
   * @see PageExtractorChild#getText
   *
   * @template T - The value resolved in the callback.
   *
   * @param {object} options
   * @param {string} options.urlString
   * @param {(actor: PageExtractorParent, traceId: TraceId) => Promise<T>} options.callback
   *   Called with the actor once the headless page is ready, and the trace
   *   to pass into a follow-up `actor.getText(options, traceId)` call so it
   *   correlates with this request.
   * @param {boolean} [options.anonymousFetch]
   * @returns {Promise<T>}
   */
  static async getHeadlessExtractor({ urlString, callback, anonymousFetch }) {
    const url = URL.parse(urlString);
    if (!url) {
      throw new Error("A valid URL must be provided.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only http: and https: URLs are supported.");
    }
    if (anonymousFetch && url.protocol === "http:") {
      // Only loopback (e.g. localhost) and local network URLs are allowed to use
      // http since they do not perform external network requests.
      const principal = Services.scriptSecurityManager.createContentPrincipal(
        url.URI,
        {}
      );
      if (!principal.isLoopbackHost && !principal.isLocalIpAddress) {
        throw new Error(
          "Only https: URLs are supported for anonymous fetches."
        );
      }
    }
    // Anonymous fetches must not be downgraded to http by a redirect.
    const allowHttp = !anonymousFetch || url.protocol === "http:";
    const userContextId = anonymousFetch
      ? getAnonymousUserContextId()
      : undefined;

    return lazy.PageExtractorEvent.trace(
      lazy.Phase.headlessExtractor,
      {
        process: "parent",
        strategy: anonymousFetch ? "headless-anonymous" : "headless",
      },
      async event => {
        const { traceId } = event;

        // Covers getting a hidden browser ready to load the page in, which
        // for an anonymous fetch includes waiting out a clear of its
        // container.
        const prepareEvent = new lazy.PageExtractorEvent(
          lazy.Phase.headlessPrepare,
          { process: "parent", traceId }
        );

        if (anonymousFetch) {
          await enterAnonymousContainer();
        }

        // The hidden browser manager controls the lifetime of the hidden browser.
        const read = lazy.HiddenBrowserManager.withHiddenBrowser(
          async browser => {
            prepareEvent.finish({ status: "success" });

            // Covers navigating the hidden browser up to onLocationChange,
            // before the page-ready wait starts. Whichever of three outcomes
            // (navigation commits, the actor lookup throws, or the load times
            // out) happens first finishes it; finish()'s idempotency handles
            // the rest.
            const navigateEvent = new lazy.PageExtractorEvent(
              lazy.Phase.headlessNavigate,
              { process: "parent", traceId }
            );

            if (anonymousFetch) {
              // The goal of these settings is to fetch the page without sending
              // any user data to the origin and without letting the visit affect
              // the user's browsing profile (history, cache, trackers, etc).

              // Keep the visit out of browsing history
              // TODO (bug 2043254) - Move this into the HiddenBrowserManager so all hidden browsers don't affect global history.
              browser.setAttribute("disableglobalhistory", "true");
              // Suppress audio output from the loaded page.
              browser.browsingContext?.mediaController?.mute();
              browser.addEventListener("DidChangeBrowserRemoteness", () =>
                browser.browsingContext?.mediaController?.mute()
              );
              const { browsingContext } = browser;
              // Tracking Protection so third-party trackers on the page cannot profile the request or correlate it with the user.
              browsingContext.useTrackingProtection = true;
              // The user's cookies, HTTP auth, and other credentials stay out
              // of the request because the browser loads in its own container.
              // A cookie the page sets still comes back on its later requests,
              // as bot checks expect, and is cleared with the container.
              browsingContext.defaultLoadFlags =
                // Don't write the response into the user's memory cache
                Ci.nsIRequest.INHIBIT_CACHING |
                // Don't write the response into the user's persistent (disk) cache
                Ci.nsIRequest.INHIBIT_PERSISTENT_CACHING;
              // Restrict what the loaded page can do.
              browsingContext.sandboxFlags |=
                SANDBOXED_AUXILIARY_NAVIGATION |
                SANDBOXED_TOPLEVEL_NAVIGATION |
                SANDBOXED_FORMS |
                SANDBOXED_POINTER_LOCK |
                SANDBOXED_AUTOMATIC_FEATURES |
                SANDBOXED_MODALS |
                SANDBOXED_ORIENTATION_LOCK |
                SANDBOXED_PRESENTATION |
                SANDBOXED_STORAGE_ACCESS |
                SANDBOXED_DOWNLOADS;
            }

            const timeoutMs = lazy.headlessTimeoutMs;
            const deadline = ChromeUtils.now() + timeoutMs;
            // Recorded so a failed read can report a block instead of a stall.
            let offSiteLocation = null;
            /** @type {PromiseWithResolvers<PageExtractorParent>} */
            let actorResolver = Promise.withResolvers();

            /** @param {nsIURI} location */
            const isRequestedSite = location => {
              const isAllowedScheme =
                location.schemeIs("https") ||
                (allowHttp && location.schemeIs("http"));
              return isAllowedScheme && isSameSite(url.URI, location);
            };

            const progressFlags =
              Ci.nsIWebProgress.NOTIFY_LOCATION |
              Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT;
            const progressListener = {
              QueryInterface: ChromeUtils.generateQI([
                "nsIWebProgressListener",
                "nsISupportsWeakReference",
              ]),
              /**
               * Watched when the load starts, not when it commits: by commit the
               * document is gone and its actor has already rejected the read.
               *
               * @param {nsIWebProgress} webProgress
               * @param {nsIRequest} request
               * @param {number} stateFlags
               * @param {nsresult} _status
               */
              onStateChange(webProgress, request, stateFlags, _status) {
                const { STATE_START, STATE_IS_DOCUMENT } =
                  Ci.nsIWebProgressListener;
                if (
                  !webProgress.isTopLevel ||
                  !(stateFlags & STATE_START) ||
                  !(stateFlags & STATE_IS_DOCUMENT) ||
                  !(request instanceof Ci.nsIChannel)
                ) {
                  return;
                }
                if (!isRequestedSite(request.URI)) {
                  lazy.console.log(
                    "A load started that wasn't the same site.",
                    request.URI.spec,
                    url.href
                  );
                  offSiteLocation = request.URI.spec;
                }
              },
              /**
               * @param {nsIWebProgress} webProgress
               * @param {nsIRequest} _request
               * @param {nsIURI} location
               * @param {number} _flags
               */
              onLocationChange(webProgress, _request, location, _flags) {
                if (!webProgress.isTopLevel) {
                  lazy.console.log(
                    "Headless browser had a non-top level location change."
                  );
                  return;
                }
                if (!isRequestedSite(location)) {
                  lazy.console.log(
                    "A location change happened that wasn't the same site.",
                    location.spec,
                    url.href
                  );
                  offSiteLocation = location.spec;
                  // A chain may bounce through another site, the way a consent or
                  // single sign-on host hands the request back, so wait for the
                  // read to fail or time out rather than giving up here.
                  return;
                }
                offSiteLocation = null;

                /** @type {any} - This is reported as an `Element`, but it's a <browser> */
                const topBrowser = webProgress.browsingContext.topFrameElement;

                let actor;
                try {
                  actor =
                    topBrowser.browsingContext.currentWindowGlobal.getActor(
                      "PageExtractor"
                    );
                } catch (error) {
                  // TODO (Bug 2001385) - It would be nice to catch if this is the
                  // `about:neterror` page or other similar errors. This will also fail if you
                  // try to access something like `about:reader` with the same error.
                  navigateEvent.finish({
                    status: "error",
                    errorName: error.name,
                  });
                  actorResolver.reject(
                    new DOMException(
                      "PageExtractor could not run on that page or the page could not be found.",
                      error.name
                    )
                  );
                  return;
                }

                navigateEvent.finish({ status: "success" });
                // If the document is about to be replaced, the read of its
                // replacement takes over. Off-site nothing replaces it, so the
                // read fails.
                const superseded = hasPendingNavigation =>
                  !offSiteLocation &&
                  (hasPendingNavigation || wasReplaced(actor));
                actor
                  .waitForPageReady(traceId, deadline - ChromeUtils.now())
                  .then(
                    ({ hasPendingNavigation }) => {
                      if (!superseded(hasPendingNavigation)) {
                        lazy.console.log(
                          "Headless PageExtractor is ready",
                          url
                        );
                        actorResolver.resolve(actor);
                      }
                    },
                    error => {
                      if (!superseded(false)) {
                        actorResolver.reject(error);
                      }
                    }
                  );
              },
            };

            browser.addProgressListener(progressListener, progressFlags);

            const captchaWatcher = lazy.useCaptchaDetection
              ? new HeadlessCaptchaWatcher(browser, event)
              : null;
            captchaWatcher?.start();

            lazy.console.log("Loading a headless PageExtractor", url);

            /** @type {LoadURIOptions} */
            const loadURIOptions = {
              triggeringPrincipal:
                Services.scriptSecurityManager.createNullPrincipal({
                  userContextId,
                }),
            };
            if (anonymousFetch) {
              // Suppress the Referer header so the origin can't learn where the
              // request came from (e.g. the SERP page that surfaced this URL).
              const referrerInfo = Cc[
                "@mozilla.org/referrer-info;1"
              ].createInstance(Ci.nsIReferrerInfo);
              referrerInfo.init(Ci.nsIReferrerInfo.NO_REFERRER, true, null);
              loadURIOptions.referrerInfo = referrerInfo;
              // Navigate the way an address typed by the user does, with
              // Sec-Fetch-Site "none" and Sec-Fetch-User "?1". A cross-site
              // navigation without a referrer is rarely a person. This also
              // counts as a user visit for bounce tracking, which is fine in
              // a container that is thrown away.
              loadURIOptions.hasValidUserGestureActivation = true;
            }

            browser.loadURI(url.URI, loadURIOptions);

            // The load may never commit on the requested host: the network can
            // stall, or bot detection can redirect to a challenge page elsewhere.
            const timeoutId = lazy.setTimeout(() => {
              if (offSiteLocation) {
                navigateEvent.finish({
                  status: "blocked",
                  blockReason: "off-site",
                });
                actorResolver.reject(
                  blockedError(
                    `The page ended up at ${offSiteLocation} instead of ${url.href} and never returned within ${timeoutMs}ms.`,
                    { blockReason: "off-site" }
                  )
                );
                return;
              }
              navigateEvent.finish({
                status: "error",
                errorName: "TimeoutError",
              });
              actorResolver.reject(
                new DOMException(
                  `The page did not load in a headless browser within ${timeoutMs}ms: ${url.href}`,
                  "TimeoutError"
                )
              );
            }, timeoutMs);

            try {
              const extraction = actorResolver.promise.then(actor =>
                callback(actor, traceId)
              );
              // A blocking captcha settles the read at once, instead of
              // waiting out a page that will never get past it.
              return await (captchaWatcher
                ? Promise.race([extraction, captchaWatcher.blocked])
                : extraction);
            } catch (error) {
              if (offSiteLocation && error?.name !== "BlockedError") {
                throw blockedError(
                  `The page navigated to ${offSiteLocation} instead of ${url.href} before its content could be read.`,
                  { blockReason: "off-site" }
                );
              }
              throw error;
            } finally {
              lazy.clearTimeout(timeoutId);
              browser.removeProgressListener(progressListener, progressFlags);
              captchaWatcher?.stop();
            }
          },
          {
            // Create a custom message manager group for this browser so that the PageExtractor
            // actor can communicate with it. The actor is registered to use this custom
            // message manager group.
            messageManagerGroup: "headless-browsers",
            userContextId,
            windowToMatch: Services.wm.getMostRecentBrowserWindow({
              allowPopups: false,
            }),
          }
        );
        read.catch(error =>
          prepareEvent.finish({ status: "error", errorName: error?.name })
        );
        return anonymousFetch ? read.finally(leaveAnonymousContainer) : read;
      }
    );
  }
}
