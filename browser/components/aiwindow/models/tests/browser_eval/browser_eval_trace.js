/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(2000);

const evalMetadata = {
  owner: "Smart Window",
  name: "Smart Window traced scenarios",
  description:
    "Runs dataset questions through Smart Window and reports trace-linked scores.",
  test: "mochitest",
  options: {
    default: {
      manifest: "eval.toml",
      manifest_flavor: "browser-chrome",
      evaluations: {
        RecordedScores: { shouldAlert: false },
      },
      output: "artifacts/aiwindow-trace-eval/eval-output",
      perfherder: true,
    },
  },
};

const { runTraceEvaluation } = ChromeUtils.importESModule(
  "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/tests/trace.sys.mjs"
);

add_task(
  {
    skip_if: () =>
      !Services.prefs.getBoolPref("browser.smartwindow.trace.eval", false),
  },
  async function trace_live_model_scenarios() {
    await runTraceEvaluation({
      Assert,
      SpecialPowers,
      setupEvaluation,
      reportEvalResult,
      registerCleanupFunction,
      info,
      gBrowser,
      document,
    });
  }
);
