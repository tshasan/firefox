/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The handlers and helpers take test-only shortcuts on the test pages'
// file names, so real provider URLs are checked here.

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

/**
 * The captcha scripts a read waits on, as live pages requested them on
 * 2026-10-05. A read only waits on a script whose widget CaptchaDetection
 * goes on to report, so reCAPTCHA v3, which only renders an invisible
 * frame, must not match.
 */
add_task(async function test_captcha_loader_scripts() {
  const { captchaTypeForLoaderScript } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/captchadetection/CaptchaFrames.sys.mjs"
  );
  const cases = [
    ["https://www.google.com/recaptcha/api.js", "g-recaptcha-v2"],
    [
      "https://www.google.com/recaptcha/api.js?onload=cb&render=explicit",
      "g-recaptcha-v2",
    ],
    ["https://www.google.com/recaptcha/enterprise.js", "g-recaptcha-v2"],
    ["https://js.hcaptcha.com/1/api.js", "hCaptcha"],
    ["https://ct.captcha-delivery.com/c.js", "datadome"],
    [
      "https://www.google.com/recaptcha/api.js?render=6Lcyqq8oAAAAAJE7eVJ3aZp_hnJcI6LgGdYD8lge",
      null,
    ],
    [
      "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=cb&render=explicit",
      "cf-turnstile",
    ],
    [
      "https://client-api.arkoselabs.com/v2/11111111-1111-1111-1111-111111111111/api.js",
      "arkoseLabs",
    ],
    ["https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js", null],
  ];
  for (const [spec, expected] of cases) {
    is(
      captchaTypeForLoaderScript(Services.io.newURI(spec)),
      expected,
      `${spec} is ${expected ? `a ${expected} widget script` : "not waited on"}.`
    );
  }
});
