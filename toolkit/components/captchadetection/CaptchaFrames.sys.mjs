/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @import { CaptchaDetectionUpdate } from "moz-src:///toolkit/components/captchadetection/CaptchaDetectionParent.sys.mjs"
 */

const RECAPTCHA_V2_FRAMES = new MatchPatternSet([
  "https://www.google.com/recaptcha/api2/*",
  "https://www.google.com/recaptcha/enterprise/*",
]);

// "f/av0/rch" is the widget frame Cloudflare serves as of October 2026;
// "if/ov2/av0/rcv" is its predecessor.
const CF_TURNSTILE_FRAMES = new MatchPatternSet([
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/*/turnstile/if/ov2/av0/rcv/*",
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/*/turnstile/f/av0/rch/*",
]);

const DATADOME_FRAMES = new MatchPatternSet([
  "https://geo.captcha-delivery.com/captcha/*",
]);

// A match pattern's path includes the query, so the page is matched both
// with and without one.
const HCAPTCHA_FRAMES = new MatchPatternSet([
  "https://newassets.hcaptcha.com/captcha/v1/*/static/hcaptcha.html",
  "https://newassets.hcaptcha.com/captcha/v1/*/static/hcaptcha.html?*",
]);

const ARKOSE_LABS_FRAMES = new MatchPatternSet([
  "https://client-api.arkoselabs.com/fc/assets/ec-game-core/game-core/*",
]);

// The scripts a page loads to render a captcha widget, which are requested
// well before the widget's frame exists. Only scripts whose widget the
// handlers in CaptchaDetectionChild go on to report belong here: for any
// other, a caller waiting on the report would wait in vain.
const RECAPTCHA_V2_SCRIPTS = new MatchPatternSet([
  "https://www.google.com/recaptcha/api.js*",
  "https://www.google.com/recaptcha/enterprise.js*",
]);

const HCAPTCHA_SCRIPTS = new MatchPatternSet([
  "https://js.hcaptcha.com/1/api.js*",
]);

// Only served on DataDome's block page, beside its captcha frame.
const DATADOME_SCRIPTS = new MatchPatternSet([
  "https://ct.captcha-delivery.com/c.js*",
]);

const CF_TURNSTILE_SCRIPTS = new MatchPatternSet([
  "https://challenges.cloudflare.com/turnstile/v0/api.js*",
]);

// Its game frame only appears when Arkose decides to challenge the visitor,
// so a page where it doesn't waits out the caller's full limit.
const ARKOSE_LABS_SCRIPTS = new MatchPatternSet([
  "https://client-api.arkoselabs.com/v2/*/api.js*",
]);

/**
 * The captcha states in which the check went against the visitor: a puzzle
 * was presented, the visitor was refused, or a check failed.
 *
 * @type {Set<string>}
 */
export const BLOCKING_CAPTCHA_EVENTS = new Set([
  "challenge",
  "blocked",
  "failed",
]);

/**
 * The captcha providers CaptchaDetection recognizes, by the type it reports,
 * as named to people.
 *
 * @type {Map<string, string>}
 */
export const CAPTCHA_PROVIDER_NAMES = new Map([
  ["g-recaptcha-v2", "Google reCAPTCHA"],
  ["cf-turnstile", "Cloudflare Turnstile"],
  ["datadome", "DataDome"],
  ["hCaptcha", "hCaptcha"],
  ["arkoseLabs", "Arkose Labs"],
]);

/**
 * The captcha states CaptchaDetection reports, as described to people.
 *
 * @type {Map<string, string>}
 */
export const CAPTCHA_EVENT_LABELS = new Map([
  ["shown", "widget shown"],
  ["challenge", "puzzle presented"],
  ["blocked", "visitor refused"],
  ["failed", "check failed"],
  ["passed", "check passed"],
]);

/**
 * The captcha states CaptchaDetection reports, explained in a sentence, as to
 * someone who needs to know why a page couldn't be read.
 *
 * @type {Map<string, string>}
 */
export const CAPTCHA_EVENT_EXPLANATIONS = new Map([
  ["shown", "it shows a verification check instead of the page"],
  ["challenge", "it asked for a puzzle to be solved"],
  ["blocked", "the site refused the request outright"],
  ["failed", "the check flagged the request as automated"],
  ["passed", "the check let the request through"],
]);

/**
 * The captcha provider whose widget frame a document at `uri` is, if any.
 * CaptchaDetectionChild picks the handler for a frame by it, and
 * findCaptchaFrame finds the captcha frames in a page by it.
 *
 * @param {nsIURI} uri
 * @returns {string | null}
 */
export function captchaTypeForURI(uri) {
  if (RECAPTCHA_V2_FRAMES.matches(uri)) {
    const size = URL.fromURI(uri).searchParams.get("size");
    return size === "invisible" ? null : "g-recaptcha-v2";
  }
  if (CF_TURNSTILE_FRAMES.matches(uri)) {
    return "cf-turnstile";
  }
  if (DATADOME_FRAMES.matches(uri)) {
    return "datadome";
  }
  if (HCAPTCHA_FRAMES.matches(uri)) {
    // hCaptcha passes its frame's options in the fragment.
    const options = new URLSearchParams(URL.fromURI(uri).hash.slice(1));
    return options.get("size") === "invisible" ||
      options.get("frame") === "checkbox-invisible"
      ? null
      : "hCaptcha";
  }
  if (ARKOSE_LABS_FRAMES.matches(uri)) {
    return "arkoseLabs";
  }
  return null;
}

/**
 * The captcha provider whose widget-loading script `uri` is, if any.
 *
 * @param {nsIURI} uri
 * @returns {string | null}
 */
export function captchaTypeForLoaderScript(uri) {
  if (Cu.isInAutomation && uri.filePath.endsWith("/captcha_loader.js")) {
    return "cf-turnstile";
  }
  if (RECAPTCHA_V2_SCRIPTS.matches(uri)) {
    // reCAPTCHA v3 loads as api.js?render=<site key> and only ever renders an
    // invisible frame, which GoogleRecaptchaV2Handler skips. Explicit v2
    // rendering passes render=explicit instead.
    const render = URL.fromURI(uri).searchParams.get("render");
    return render && render !== "explicit" ? null : "g-recaptcha-v2";
  }
  if (HCAPTCHA_SCRIPTS.matches(uri)) {
    return "hCaptcha";
  }
  if (DATADOME_SCRIPTS.matches(uri)) {
    return "datadome";
  }
  if (CF_TURNSTILE_SCRIPTS.matches(uri)) {
    return "cf-turnstile";
  }
  if (ARKOSE_LABS_SCRIPTS.matches(uri)) {
    return "arkoseLabs";
  }
  return null;
}

/**
 * Finds a captcha frame in a page from the frames' URLs alone. Unlike the
 * "captcha-detection-update" notification, this doesn't wait on the
 * captcha's document to load and its actor to report in, so a caller can
 * check at the moment it needs to know.
 *
 * @param {BrowsingContext} browsingContext - The page's top BrowsingContext.
 * @returns {CaptchaDetectionUpdate | null} A "shown" update for the first
 *   captcha frame found.
 */
export function findCaptchaFrame(browsingContext) {
  for (const context of browsingContext.getAllBrowsingContextsInSubtree()) {
    const uri = context.currentURI;
    // The page itself is never its own captcha frame.
    if (!uri || context === browsingContext) {
      continue;
    }
    const type =
      Cu.isInAutomation && uri.filePath.endsWith("/captcha_frame.html")
        ? "cf-turnstile"
        : captchaTypeForURI(uri);
    if (type) {
      return { type, event: "shown" };
    }
  }
  return null;
}
