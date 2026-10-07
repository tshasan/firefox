/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The handlers take a test-only shortcut on the test pages' contents, so
// real provider URLs are checked here.

/**
 * The widget frames of each provider, by the URLs live pages loaded them
 * from on 2026-10-07. Invisible widgets never ask a person anything, so they
 * must not count.
 */
add_task(async function test_captcha_frame_urls() {
  const { captchaTypeForURI } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs"
  );
  const cases = [
    [
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/a1b2c/0x4AAAAAAA/auto/fbE/normal/auto/",
      "cf-turnstile",
    ],
    [
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/a1b2c/0x4AAAAAAA/auto/fbE/new/normal/auto/",
      "cf-turnstile",
    ],
    [
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1",
      null,
    ],
    [
      "https://www.google.com/recaptcha/api2/anchor?ar=1&k=KEY&hl=en&size=normal",
      "g-recaptcha-v2",
    ],
    [
      "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=KEY&size=compact",
      "g-recaptcha-v2",
    ],
    [
      "https://www.google.com/recaptcha/api2/anchor?ar=1&k=KEY&size=invisible",
      null,
    ],
    [
      "https://www.google.com/recaptcha/api2/anchor?ar=1&k=KEY&size=invisible_x",
      "g-recaptcha-v2",
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=checkbox&id=0x1&size=normal",
      "hCaptcha",
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html?v=1#frame=challenge&id=0x1",
      "hCaptcha",
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=checkbox-invisible&id=0x1",
      null,
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=checkbox&id=0x1&size=invisible",
      null,
    ],
    ["https://geo.captcha-delivery.com/captcha/?initialCid=abc", "datadome"],
    [
      "https://client-api.arkoselabs.com/fc/assets/ec-game-core/game-core/1.2.3/standard/index.html",
      "arkoseLabs",
    ],
    ["https://example.com/recaptcha/api2/anchor", null],
  ];
  for (const [spec, expected] of cases) {
    is(
      captchaTypeForURI(Services.io.newURI(spec)),
      expected,
      `${spec} is ${expected ? `a ${expected} widget frame` : "not a widget frame"}.`
    );
  }
});
