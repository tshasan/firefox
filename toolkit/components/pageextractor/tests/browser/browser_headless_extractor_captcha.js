/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Mirrors browser_headless_extractor.js: a real hidden browser loads a real
// page, here with a captcha iframe that the real CaptchaDetection actor
// recognizes. Nothing is stubbed.

const { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);
const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);

const TEST_DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  ""
);
const CAPTCHA_FRAME = `https://example.org${TEST_DIR}captcha_frame.html`;
const CAPTCHA_LOADER = `https://example.org${TEST_DIR}captcha_loader.js`;
const CAPTCHA_TOPIC = "captcha-detection-update";

/**
 * Serves a page with `text` and a Cloudflare Turnstile iframe.
 *
 * @param {string} text
 * @param {"fail"|"success"} [state] - The verdict the widget shows; it only
 *   loads when omitted.
 */
function serveCaptchaPage(text, state) {
  const { html } = MLTestUtils.serveHTML();
  const frameUrl = state ? `${CAPTCHA_FRAME}?state=${state}` : CAPTCHA_FRAME;
  return html`
    <p>${text}</p>
    <iframe src=${frameUrl}></iframe>
  `;
}

/**
 * Resolves once CaptchaDetection reports `event` for a captcha in any page.
 *
 * @param {string} event
 */
function captchaUpdate(event) {
  return TestUtils.topicObserved(
    CAPTCHA_TOPIC,
    (_subject, data) => JSON.parse(data).event === event
  );
}

function findPhaseEvent(phase) {
  return Glean.pageExtractor.phase
    .testGetValue("page-extractor")
    ?.find(e => e.extra.phase === phase && e.extra.process === "parent");
}

/**
 * A captcha that flags the hidden browser settles the read as blocked right
 * away, with the provider and verdict, instead of leaving the caller waiting
 * on a page that will never get past it.
 */
add_task(async function test_failed_captcha_blocks_immediately() {
  Services.fog.testResetFOG();
  const { url, cleanup } = serveCaptchaPage("Verify you are human.", "fail");

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        // Never settles: only the captcha verdict can end this read.
        callback: () => new Promise(() => {}),
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaType === "cf-turnstile" &&
        error.captchaEvent === "failed",
      "The failed bot check is reported as a captcha block naming the provider."
    );
  } finally {
    await cleanup();
  }

  const headless = findPhaseEvent("headless-extractor");
  is(headless.extra.status, "blocked", "Telemetry records a block.");
  is(headless.extra.block_reason, "captcha", "Telemetry records why.");
  is(
    headless.extra.captcha_type,
    "cf-turnstile",
    "Telemetry names the captcha."
  );
  is(headless.extra.captcha_event, "failed", "Telemetry records the verdict.");

  const detected = findPhaseEvent("captcha-detected");
  ok(detected, "The moment the captcha appeared is recorded.");
  is(
    detected.extra.flow_id,
    headless.extra.flow_id,
    "The captcha-detected phase belongs to the same flow as the load."
  );

  is(
    Glean.captchaDetection.cloudflareTurnstileOc.testGetValue(),
    null,
    "A captcha in a hidden browser stays out of the user-facing captcha ping."
  );
});

/**
 * A page that is little more than a captcha widget is reported as blocked
 * when read, rather than handing back the bot check's text as the page.
 */
add_task(async function test_short_page_with_captcha_is_blocked() {
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const shown = captchaUpdate("shown");

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: async (pageExtractor, traceId) => {
          await shown;
          return pageExtractor.getText({}, traceId);
        },
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaEvent === "shown",
      "The bot check's text is not mistaken for the page's content."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A bot check the hidden browser passed lets the page be read, however
 * little text it has.
 */
add_task(async function test_passed_captcha_does_not_block() {
  const { url, cleanup } = serveCaptchaPage(
    "Checking your browser.",
    "success"
  );
  const passed = captchaUpdate("passed");

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, traceId) => {
        await passed;
        return pageExtractor.getText({}, traceId);
      },
    });
    is(
      result.text,
      "Checking your browser.",
      "A passed bot check is not reported as a block."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A read that fails beside a captcha widget that only loaded keeps its own
 * error: nothing shows the widget caused it, and a challenge that reloads
 * the page forever can't be told apart from a slow page.
 */
add_task(async function test_failure_beside_shown_captcha_is_not_a_block() {
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const shown = captchaUpdate("shown");

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: async () => {
          await shown;
          throw new DOMException("The read stalled.", "TimeoutError");
        },
      }),
      error => error.name === "TimeoutError" && !error.blockReason,
      "The failure is reported as itself, not blamed on the captcha."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A page whose captcha script has been requested but has not yet inserted
 * its widget is not read until the widget shows up, the way hCaptcha's
 * script loses the race against a fast read.
 */
add_task(async function test_read_waits_for_requested_captcha_widget() {
  Services.fog.testResetFOG();
  const { html } = MLTestUtils.serveHTML();
  const { url, cleanup } = html`
    <p>Checking your browser.</p>
    <script src=${CAPTCHA_LOADER}></script>
  `;

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: (pageExtractor, traceId) =>
          pageExtractor.getText({}, traceId),
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaEvent === "shown",
      "The read waits for the widget and sees the page is behind it."
    );
  } finally {
    await cleanup();
  }

  Assert.greater(
    Number(findPhaseEvent("get-text").extra.captcha_wait_ms),
    0,
    "Telemetry records that the read waited."
  );
});

