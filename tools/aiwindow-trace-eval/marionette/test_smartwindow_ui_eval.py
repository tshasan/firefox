# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Drives benchmark questions through the real Smart Window UI.

Every question gets a fresh AI Window. Source tabs are opened, attached with
the smartbar "+" menu and the question is typed and submitted with trusted
input events. Nothing in the chat path is stubbed: the bridge on
127.0.0.1:4318 supplies the model endpoint, receives the turn traces and
grades them.
"""

import json
import time
import urllib.request

from marionette_harness import MarionetteTestCase

BRIDGE = "http://127.0.0.1:4318"
# Marionette profile overrides that change Smart Window; cleared so the build's
# own defaults apply, as in a normal profile.
STOCK_PREFS = [
    "browser.ml.enable",
    "browser.translations.enable",
    "browser.urlbar.merino.endpointURL",
    "browser.urlbar.merino.ohttpConfigURL",
    "browser.urlbar.merino.ohttpRelayURL",
    "browser.urlbar.suggest.searches",
    "places.semanticHistory.featureGate",
    "services.settings.server",
]
GUEST_TOKEN = "local-eval-guest-token"

HELPERS = """
const waitFor = async (condition, message, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = condition();
      if (value) {
        return value;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + message);
};
const getWindow = id => {
  const win = Services.wm.getOuterWindowWithId(id);
  if (!win || win.closed) {
    throw new Error("Evaluation window is gone");
  }
  return win;
};
const aiWindows = win => {
  const docs = [];
  for (const tab of win.gBrowser.tabs) {
    docs.push(tab.linkedBrowser.contentDocument);
  }
  docs.push(win.document.getElementById("ai-window-browser")?.contentDocument);
  return docs
    .map(doc => doc?.querySelector("ai-window"))
    .filter(element => element?.shadowRoot);
};
const fullpageAIWindow = win =>
  win.gBrowser.selectedBrowser.contentDocument?.querySelector("ai-window");
const smartbarOf = aiWindow =>
  aiWindow.shadowRoot.querySelector("#ai-window-smartbar");
const clickTrusted = element => {
  element.scrollIntoView({ block: "center" });
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error("Element is not visible: " + element.localName);
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const view = element.ownerDocument.defaultView;
  view.synthesizeMouseEvent("mousedown", x, y, { button: 0, buttons: 1, clickCount: 1 });
  view.synthesizeMouseEvent("mouseup", x, y, { button: 0, buttons: 0, clickCount: 1 });
};
const keyboard = win => {
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(
    Ci.nsITextInputProcessor
  );
  if (!tip.beginInputTransactionForTests(win)) {
    throw new Error("Could not start a keyboard input transaction");
  }
  return tip;
};
"""

OPEN_WINDOW = (
    HELPERS
    + """
const [urls, loadTimeoutMs] = arguments;
return (async () => {
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const win = await BrowserWindowTracker.promiseOpenWindow({ aiWindow: true });
  await waitFor(
    () => win.document.documentElement.hasAttribute("ai-window"),
    "AI Window attribute"
  );
  win.focus();
  const aiTab = win.gBrowser.selectedTab;
  await waitFor(() => smartbarOf(fullpageAIWindow(win)), "Smart Window smartbar");
  const tabs = [];
  for (const url of urls) {
    const tab = win.gBrowser.addTrustedTab(url, { inBackground: true });
    const browser = tab.linkedBrowser;
    const loaded = await waitFor(
      () =>
        browser.currentURI.spec !== "about:blank" &&
        !browser.webProgress.isLoadingDocument &&
        tab.label &&
        !tab.hasAttribute("busy"),
      "page load: " + url,
      loadTimeoutMs
    ).catch(() => false);
    tabs.push({ url: browser.currentURI.spec, title: tab.label, loaded: !!loaded });
  }
  win.gBrowser.selectedTab = aiTab;
  await waitFor(() => smartbarOf(fullpageAIWindow(win)), "Smart Window smartbar");
  return { windowId: win.docShell.outerWindowID, tabs };
})();
"""
)

ATTACH_TAB = (
    HELPERS
    + """
const [windowId, label] = arguments;
return (async () => {
  const win = getWindow(windowId);
  const smartbar = smartbarOf(fullpageAIWindow(win));
  const button = smartbar
    .querySelector("context-icon-button")
    .shadowRoot.querySelector("moz-button");
  clickTrusted(button);
  const panel = smartbar
    .querySelector("smartwindow-panel-list")
    .shadowRoot.querySelector("panel-list");
  await waitFor(
    () =>
      panel.hasAttribute("open") &&
      panel.querySelector("panel-item:not(.panel-section-header)"),
    "context menu items"
  );
  const items = [...panel.querySelectorAll("panel-item:not(.panel-section-header)")];
  const labels = items.map(item => item.textContent.trim());
  const item = items.find(candidate => candidate.textContent.trim() === label);
  if (!item) {
    const tip = keyboard(smartbar.ownerDocument.defaultView);
    const escape = new smartbar.ownerDocument.defaultView.KeyboardEvent("", {
      key: "Escape",
      code: "Escape",
      keyCode: smartbar.ownerDocument.defaultView.KeyboardEvent.DOM_VK_ESCAPE,
    });
    tip.keydown(escape);
    tip.keyup(escape);
    return { attached: false, labels };
  }
  clickTrusted(item);
  await waitFor(() => !panel.hasAttribute("open"), "context menu closes", 5000).catch(
    () => {}
  );
  return { attached: true, labels };
})();
"""
)

SUBMIT = (
    HELPERS
    + """
