/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { HiddenFrame } from "resource://gre/modules/HiddenFrame.sys.mjs"
 * @import { GetTextOptions, ExtractionResult, PageMetadata } from './PageExtractor.d.ts'
 * @import { PageExtractorChild } from './PageExtractorChild.sys.mjs'
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
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
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  headlessTimeoutMs: {
    pref: "browser.ml.pageExtractor.headlessTimeoutMs",
    default: 15000,
  },
  captchaInterventionTimeoutMs: {
    pref: "browser.ml.pageExtractor.captchaInterventionTimeoutMs",
    default: 120000,
  },
});

// A POC's poll cadence isn't worth a pref: there is exactly one call site,
// and nothing plausibly needs to tune it.
const CAPTCHA_POLL_INTERVAL_MS = 1000;

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
 * Puts a detected challenge in front of the user (e.g. by opening a popup
 * window at `url`) so they can solve it. The `browser/` caller owns this,
 * since `toolkit/`'s PageExtractorParent has no window/tab concept of its
 * own.
 *
 * @callback OnChallengeHook
 * @param {URL} url
 * @param {string} provider
 * @returns {{
 *   getActor: () => PageExtractorParent | null,
 *   isClosed: () => boolean,
 *   close: () => void,
 *   dispose: () => void,
 * }}
 */

/**
 * Resolves user- or model-supplied URL text to its canonical absolute form.
 * A bare domain (e.g. "ign.com", the way someone might type it in the URL
 * bar) has no scheme and fails `URL.parse` outright; default those to
 * https, the same guess the URL bar makes. Only does so when the text
 * contains a dot, so free-text strings that merely aren't URLs (no scheme,
 * no TLD) are still rejected rather than misread as a single-label
 * hostname.
 *
 * @param {string} urlString
 * @returns {URL | null}
 */
export function normalizeExtractionUrl(urlString) {
  let url = URL.parse(urlString);
  if (
    !url &&
    !/^[a-z][a-z0-9+.-]*:/i.test(urlString) &&
    urlString.includes(".")
  ) {
    url = URL.parse(`https://${urlString}`);
  }
  return url;
}

/**
 * Whether a redirect from `hostA` to `hostB` should be treated as staying on
 * the requested site. Exact-host matching would reject the common apex-to-
 * `www` (or vice versa) redirect that many sites issue on load, so this
 * falls back to comparing registrable domains.
 *
 * @param {string} hostA
 * @param {string} hostB
 * @returns {boolean}
 */
function isSameSite(hostA, hostB) {
  if (hostA == hostB) {
    return true;
  }
  try {
    return (
      Services.eTLD.getBaseDomainFromHost(hostA) ==
      Services.eTLD.getBaseDomainFromHost(hostB)
    );
  } catch {
    // IP addresses, "localhost", and other hosts without a registrable
    // domain aren't comparable this way; they already failed the exact
    // match above, so treat them as different sites.
    return false;
  }
}