/**
 * A read waiting on a captcha widget stops as soon as the widget blocks the
 * page, instead of going on to read a page the load has already given up on.
 */
add_task(async function test_blocked_read_stops_waiting() {
  Services.fog.testResetFOG();
  const { html } = MLTestUtils.serveHTML();
  // Long enough to be read as the page rather than the bot check, so only
  // the block can end the read.
  const { url, cleanup } = html`
    <p>${"An article beside a sign-up form. ".repeat(50)}</p>
    <script src="${CAPTCHA_LOADER}?state=fail"></script>
  `;

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: (pageExtractor, traceId) =>
          pageExtractor.getText({}, traceId),
      }),
      error => error.name === "BlockedError" && error.captchaEvent === "failed",
      "The widget's verdict blocks the read."
    );
  } finally {
    await cleanup();
  }

  const getText = await TestUtils.waitForCondition(
    () => findPhaseEvent("get-text"),
    "The read's phase is recorded"
  );
  is(
    getText.extra.status,
    "blocked",
    "The read ends on the block, not on the page being torn down under it."
  );
  is(getText.extra.block_reason, "captcha", "The read records why.");
  is(
    getText.extra.captcha_event,
    "failed",
    "The read records the verdict that ended it."
  );
  ok(
    "captcha_wait_ms" in getText.extra,
    "The read records its wait for the widget."
  );
});

/**
 * A captcha script that never inserts a widget delays the read only for a
 * bounded time, and the page is then read as-is.
 */
add_task(async function test_read_wait_for_captcha_widget_is_bounded() {
  Services.fog.testResetFOG();
  const { html } = MLTestUtils.serveHTML();
  const { url, cleanup } = html`
    <p>Checking your browser.</p>
    <script src="${CAPTCHA_LOADER}?frame=none"></script>
  `;

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: (pageExtractor, traceId) => pageExtractor.getText({}, traceId),
    });
    is(
      result.text,
      "Checking your browser.",
      "The page is read once the wait for a widget runs out."
    );
  } finally {
    await cleanup();
  }

  // PageExtractorParent waits up to CAPTCHA_WIDGET_WAIT_MS, 1500 ms. A timer
  // never fires early, so only rounding can make the wait look shorter.
  Assert.greaterOrEqual(
    Number(findPhaseEvent("get-text").extra.captcha_wait_ms),
    1450,
    "Telemetry records that the read waited out the full limit."
  );
});

/**
 * A captcha frame that is on the page when it is read counts even if its
 * actor never reported in, the way a slow widget loses the race against a
 * fast read. With the actor off, only the frame's URL can give it away.
 */
add_task(async function test_captcha_frame_found_without_actor_report() {
  Services.fog.testResetFOG();
  await SpecialPowers.pushPrefEnv({
    set: [["captchadetection.actor.enabled", false]],
  });
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const updates = [];
  const observer = (_subject, _topic, data) => updates.push(data);
  Services.obs.addObserver(observer, CAPTCHA_TOPIC);

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: async (pageExtractor, traceId) => {
          await TestUtils.waitForCondition(
            () =>
              pageExtractor.browsingContext
                .getAllBrowsingContextsInSubtree()
                .some(context =>
                  context.currentURI?.spec.includes("captcha_frame.html")
                ),
            "The captcha frame commits in the page."
          );
          return pageExtractor.getText({}, traceId);
        },
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaType === "cf-turnstile" &&
        error.captchaEvent === "shown",
      "The captcha frame on the page is found when the page is read."
    );
  } finally {
    Services.obs.removeObserver(observer, CAPTCHA_TOPIC);
    await cleanup();
    await SpecialPowers.popPrefEnv();
  }
  Assert.deepEqual(
    updates,
    [],
    "No actor reported the captcha, so the frame's URL found it."
  );

  const headless = findPhaseEvent("headless-extractor");
  is(headless.extra.block_reason, "captcha", "Telemetry records why.");
  is(
    headless.extra.captcha_type,
    "cf-turnstile",
    "Telemetry names the captcha found only when the page was read."
  );
  is(
    headless.extra.captcha_event,
    "shown",
    "Telemetry records the captcha's state."
  );
});

/**
 * A captcha widget beside readable content, the way one sits on a comment
 * form, does not keep the page from being read.
 */
