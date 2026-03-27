/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  getSecurityOrchestrator:
    "chrome://global/content/ml/security/SecurityOrchestrator.sys.mjs",
  SmartWindowTelemetry:
    "moz-src:///browser/components/aiwindow/ui/modules/SmartWindowTelemetry.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
});

/**
 * JSWindowActor to pass data between AIChatContent singleton and content pages.
 *
 * Handles:
 * - Message routing between ai-window and ai-chat-content
 * - Conversation ID tracking for security ledger access
 * - Push-based trusted URL updates to child
 */
export class AIChatContentParent extends JSWindowActorParent {
  /**
   * The session ledger for the current conversation.
   * Stored for EventTarget listener management and direct access.
   *
   * @type {SessionLedger|null}
   */
  #sessionLedger = null;

  /**
   * Counter to detect superseded #setConversation calls.
   * Prevents stale async calls from attaching listeners to wrong ledgers.
   *
   * @type {number}
   */
  #setConversationGeneration = 0;

  /**
   * Tracks the last ledger generation sent to the child.
   * Compared against SessionLedger.generation to avoid resending
   * unchanged URL arrays on every streaming chunk.
   *
   * @type {number}
   */
  #lastSentGeneration = -1;

  /**
   * Promise for the most recent #setConversation call.
   * Allows callers to await an in-flight bind rather than starting a
   * redundant one (e.g. when onCreateNewChatClick fires setConversation
   * and the user submits before it resolves).
   *
   * @type {Promise<void>|null}
   */
  #ledgerReady = null;

  /**
   * @returns {SessionLedger|null}
   */
  get sessionLedger() {
    return this.#sessionLedger;
  }

  /**
   * @returns {Promise<void>|null}
   */
  get ledgerReady() {
    return this.#ledgerReady;
  }

  dispatchMessageToChatContent(message) {
    message = Object.assign({}, message);
    delete message.pageUrl;

    const checkSecurity = Services.prefs.getBoolPref(
      "browser.smartwindow.checkSecurityFlags",
      true
    );

    if (checkSecurity && this.#sessionLedger) {
      const currentGen = this.#sessionLedger.generation;
      if (currentGen !== this.#lastSentGeneration) {
        const merged = this.#sessionLedger.mergeAll();
        message.trustedUrls = merged.getAllUrls();
        this.#lastSentGeneration = currentGen;
      }
    }

    this.sendAsyncMessage("AIChatContent:DispatchMessage", message);
  }

  dispatchTruncateToChatContent(payload) {
    this.sendAsyncMessage("AIChatContent:TruncateConversation", payload);
  }

  dispatchRemoveAppliedMemoryToChatContent(payload) {
    this.sendAsyncMessage("AIChatContent:RemoveAppliedMemory", payload);
  }

  /**
   * Sets the current conversation for security ledger tracking.
   *
   * Called directly by ai-window when a conversation is opened or changed.
   * Subscribes to ledger changes and pushes initial trusted URLs to child.
   *
   * @param {string|null} conversationId - The conversation identifier
   * @returns {Promise<void>}
   */
  setConversation(conversationId) {
    this.#ledgerReady = this.#setConversation(conversationId);
    return this.#ledgerReady;
  }

  /**
   * Seeds a mentioned URL into the security ledger.
   *
   * Called by ai-window at submission time when the user's message
   * includes @mentioned tabs. This represents explicit user consent
   * to trust the URL.
   *
   * @param {string} conversationId - Conversation to seed into
   * @param {string} url - URL to seed as trusted
   */
  seedMentionedUrl(conversationId, url) {
    this.#handleSeedMentionedUrl({ conversationId, url });
  }

  receiveMessage({ data, name }) {
    switch (name) {
      case "aiChatContentActor:search":
        this.#handleSearchFromChild(data);
        break;

      case "aiChatContentActor:followUp":
        this.#handleFollowUpFromChild(data);
        break;

      case "AIChatContent:Ready":
        this.#notifyContentReady();
        break;

      case "AIChatContent:DispatchNewChat":
        this.#handleNewChat();
        break;

      case "aiChatContentActor:footer-action":
        this.#handleFooterActionFromChild(data);
        break;

      case "AIChatContent:OpenLink":
        this.#handleOpenLink(data);
        break;

      case "AIChatContent:AccountSignIn":
        this.#handleAccountSignIn();
        break;

      default:
        console.warn(`AIChatContentParent received unknown message: ${name}`);
        break;
    }
    return undefined;
  }

  /**
   * Cleans up ledger subscription and state on actor destruction.
   */
  didDestroy() {
    this.#unsubscribeLedger();
  }