const [windowId, text, keyDelayMs] = arguments;
return (async () => {
  const win = getWindow(windowId);
  win.focus();
  const aiWindow = fullpageAIWindow(win);
  const smartbar = smartbarOf(aiWindow);
  smartbar.inputField.focus();
  await waitFor(() => smartbar.matches(":focus-within"), "smartbar focus");
  const tip = keyboard(smartbar.ownerDocument.defaultView);
  for (const key of text) {
    const event = new smartbar.ownerDocument.defaultView.KeyboardEvent("", { key });
    tip.keydown(event);
    tip.keyup(event);
    await new Promise(resolve =>
      setTimeout(resolve, keyDelayMs * (0.6 + 0.8 * Math.random()))
    );
  }
  const cta = smartbar.querySelector("input-cta");
  let stableAction = null;
  let stableSince = Date.now();
  const settleDeadline = Date.now() + 15000;
  while (Date.now() < settleDeadline) {
    await smartbar.lastQueryContextPromise;
    const current = cta?.getAttribute("action");
    if (current !== stableAction) {
      stableAction = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 1500) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const chips = smartbar.querySelector(".smartbar-context-chips-header");
  const attached = (chips?.websites ?? []).map(site => site.url);
  const action = smartbar.querySelector("input-cta")?.getAttribute("action");
  const selected = smartbar.view?.getResultFromElement(smartbar.view.selectedElement);
  const view = {
    open: !!smartbar.view?.isOpen,
    selectedType: selected?.type ?? null,
    selectedHeuristic: selected?.heuristic ?? null,
    selectedProvider: selected?.providerName ?? null,
    smartbarAction: smartbar.smartbarAction,
  };
  if (action !== "chat") {
    return { action, attached, view, submitted: false };
  }
  const enter = new smartbar.ownerDocument.defaultView.KeyboardEvent("", {
    key: "Enter",
    code: "Enter",
    keyCode: smartbar.ownerDocument.defaultView.KeyboardEvent.DOM_VK_RETURN,
  });
  tip.keydown(enter);
  tip.keyup(enter);
  return { action, attached, view, submitted: true, submittedAt: Date.now() };
})();
"""
)

STATE = (
    HELPERS
    + """
const [windowId] = arguments;
const win = getWindow(windowId);
const windows = aiWindows(win);
return {
  generating: windows.some(element => element.isGenerating),
  conversationIds: windows
    .map(element => element.conversationId?.toString())
    .filter(Boolean),
  selectedUrl: win.gBrowser.selectedBrowser.currentURI.spec,
  blocked: win.gBrowser.tabs.some(tab => {
    const uri = tab.linkedBrowser.currentURI;
    return /(^|\\.)google\\./.test(uri.host) && uri.filePath.startsWith("/sorry/");
  }),
};
"""
)

FLUSH_AND_CLOSE = """
const [windowId] = arguments;
return (async () => {
  const { SmartWindowTrace } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/Trace.sys.mjs"
  );
  const exported = await SmartWindowTrace.flush();
  const win = Services.wm.getOuterWindowWithId(windowId);
  if (win && !win.closed) {
    const closed = new Promise(resolve =>
      win.addEventListener("unload", resolve, { once: true })
    );
    win.close();
    await closed;
  }
  return exported;
})();
"""

PREPARE = """
const [prefs, stock] = arguments;
return (async () => {
  for (const name of stock) {
    Services.prefs.clearUserPref(name);
  }
  for (const [name, value] of Object.entries(prefs)) {
    if (typeof value === "boolean") {
      Services.prefs.setBoolPref(name, value);
    } else if (typeof value === "number") {
      Services.prefs.setIntPref(name, value);
    } else {
      Services.prefs.setStringPref(name, value);
    }
  }
  const { RemoteSettings } = ChromeUtils.importESModule(
    "resource://services-settings/remote-settings.sys.mjs"
  );
  await RemoteSettings.pollChanges({ full: true, trigger: "manual" });
  // A returning user already has the smartbar intent model downloaded.
  const { IntentClassifier } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/IntentClassifier.sys.mjs"
  );
  await IntentClassifier.getPromptIntent("What is on this page?");
  return Services.appinfo.appBuildID;
})();
"""


def bridge(path, payload=None, timeout=600):
    request = urllib.request.Request(
        BRIDGE + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"} if payload is not None else {},
        method="GET" if payload is None else "POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        return json.loads(response.read())


class CaptchaBlocked(Exception):
    pass


class SmartbarWouldNotChat(Exception):
    pass


class TestSmartWindowUIEval(MarionetteTestCase):
    def setUp(self):
        super().setUp()
        self.config = bridge("/config")
        self.scenarios = bridge("/scenarios")
        self.session_prefs = {
            "browser.smartwindow.auth.guest.token": GUEST_TOKEN,
            "browser.smartwindow.auth.impl": "guest",
        }
        self.marionette.enforce_gecko_prefs({
            "browser.smartwindow.enabled": True,
            "browser.smartwindow.trace.enabled": True,
            "browser.smartwindow.tos.consentTime": int(time.time()),
            "browser.smartwindow.firstrun.hasCompleted": True,
            "browser.smartwindow.firstrun.modelChoice": "0",
            "browser.smartwindow.model": self.config["model"],
            "browser.smartwindow.customEndpoint": self.config["modelEndpoint"],
            "browser.smartwindow.apiKey": "local-evaluation",
            **self.session_prefs,
        })
        self.marionette.set_context("chrome")
        self.marionette.timeout.script = 900
        self.build_id = self.marionette.execute_script(
            PREPARE, script_args=[self.session_prefs, STOCK_PREFS]
        )

    def ask(self, scenario, repetition):
        timeout_s = self.config.get("scenarioTimeoutMs", 300000) / 1000
        record = {
            "driver": "ui",
            "runId": self.config["runId"],
            "model": self.config["model"],
            "scenarioId": scenario["id"],
            "repetition": repetition,
            "turnIndex": 0,
            "prompt": scenario["prompt"],
            "buildId": self.build_id,
            "error": None,
        }
        self.marionette.execute_script(
            PREPARE, script_args=[self.session_prefs, STOCK_PREFS]
        )
        opened = self.marionette.execute_script(
            OPEN_WINDOW,
            script_args=[[tab["url"] for tab in scenario["tabs"]], 60000],
        )
        window_id = opened["windowId"]
        record["tabs"] = [
            {"index": index, **tab} for index, tab in enumerate(opened["tabs"])
        ]
        try:
            menus = []
            for tab in opened["tabs"]:
                result = self.marionette.execute_script(
                    ATTACH_TAB, script_args=[window_id, tab["title"]]
                )
                menus.append({"title": tab["title"], **result})
            record["attachAttempts"] = menus
            submitted = self.marionette.execute_script(
                SUBMIT,
                script_args=[
                    window_id,
                    scenario["prompt"],
                    self.config.get("keyDelayMs", 100),
                ],
            )
            record["smartbarAction"] = submitted["action"]
            record["attachedUrls"] = submitted["attached"]
            record["smartbarView"] = submitted["view"]
            if not submitted["submitted"]:
                raise SmartbarWouldNotChat(submitted["action"])
            print(f"{scenario['id']}: submitted {json.dumps(submitted)}")
            print(f"{scenario['id']}: attach {json.dumps(menus)}")
            started = time.monotonic()
            seen_generating = False
            conversation_ids = []
            while True:
                state = self.marionette.execute_script(STATE, script_args=[window_id])
                if state["blocked"]:
                    raise CaptchaBlocked(state["selectedUrl"])
                conversation_ids = state["conversationIds"] or conversation_ids
                seen_generating = seen_generating or state["generating"]
                elapsed = time.monotonic() - started
                if seen_generating and not state["generating"]:
                    break
                if not seen_generating and elapsed > 30:
                    record["error"] = (
                        f"Turn never started (smartbar action {submitted['action']!r}, "
                        f"selected {state['selectedUrl']})"
                    )
                    break
                if elapsed > timeout_s:
                    record["error"] = "Turn timed out"
                    break
                time.sleep(1)
            record["elapsedMs"] = int((time.monotonic() - started) * 1000)
            record["conversationId"] = conversation_ids[0] if conversation_ids else None
        except CaptchaBlocked:
            raise
        except SmartbarWouldNotChat as action:
            record["error"] = (
                f"Smartbar would not chat: settled action {action}; Enter not pressed"
            )
        except Exception as error:
            record["error"] = f"Driver error: {error}"
        finally:
            record["traceExported"] = self.marionette.execute_script(
                FLUSH_AND_CLOSE, script_args=[window_id]
            )
        return record

    def test_benchmark(self):
        failures = []
        for repetition in range(1, self.config.get("repetitions", 1) + 1):
            for scenario in self.scenarios:
                try:
                    record = self.ask(scenario, repetition)
                except CaptchaBlocked as error:
                    failures.append(
                        f"{scenario['id']}: stopped the run, Google served a captcha: {error}"
                    )
                    self.fail("\n".join(failures))
                if not record.get("conversationId"):
                    failures.append(f"{scenario['id']}: {record['error']}")
                    continue
                try:
                    result = bridge("/results", record)
                    scores = {
                        score["name"]: score.get("score", score.get("error"))
                        for score in result["scores"]
                    }
                    print(f"{scenario['id']} r{repetition}: {json.dumps(scores)}")
                except Exception as error:
                    failures.append(
                        f"{scenario['id']}: bridge rejected result: {error}"
                    )
                if record["error"]:
                    failures.append(f"{scenario['id']}: {record['error']}")
        self.assertEqual(failures, [], "\n".join(failures))
