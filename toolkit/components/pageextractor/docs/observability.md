(pageextractor-observability)=

# Page Extractor observability

One extraction can cross the parent and content processes, run in several
stages, and depend on a site that behaves differently in a hidden browser. Page
Extractor records each instrumented stage as a Glean event and, while the
profiler runs, as a profiler marker, so you can investigate failures and
performance as one flow.

Each record includes the stage, process, outcome, strategy, and size
information. Nested stages
overlap, so do not add their durations together. A shared flow identifier
connects work across processes and between profiler and telemetry data.

## Investigate an extraction

1. Start the profiler from the toolbar button or `about:profiling`.
2. Run the extraction.
3. Look for `PageExtractor #n` tracks in the marker chart.

Markers are blue for success, red for unexpected errors, and yellow for outcomes
the caller handles, such as unavailable or empty content, or a page the site
blocked. Each marker's label says what happened in plain words, and its details
name the stage and strategy that produced the outcome. In a hidden browser, pass
the callback's `traceId` into `getText` so loading and extraction stay in the
same flow.

[Instrumenting JavaScript](/tools/profiler/instrumenting-javascript.md) explains
the profiler mechanism.

## Telemetry

Finished stages record `page_extractor.phase` events in the `page-extractor`
ping, subject to Glean collection settings. The event holds operational
information such as outcome, duration, strategy, and coarse size counts. It
holds no page text, URLs, image data, or error messages. The ping has no client
identifier and uses OHTTP.

When you analyze the events, pick the stage that represents the behavior you
are measuring. Counting every nested stage counts one failure more than once.
Group records by flow identifier to follow a request across processes.

The events module and the Glean metrics and pings definitions next to it define
the phases and fields. The design history is in
[bug 2065318](https://bugzilla.mozilla.org/show_bug.cgi?id=2065318) and
[bug 2058247](https://bugzilla.mozilla.org/show_bug.cgi?id=2058247).

## Bot checks

A headless load uses CaptchaDetection to notice a captcha in the page it
loaded. A puzzle, an outright refusal, or a failed check rejects the load at
once with a `BlockedError`. A widget that only loaded rejects the read when the
page has little text besides it. When the page has requested a captcha
provider's script, the read first waits briefly for the widget to appear, since
the script inserts it after a fast page can already be read. The error carries
`blockReason` (`captcha` or `off-site`), and for a captcha also `captchaType`
and `captchaEvent`, so a caller can explain the block without parsing the
message.

To count blocks, use the `headless-extractor` phase, which is recorded once per
load:

- `status` is `blocked` for a blocked load.
- `block_reason` says why: `captcha` or `off-site`.
- `captcha_type` names the provider and `captcha_event` its latest state. Both
  are also set on a load that was read despite a captcha, such as a passed check
  or a widget beside readable content.

The `get-text` phase records `captcha_wait_ms` when a read waited for a widget.
A wait of the full limit means the widget never appeared. The `captcha-detected`
phase records how long into the load CaptchaDetection first reported a captcha.
The profiler markers carry the same fields, and a blocked load's markers are
yellow and read, for example, "blocked by Cloudflare Turnstile (check failed)".
CaptchaDetection's own `CaptchaDetection` marker shows each captcha state
change, yellow when the check went against the visitor. Captchas in hidden
browsers are left out of the `captcha-detection` ping.

In a profile, a load's `PageExtractor #n` track tells how a bot check was
found, in order:

1. "Page requested a bot check's script": the first sign, before the widget
   exists.
2. "Bot check appeared on page": the widget showed up, and whether its frame
   reported in or its URL was spotted when the page was read.
3. "Bot check changed": each later state, such as a failed check.
4. "Wait for the bot check to appear": how long the read held off for a
   widget whose script the page requested.
5. "Extract page text" and "Load page in the background": the outcome, for
   example "blocked by Cloudflare Turnstile (widget shown), only 22
   characters on the page".

The `browser.ml.pageExtractor.captchaDetection.enabled` pref turns this
behavior off.