  /**
   * Clears the ledger reference and resets generation tracking.
   * Called when conversation changes or actor is destroyed.
   */
  #unsubscribeLedger() {
    if (this.#sessionLedger) {
      this.#sessionLedger = null;
      this.#lastSentGeneration = -1;
    }
  }

  #notifyContentReady() {
    const aiWindow = this.#getAIWindowElement();
    aiWindow?.onContentReady();
  }

  #handleSearchFromChild(data) {
    try {
      const { topChromeWindow } = this.browsingContext;
      lazy.AIWindow.performSearch(data, topChromeWindow);
    } catch (e) {
      console.warn("Could not perform search from AI Window chat", e);
    }
  }

  #handleFooterActionFromChild(data) {
    try {
      const aiWindow = this.#getAIWindowElement();
      aiWindow.handleFooterAction(data);
    } catch (e) {
      console.warn("Could not handle footer action from AI Window chat", e);
    }
  }

  #handleOpenLink(data) {
    const aiWindow = this.#getAIWindowElement();
    aiWindow?.onOpenLink();

    try {
      const { url } = data;
      if (!url) {
        return;
      }

      const uri = Services.io.newURI(url);
      if (uri.scheme !== "http" && uri.scheme !== "https") {
        return;
      }

      const window = this.browsingContext.topChromeWindow;

      if (!window) {
        return;
      }

      lazy.SmartWindowTelemetry.recordUriLoad();
      const currentPageURL = window.gBrowser.selectedBrowser.currentURI.spec;

      // Only treat it as "same link" if the URL is identical.
      // If anything differs (hash/query/path), let normal navigation proceed.
      if (url === currentPageURL) {
        lazy.AIWindowUI.handleSameLinkClick(window);
        return;
      }

      const { userContextId } =
        window.gBrowser.selectedBrowser.browsingContext.originAttributes;
      const triggeringPrincipal =
        Services.scriptSecurityManager.createNullPrincipal({ userContextId });
      const where = lazy.BrowserUtils.whereToOpenLink(data);

      if (where === "current") {
        const tabFound = lazy.URILoadingHelper.switchToTabHavingURI(
          window,
          url,
          false,
          {}
        );
        if (tabFound) {
          return;
        }
      }

      lazy.URILoadingHelper.openWebLinkIn(window, url, where, {
        triggeringPrincipal,
        userContextId,
        forceForeground: false,
      });
    } catch (e) {
      console.warn("Could not open link from AI Window chat", e);
    }
  }

  async #handleAccountSignIn() {
    const browser = this.browsingContext.topChromeWindow.gBrowser;
    const success = await lazy.AIWindow.launchSignInFlow(browser);
    if (success) {
      this.#handleRetryAfterError();
    }
  }

  #handleRetryAfterError() {
    try {
      const aiWindow = this.#getAIWindowElement();
      aiWindow.handleFooterAction({ action: "retry-after-error" });
    } catch (e) {
      console.warn("Could not handle Retry from AI Window chat", e);
    }
  }

  #handleNewChat() {
    try {
      const aiWindow = this.#getAIWindowElement();
      aiWindow.onCreateNewChatClick();
    } catch (e) {
      console.warn("Could not open new Smart Window chat", e);
    }
  }

  #getAIWindowElement() {
    const browser = this.browsingContext.embedderElement;
    const root = browser?.getRootNode?.();
    if (root?.host?.localName === "ai-window") {
      return root.host;
    }
    return browser?.ownerDocument?.querySelector("ai-window") ?? null;
  }

  #handleFollowUpFromChild(data) {
    try {
      const aiWindow = this.#getAIWindowElement();
      aiWindow.onQuickPromptClicked(data.text, false);
    } catch (e) {
      console.warn("Could not submit follow-up from AI Window chat", e);
    }
  }

  /**
   * Sets the current conversation and subscribes to ledger changes.
   *
   * Unsubscribes from previous ledger before subscribing to new one.
   * Uses a generation counter to discard stale calls after await.
   * Pushes initial trusted URL state after subscribing to cover any
   * change events missed during the async gap.
   *
   * @param {string|null} conversationId - The conversation identifier
   */
  async #setConversation(conversationId) {
    this.#unsubscribeLedger();
    const generation = ++this.#setConversationGeneration;

    if (!conversationId) {
      return;
    }

    try {
      const orchestrator = await lazy.getSecurityOrchestrator();

      if (generation !== this.#setConversationGeneration) {
        return;
      }

      this.#sessionLedger = orchestrator.registerSession(conversationId);
      this.#lastSentGeneration = -1;
    } catch (e) {
      console.warn("Failed to set conversation for security ledger:", e);
    }
  }

  /**
   * Handles seeding a mentioned URL into the conversation ledger.
   *
   * Called at submission time when the user's message includes @mentions.
   * The seeded URLs will be picked up by the next dispatchMessageToChatContent
   * call via the generation counter.
   *
   * @param {object} data - Seed request data
   * @param {string} data.conversationId - Conversation to seed into
   * @param {string} data.url - URL to seed
   */
  async #handleSeedMentionedUrl({ conversationId, url }) {
    if (!conversationId || !url) {
      return;
    }

    try {
      const orchestrator = await lazy.getSecurityOrchestrator();
      const sessionLedger = orchestrator.registerSession(conversationId);
      sessionLedger.seedConversation([url]);
    } catch (e) {
      console.warn("Failed to seed mentioned URL:", e);
    }
  }
}