add_task(async function test_captcha_beside_content_is_read() {
  Services.fog.testResetFOG();
  const text = "An article long enough to read. ".repeat(40).trim();
  const { url, cleanup } = serveCaptchaPage(text);
  const shown = captchaUpdate("shown");

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, traceId) => {
        await shown;
        return pageExtractor.getText({}, traceId);
      },
    });
    is(result.text, text, "The page's own content is extracted.");
  } finally {
    await cleanup();
  }

  Assert.strictEqual(
    findPhaseEvent("get-text").extra.captcha_wait_ms,
    undefined,
    "A page that requested no captcha script records no wait."
  );
  is(
    findPhaseEvent("headless-extractor").extra.captcha_type,
    "cf-turnstile",
    "A captcha beside readable content is still recorded on the load."
  );
});

/**
 * With the consumer turned off, a captcha is not reported as a block.
 */
add_task(async function test_disabled_ignores_captcha() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.pageExtractor.captchaDetection.enabled", false]],
  });
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const shown = captchaUpdate("shown");

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, traceId) => {
        await shown;
        return pageExtractor.getText({}, traceId);
      },
    });
    is(
      result.text,
      "Checking your browser.",
      "The page is read as-is when captcha detection is disabled."
    );
  } finally {
    await cleanup();
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * A profile shows the captcha on the same PageExtractor track as the load it
 * blocked, plus CaptchaDetection's own marker flagged as a hidden browser.
 */
add_task(async function test_captcha_profiler_markers() {
  const { url, cleanup } = serveCaptchaPage("Verify you are human.", "fail");

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: () => new Promise(() => {}),
      }),
      error => error.name === "BlockedError",
      "The read is blocked."
    );
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const headless = markers.find(m => m.phase === "headless-extractor");
  is(headless.blockReason, "captcha", "The load marker says why it failed.");
  is(
    headless.outcome,
    "blocked by Cloudflare Turnstile (check failed)",
    "The load marker says in plain words who blocked it and how."
  );
  is(
    headless.color,
    "yellow",
    "A block is drawn as an outcome the caller handles, not an error."
  );
  is(
    headless.captchaType,
    "cf-turnstile",
    "The load marker names the captcha."
  );
  const detected = markers.find(m => m.phase === "captcha-detected");
  is(
    detected?.traceId,
    headless.traceId,
    "The captcha-detected marker is drawn on the blocked load's track."
  );
  is(
    detected.outcome,
    "Cloudflare Turnstile (widget shown), found by its frame reporting in",
    "The captcha-detected marker names the captcha and what it did first."
  );
  is(detected.color, "blue", "A captcha showing up is not an error.");

  const captchaMarkers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "CaptchaDetection"
  );
  ok(
    captchaMarkers.some(
      m =>
        m.provider === "Cloudflare Turnstile" &&
        m.eventLabel === "check failed" &&
        m.color === "yellow" &&
        m.hiddenBrowser === "true"
    ),
    "CaptchaDetection marks the verdict and that it was in a hidden browser."
  );
});

/**
 * A captcha widget is a frame inside the page it guards, so a page at a
 * widget's address, such as a provider's demo page, is read like any other.
 */
add_task(async function test_page_at_widget_address_is_read() {
  const result = await PageExtractorParent.getHeadlessExtractor({
    urlString: CAPTCHA_FRAME,
    callback: (pageExtractor, traceId) => pageExtractor.getText({}, traceId),
  });
  is(result.text, "", "The page is read, not taken for a bot check.");
});

/**
 * A profile tells, on the read's own track, how the bot check was found and
 * why the read was blocked: the page requests the widget's script, the read
 * waits for the widget, the widget's frame reports in, and the read finds
 * little text beside it.
 */
add_task(async function test_captcha_story_in_profile() {
  const { html } = MLTestUtils.serveHTML();
  const { url, cleanup } = html`
    <p>Checking your browser.</p>
    <script src=${CAPTCHA_LOADER}></script>
  `;

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: (pageExtractor, traceId) =>
          pageExtractor.getText({}, traceId),
      }),
      error => error.name === "BlockedError",
      "The read is blocked."
    );
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  ).filter(m => m.process === "parent");
  const load = markers.find(m => m.phase === "headless-extractor");
  const onTrack = phase =>
    markers.find(m => m.phase === phase && m.traceId === load.traceId);

  const script = onTrack("captcha-script");
  is(
    script?.outcome,
    "Cloudflare Turnstile",
    "The first sign of the bot check is the page requesting its script."
  );
  is(
    onTrack("captcha-wait")?.outcome,
    "it appeared",
    "The read waits for the widget, which appears."
  );
  is(
    onTrack("captcha-detected")?.detectedBy,
    "its frame reporting in",
    "The widget is found by its frame reporting in."
  );
  is(
    onTrack("get-text")?.outcome,
    `blocked by Cloudflare Turnstile (widget shown), only ${"Checking your browser.".length} characters on the page`,
    "The read says the page was only the bot check."
  );
  is(
    load.outcome,
    "blocked by Cloudflare Turnstile (widget shown)",
    "The load says who blocked it."
  );
  ok(
    [script, onTrack("captcha-wait"), onTrack("captcha-detected")].every(
      m => m.color === "blue"
    ),
    "Finding the bot check is not an error."
  );
});
