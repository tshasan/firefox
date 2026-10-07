/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

/**
 * The captcha provider whose widget frame a document at `uri` is, if any.
 * CaptchaDetectionChild picks the handler for a frame by it.
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