/**
 * Rejects with an AbortError as soon as `signal` aborts, without waiting for
 * `promise` to settle on its own. A late rejection from `promise` (e.g. once
 * an abort tears down the page it was reading) is swallowed so it is not
 * reported as unhandled.
 *
 * @param {Promise<any>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
function raceAbort(promise, signal) {
  promise.catch(() => {});
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
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
   * @param {string} [flowId] - Correlates this call with an enclosing
   *   headless-extractor request's profiler markers. Internal only, not a
   *   GetTextOptions field: mints its own when omitted.
   * @returns {Promise<void>}
   */
  async waitForPageReady(flowId) {
    const event = this.#startEvent("wait-for-ready", { flowId });
    return event.run(() =>
      this.sendQuery("PageExtractorParent:WaitForPageReady", {
        flowId: event.flowId,
      })
    );
  }

  /**
   * Waits for the page to be ready and checks it for a known challenge in a
   * single round trip. Used by the headless-extraction flow's initial
   * post-navigation check, where calling `waitForPageReady()` and
   * `detectCaptcha()` separately would pay for two queries on every headless
   * load even though almost none of them are challenges.
   *
   * @see PageExtractorChild#waitForHeadlessPageReady
   *
   * @param {string} flowId
   * @returns {Promise<string | null>} the matched challenge provider, or null
   */
  async waitForHeadlessPageReady(flowId) {
    const readyEvent = this.#startEvent("wait-for-ready", { flowId });
    const captchaEvent = this.#startEvent("detect-captcha", { flowId });
    try {
      const provider = await this.sendQuery(
        "PageExtractorParent:WaitForHeadlessPageReady",
        { flowId }
      );
      readyEvent.finish({ status: "success" });
      captchaEvent.finish({ status: "success" });
      return provider;
    } catch (error) {
      readyEvent.finish({ status: "error", errorName: error.name });
      captchaEvent.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }

  /**
   * Get metadata related to the page.
   *
   * @see PageExtractorChild#getPageMetadata
   *
   * @returns {Promise<PageMetadata>}
   */
  async getPageMetadata() {
    const event = this.#startEvent("get-page-metadata");
    return event.run(() =>
      this.sendQuery("PageExtractorParent:GetPageMetadata", {
        flowId: event.flowId,
      })
    );
  }

  /**
   * Checks whether the page currently loaded in this actor shows a known
   * bot-detection challenge, so a headless caller can hand off to the user
   * instead of reading the challenge page itself.
   *
   * @see PageExtractorChild#detectCaptcha
   *
   * @param {string} flowId
   * @returns {Promise<string | null>} the matched challenge provider, or null
   */
  async detectCaptcha(flowId) {
    const event = this.#startEvent("detect-captcha", { flowId });
    return event.run(() =>
      this.sendQuery("PageExtractorParent:DetectCaptcha", {
        flowId: event.flowId,
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
   * @param {string} [flowId] - Correlates this call with an enclosing
   *   headless-extractor request's profiler markers. Internal only, not a
   *   GetTextOptions field: mints its own when omitted.
   * @returns {Promise<ExtractionResult | null>}
   */
  async getText(options = {}, flowId) {
    if (options._forceRemoveBoilerplate && !Cu.isInAutomation) {
      throw new Error(
        "The _forceRemoveBoilerplate option from GetTextOptions can only be used in tests."
      );
    }

    const event = this.#startEvent("get-text", { options, flowId });
    return event.run(async () => {
      if (this.#isPDF()) {
        const result = await this.#getTextFromPDF(options, event.flowId);
        event.finish({
          status: "success",
          strategy: "pdf",
          textLength: result.text.length,
          linkCount: result.links.length,
          canvasCount: result.canvasSnapshots.length,
        });
        return result;
      }

      const result = await this.sendQuery("PageExtractorParent:GetText", {
        options,
        flowId: event.flowId,
      });
      if (!result) {
        event.finish({ status: "unavailable" });
        return null;
      }
      event.finish({
        status: "success",
        textLength: result.text.length,
        linkCount: result.links.length,
        canvasCount: result.canvasSnapshots.length,
      });
      return result;
    });
  }

  /**
   * Call out to pdf.js to get the text content and apply the GetTextOptions.
   *
   * @param {GetTextOptions} options
   * @param {string | undefined} flowId
   */
  async #getTextFromPDF(options, flowId) {
    const event = this.#startEvent("pdf-extract", {
      flowId,
      strategy: "pdf",
    });
    return event.run(async () => {
      let text = await this.browsingContext.currentWindowGlobal
        .getActor("PdfJs")
        .getTextContent();

      if (options.sufficientLength && text.length > options.sufficientLength) {
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

      event.finish({ status: "success", textLength: text.length });
      return { text, links: [], canvasSnapshots: [] };
    });
  }

  #isPDF() {
    return (
      this.browsingContext.currentWindowGlobal.documentPrincipal
        .originNoSuffix == "resource://pdf.js"
    );
  }

  /**
   * @param {string} phase
   * @param {Record<string, any>} [data]
   */
  #startEvent(phase, data = {}) {
    return new lazy.PageExtractorEvent(phase, {
      process: "parent",
      innerWindowId:
        this.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0,
      ...data,
    });
  }

  /**
   * Waits for the headless-loaded page to be ready and checks it for a known
   * challenge.
   *
   * @param {PageExtractorParent} actor
   * @param {string} flowId
   * @param {URL} url
   * @returns {Promise<{ actor: PageExtractorParent } | { provider: string }>}
   */
  static async #awaitHeadlessPageReady(actor, flowId, url) {
    const provider = await actor.waitForHeadlessPageReady(flowId);
    if (provider) {
      lazy.console.log(
        `Headless PageExtractor hit a ${provider} challenge, escalating to the user`,
        url
      );
      return { provider };
    }
    lazy.console.log("Headless PageExtractor is ready", url);
    return { actor };
  }

  /**
   * Get a Headless PageExtractor. It is available until the callback's returned
   * Promise is resolved. Then the headless browser is cleaned up.
   *
   * @see PageExtractorChild#getText
   *
   * @template T - The value resolved in the callback.
   *
   * @param {object} options
   * @param {string} options.urlString
   * @param {(actor: PageExtractorParent, flowId: string) => Promise<T>} options.callback
   *   Called with the actor once the headless page is ready, and the flowId
   *   to pass into a follow-up `actor.getText(options, flowId)` call so it
   *   correlates with this request.
   * @param {boolean} [options.anonymousFetch]
   * @param {OnChallengeHook} [options.onChallenge] - Puts a detected
   *   challenge in front of the user so they can solve it. Without this, a
   *   detected challenge is reported as a BlockedError instead of escalated
   *   -- same as an anonymousFetch request, which never escalates, since
   *   handing an anonymous request off to a credentialed, foreground tab
   *   would defeat the point of asking for anonymity.
   * @returns {Promise<T>}
   */
  static async getHeadlessExtractor({
    urlString,
    callback,
    anonymousFetch,
    onChallenge,
  }) {
    const event = new lazy.PageExtractorEvent("headless-extractor", {
      process: "parent",
      strategy: anonymousFetch ? "headless-anonymous" : "headless",
    });
    const { flowId } = event;

    // Validation failures below are recorded through this run() too (as
    // "error" with the DOMException's name), so a request blocked before it
    // ever reaches the network is still visible in page_extractor.phase.
    return event.run(async () => {
      const url = normalizeExtractionUrl(urlString);
      if (!url) {
        throw new Error("A valid URL must be provided.");
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new DOMException(
          "Only http: and https: URLs are supported.",
          "SecurityError"
        );
      }
      if (anonymousFetch && url.protocol === "http:") {
        // Only loopback (e.g. localhost) and local network URLs are allowed to use
        // http since they do not perform external network requests.
        const principal = Services.scriptSecurityManager.createContentPrincipal(
          url.URI,
          {}
        );
        if (!principal.isLoopbackHost && !principal.isLocalIpAddress) {
          throw new DOMException(
            "Only https: URLs are supported for anonymous fetches.",
            "SecurityError"
          );
        }
      }

      // Covers navigating the hidden browser up to onLocationChange, before
      // the page-ready wait starts. Whichever of three outcomes (navigation
      // commits, the actor lookup throws, or the load times out) happens
      // first finishes it; finish()'s idempotency handles the rest.
      const navigateEvent = new lazy.PageExtractorEvent("headless-navigate", {
        process: "parent",
        flowId,
      });

      // The hidden browser manager controls the lifetime of the hidden
      // browser. Its callback only keeps the browser checked out for as long
      // as it's actually useful: through the callback() call on the normal
      // path, but only up to challenge-detection on the escalation path --
      // once escalated, the real work happens in a foreground tab that has
      // nothing to do with this hidden browser.
      const outcome = await lazy.HiddenBrowserManager.withHiddenBrowser(
        async browser => {
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
            browsingContext.defaultLoadFlags =
              // Strip cookies, HTTP auth, and other credentials from the request
              Ci.nsIRequest.LOAD_ANONYMOUS |
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

          const { host } = url;

          // Set when a location change lands on a different site than
          // requested (e.g. a bot-detection challenge redirect) and never
          // comes back; read on timeout to tell that case apart from a page
          // that simply never responded.
          let challengeHost = null;

          /** @type {PromiseWithResolvers<{ actor: PageExtractorParent } | { provider: string }>} */
          const actorResolver = Promise.withResolvers();

          const locationChangeFlags = Ci.nsIWebProgress.NOTIFY_LOCATION;
          const onLocationChange = {
            QueryInterface: ChromeUtils.generateQI([
              "nsIWebProgressListener",
              "nsISupportsWeakReference",
            ]),
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
              if (!isSameSite(URL.fromURI(location).host, host)) {
                lazy.console.log(
                  "A location change happened that wasn't the same site.",
                  location.host,
                  host
                );
                // This is probably overkill, but make sure this is not a spurious
                // redirect.
                challengeHost = location.host;
                return;
              }
              challengeHost = null;
              browser.removeProgressListener(
                onLocationChange,
                locationChangeFlags
              );

              /** @type {any} - This is reported as an `Element`, but it's a <browser> */
              const topBrowser = webProgress.browsingContext.topFrameElement;

              try {
                const actor =
                  topBrowser.browsingContext.currentWindowGlobal.getActor(
                    "PageExtractor"
                  );

                navigateEvent.finish({ status: "success" });
                PageExtractorParent.#awaitHeadlessPageReady(
                  actor,
                  flowId,
                  url
                ).then(
                  readyOutcome => actorResolver.resolve(readyOutcome),
                  error => actorResolver.reject(error)
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
                  new Error(
                    "PageExtractor could not run on that page or the page could not be found."
                  )
                );
              }
            },
          };

          browser.addProgressListener(onLocationChange, locationChangeFlags);

          lazy.console.log("Loading a headless PageExtractor", url);

          /** @type {LoadURIOptions} */
          const loadURIOptions = {
            triggeringPrincipal:
              Services.scriptSecurityManager.createNullPrincipal({}),
          };
          if (anonymousFetch) {
            // Suppress the Referer header so the origin can't learn where the
            // request came from (e.g. the SERP page that surfaced this URL).
            const referrerInfo = Cc[
              "@mozilla.org/referrer-info;1"
            ].createInstance(Ci.nsIReferrerInfo);
            referrerInfo.init(Ci.nsIReferrerInfo.NO_REFERRER, true, null);
            loadURIOptions.referrerInfo = referrerInfo;
            // Don't add an entry for this load to session history.
            loadURIOptions.loadFlags =
              Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY;
          }

          browser.loadURI(url.URI, loadURIOptions);

          // The load may never commit on the requested host: the network can
          // stall, or bot detection can redirect to a challenge page elsewhere.
          const timeoutMs = lazy.headlessTimeoutMs;
          const timeoutId = lazy.setTimeout(() => {
            if (challengeHost) {
              navigateEvent.finish({
                status: "error",
                errorName: "BlockedError",
              });
              actorResolver.reject(
                new DOMException(
                  `The page redirected to ${challengeHost} instead of loading ${url.host}, which looks like a bot-detection challenge, and never returned within ${timeoutMs}ms.`,
                  "BlockedError"
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

          /** @type {{ actor: PageExtractorParent } | { provider: string }} */
          let readyOutcome;
          try {
            readyOutcome = await actorResolver.promise;
          } finally {
            lazy.clearTimeout(timeoutId);
          }

          if ("provider" in readyOutcome) {
            // Nothing left for the hidden browser to do: the real work, if
            // any, happens in a foreground tab that has no relationship to
            // it. Return now so HiddenBrowserManager tears it down instead
            // of holding it open for the whole user-intervention wait.
            return readyOutcome;
          }
          return { result: await callback(readyOutcome.actor, flowId) };
        },
        {
          // Create a custom message manager group for this browser so that the PageExtractor
          // actor can communicate with it. The actor is registered to use this custom
          // message manager group.
          messageManagerGroup: "headless-browsers",
        }
      );

      if ("result" in outcome) {
        return outcome.result;
      }

      const { provider } = outcome;
      if (anonymousFetch || !onChallenge) {
        throw new DOMException(
          `The page at ${url.href} is blocked by a ${provider} challenge.`,
          "BlockedError"
        );
      }

      const interventionAbort = new AbortController();
      const interventionTimeoutId = lazy.setTimeout(() => {
        interventionAbort.abort(
          new DOMException(
            `The user did not clear the ${provider} challenge at ${url.href} within ${lazy.captchaInterventionTimeoutMs}ms.`,
            "TimeoutError"
          )
        );
      }, lazy.captchaInterventionTimeoutMs);

      let actor, close;
      try {
        ({ actor, close } =
          await PageExtractorParent.#resolveCaptchaWithUserIntervention(
            onChallenge,
            url,
            provider,
            flowId,
            interventionAbort.signal
          ));
      } finally {
        lazy.clearTimeout(interventionTimeoutId);
      }
      try {
        return await callback(actor, flowId);
      } finally {
        close();
      }
    });
  }

  /**
   * Prototype hand-off for a challenge the headless browser can't solve on
   * its own: uses the caller-supplied `onChallenge` hook to put `url` in
   * front of the user, then polls until the challenge clears.
   *
   * On success, returns the actor along with a `close` the caller must call
   * once done with it -- deferred to the caller rather than closed here, so
   * the popup (and its actor) stays alive for as long as extraction actually
   * needs it. On any failure (timeout, abort, or the user closing the
   * window), closes the popup itself before rethrowing, since in that case
   * nothing else ever will.
   *
   * This is a POC for the end-to-end user-intervention flow, not a
   * production design: it polls rather than reacting to page events.
   *
   * @param {OnChallengeHook} onChallenge
   * @param {URL} url
   * @param {string} provider
   * @param {string} flowId
   * @param {AbortSignal} signal - Stops polling once the caller's
   *   intervention budget is spent.
   * @returns {Promise<{ actor: PageExtractorParent, close: () => void }>}
   */
  static async #resolveCaptchaWithUserIntervention(
    onChallenge,
    url,
    provider,
    flowId,
    signal
  ) {
    const event = new lazy.PageExtractorEvent("captcha-intervention", {
      process: "parent",
      innerWindowId: 0,
      flowId,
      strategy: provider,
    });
    return event.run(async () => {
      const { getActor, isClosed, close, dispose } = onChallenge(url, provider);
      try {
        while (!isClosed() && !signal.aborted) {
          try {
            const actor = getActor();
            if (actor) {
              const matchedProvider = await raceAbort(
                actor.detectCaptcha(flowId),
                signal
              );
              if (!matchedProvider) {
                return { actor, close };
              }
            }
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }
            // Between opening the tab and the requested URL's load
            // committing, the tab briefly sits on about:blank (or an
            // intermediate redirect hop), where the actor doesn't match;
            // treat that, like any other transient failure to reach the
            // actor, as "not ready yet" rather than aborting the wait.
            lazy.console.log(
              "Transient error polling the intervention tab, retrying",
              error
            );
          }
          await raceAbort(
            new Promise(resolve =>
              lazy.setTimeout(resolve, CAPTCHA_POLL_INTERVAL_MS)
            ),
            signal
          );
        }
        throw new DOMException(
          isClosed()
            ? `The user closed the window opened to solve the ${provider} challenge at ${url.href}.`
            : `Stopped polling ${url.href} for the ${provider} challenge to clear.`,
          "AbortError"
        );
      } catch (error) {
        close();
        throw error;
      } finally {
        dispose();
      }
    });
  }
}
