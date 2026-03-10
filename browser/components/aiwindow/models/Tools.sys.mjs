/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * This file contains LLM tool abstractions and tool definitions.
 */

import { searchBrowsingHistory as implSearchBrowsingHistory } from "moz-src:///browser/components/aiwindow/models/SearchBrowsingHistory.sys.mjs";
import { PageExtractorParent } from "resource://gre/actors/PageExtractorParent.sys.mjs";
import {
  isAllowedUrl,
  truncateTitle,
} from "moz-src:///browser/components/aiwindow/models/ToolSanitizers.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  MemoriesManager:
    "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs",
  // @todo Bug 2009194
  // PageDataService:
  //   "moz-src:///browser/components/pagedata/PageDataService.sys.mjs",
});

const MAX_TABS = 15;
const MAX_HISTORY_RESULTS = 15;

const GET_OPEN_TABS = "get_open_tabs";
const SEARCH_BROWSING_HISTORY = "search_browsing_history";
const GET_PAGE_CONTENT = "get_page_content";
const RUN_SEARCH = "run_search";
const GET_USER_MEMORIES = "get_user_memories";

export const TOOLS = [
  GET_OPEN_TABS,
  SEARCH_BROWSING_HISTORY,
  GET_PAGE_CONTENT,
  RUN_SEARCH,
  GET_USER_MEMORIES,
];

export const toolsConfig = [
  {
    type: "function",
    function: {
      name: GET_OPEN_TABS,
      description:
        "Access the user's browser and return a list of the most recently browsed tabs. " +
        "Each tab is represented by a JSON with the page's url, title, and description " +
        "if available.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: SEARCH_BROWSING_HISTORY,
      description:
        "Retrieve pages from the user's past browsing history, optionally filtered by " +
        "topic and/or time range.",
      parameters: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description:
              "A concise phrase describing what the user is trying to find in their " +
              "browsing history (topic, site, or purpose).",
          },
          startTs: {
            type: "string",
            description:
              "Inclusive start of the time range as a local ISO 8601 datetime " +
              "('YYYY-MM-DDTHH:mm:ss', no timezone).",
          },
          endTs: {
            type: "string",
            description:
              "Inclusive end of the time range as a local ISO 8601 datetime " +
              "('YYYY-MM-DDTHH:mm:ss', no timezone).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: GET_PAGE_CONTENT,
      description:
        "Retrieve cleaned text content of all the provided browser page URLs in the list.",
      parameters: {
        type: "object",
        properties: {
          url_list: {
            type: "array",
            items: {
              type: "string",
              description:
                "The complete URL of the page to fetch content from. This must exactly match " +
                "a URL from the current conversation context. Use the full URL including " +
                "protocol (http/https). Example: 'https://www.example.com/article'.",
            },
            minItems: 1,
            description: "List of URLs to fetch content from.",
          },
        },
        required: ["url_list"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: RUN_SEARCH,
      description:
        "Perform a web search using the browser's default search engine and return " +
        "the search results page content. Use this when the user needs current web " +
        "information that would benefit from a live search.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query to execute. Should be specific and search-engine optimized.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: GET_USER_MEMORIES,
      description:
        'Retrieves all memories saved about the user to answer questions like "What do you know about me?", "What memories have you saved?", "What do you remember about me?", etc. Respond to the user that these are memories.',
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

/**
 * Retrieves a list of the latest open tabs from the current active browser window.
 * Only includes http/https tabs.
 * TODO: Ignores chat-only pages (FE to implement isSidebarMode flag).
 *
 * @param {object} _params
 * @param {object} _secProps
 * @returns {Array<object>}
 *  An array of tab metadata objects, each containing:
 *  - url {string}: The tab's current URL
 *  - title {string}: The tab's title
 *  - description {string}: Optional description (empty string if not available)
 *  - lastAccessed {number}: Last accessed timestamp in milliseconds
 *  Tabs are sorted by most recently accessed and limited to MAX_TABS results.
 */
export function getOpenTabs(_params, _secProps) {
  const tabs = [];

  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (!lazy.AIWindow.isAIWindowActive(win) || win.closed || !win.gBrowser) {
      continue;
    }

    for (const tab of win.gBrowser.tabs) {
      const url = tab.linkedBrowser?.currentURI?.spec;

      if (url && isAllowedUrl(url)) {
        tabs.push({
          url,
          title: truncateTitle(tab.label),
          lastAccessed: tab.lastAccessed,
        });
      }
    }
  }

  tabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

  // @todo Bug 2009194 — description requires PageDataService (currently broken).
  return tabs.slice(0, MAX_TABS).map(({ url, title, lastAccessed }) => ({
    url,
    title,
    description: "",
    lastAccessed,
  }));
}

/**
 * Tool entrypoint for search_browsing_history.
 *
 * Parameters (defaults shown):
 * - searchTerm: ""        - string used for search
 * - startTs: null         - local ISO timestamp lower bound, or null
 * - endTs: null           - local ISO timestamp upper bound, or null
 *
 * Detailed behavior and implementation are in SearchBrowsingHistory.sys.mjs.
 *
 * @param {object} toolParams
 *  The search parameters.
 * @param {string} toolParams.searchTerm
 *  The search string. If null or empty, semantic search is skipped and
 *  results are filtered by time range and sorted by last_visit_date and frecency.
 * @param {string|null} toolParams.startTs
 *  Optional local ISO-8601 start timestamp (e.g. "2025-11-07T09:00:00").
 * @param {string|null} toolParams.endTs
 *  Optional local ISO-8601 end timestamp (e.g. "2025-11-07T09:00:00").
 * @param {object} _secProps
 * @returns {Promise<object>}
 *  A promise resolving to an object with the search term and history results.
 *  Includes `count` when matches exist, a `message` when none are found, or an
 *  `error` string on failure.
 */
export async function searchBrowsingHistory(toolParams, _secProps) {
  const params =
    toolParams && typeof toolParams === "object" ? toolParams : {};

  const { searchTerm = "", startTs = null, endTs = null } = params;

  return implSearchBrowsingHistory({
    searchTerm,
    startTs,
    endTs,
    historyLimit: MAX_HISTORY_RESULTS,
  });
}

/**
 * Performs a web search using the browser's default search engine,
 * waits for the results page to load, and extracts its content.
 */
export class RunSearch {
  static NAVIGATION_TIMEOUT_MS = 15000;
  static CONTENT_SETTLE_MS = 2000;

  static #ensureTabSelected(tab) {
    if (!tab.selected) {
      tab.ownerGlobal.gBrowser.selectedTab = tab;
    }
  }

  /**
   * @param {object} toolParams
   * @param {string} toolParams.query
   * @param {object} [context]
   * @param {BrowsingContext} [context.browsingContext]
   * @param {object} _secProps
   * @returns {Promise<string>}
   */
  static async runSearch({ query }, context = {}, _secProps) {
    if (!query || typeof query !== "string" || !query.trim()) {
      return "Error: a non-empty search query is required.";
    }

    if (!context.browsingContext) {
      return "Error: no browsingContext provided to perform search.";
    }

    const win = context.browsingContext.topChromeWindow;
    if (!win || win.closed) {
      return "Error: associated browser window not available or closed.";
    }

    // Get the original tab from the browsing context, not the currently selected tab
    const originalBrowser = context.browsingContext.embedderElement;
    let targetTab =
      originalBrowser && win.gBrowser?.getTabForBrowser(originalBrowser);

    if (targetTab) {
      // Switch to the original tab if it's different from currently selected
      RunSearch.#ensureTabSelected(targetTab);
    } else {
      return "Error: Original tab no longer exists, aborting search to avoid interfering with existing conversation.";
    }

    // If the original tab is the AI Window page, move to sidebar first
    if (lazy.AIWindow.isAIWindowContentPage(originalBrowser.currentURI)) {
      await RunSearch.#moveToSidebarIfNeeded(win, targetTab);

      // Ensure we're still on the correct tab after the await
      RunSearch.#ensureTabSelected(targetTab);
    }

    RunSearch.#showSearchingIndicator(win, true, query.trim());

    try {
      await RunSearch.#performSearchAndWait(win, originalBrowser, query.trim());
      return RunSearch.#extractSerpContent(originalBrowser);
    } catch (e) {
      console.error("[RunSearch] search failed:", e);
      return `Error performing search for "${query}": ${e.message}`;
    } finally {
      RunSearch.#showSearchingIndicator(win, false, null);
    }
  }

  // TODO - this may be dead code. The fetch with history already yields a
  // searching state, and the sidebar implementation may not need this at all.
  // Revisit this in the future:
  // https://bugzilla.mozilla.org/show_bug.cgi?id=2016252 to find a more
  // concrete way to target what side bar needs to show the indicator, if any
  // at all. My guess is that this might be here because of the move to sidebar
  // implementation, and the indicator state does not "transfer over". Possibly
  // look into tapping into something more concrete like the conversation state
  // in the AIWindow store to trigger this kind of UI state instead of trying
  // to directly manipulate the sidebar UI from here.
  static #showSearchingIndicator(win, isSearching, searchQuery) {
    try {
      const sidebar = win.document.getElementById("ai-window-box");
      if (!sidebar) {
        return;
      }
      const aiBrowser = sidebar.querySelector("#ai-window-browser");
      if (!aiBrowser?.contentDocument) {
        return;
      }
      const aiWindow = aiBrowser.contentDocument.querySelector("ai-window");
      if (aiWindow?.showSearchingIndicator) {
        aiWindow.showSearchingIndicator(isSearching, searchQuery);
      }
    } catch {
      // Sidebar may not be available
    }
  }

  static async #moveToSidebarIfNeeded(win, tab) {
    await lazy.AIWindow.moveConversationToSidebar(win, tab);
  }

  /**
   * Navigates to the search results and waits for the page to finish loading.
   *
   * @param {Window} win
   * @param {XULElement} browser
   * @param {string} query
   */
  static async #performSearchAndWait(win, browser, query) {
    const navigationPromise = new Promise((resolve, reject) => {
      const timeout = lazy.setTimeout(() => {
        win.gBrowser.removeProgressListener(listener);
        reject(new Error("Navigation timed out"));
      }, RunSearch.NAVIGATION_TIMEOUT_MS);

      const listener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onStateChange(_webProgress, _request, stateFlags) {
          const complete =
            Ci.nsIWebProgressListener.STATE_STOP |
            Ci.nsIWebProgressListener.STATE_IS_NETWORK;
          if ((stateFlags & complete) === complete) {
            lazy.clearTimeout(timeout);
            win.gBrowser.removeProgressListener(listener);
            resolve();
          }
        },
        onLocationChange() {},
        onProgressChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
      };

      win.gBrowser.addProgressListener(listener);
    });

    await lazy.AIWindow.performSearch(query, win);
    await navigationPromise;

    // Allow JS rendering to settle
    await new Promise(r => lazy.setTimeout(r, RunSearch.CONTENT_SETTLE_MS));
  }

  static SERP_MAX_CHARS = 15000;

  static async #extractSerpContent(browser) {
    const windowContext = browser.browsingContext?.currentWindowContext;
    if (!windowContext) {
      return "Error: could not access search results page content.";
    }

    const url = browser.currentURI?.spec || "unknown";
    const pageExtractor = await windowContext.getActor("PageExtractor");

    return runExtraction(pageExtractor, {
      mode: "reader",
      label: url,
      maxLength: RunSearch.SERP_MAX_CHARS,
    });
  }
}

/**
 * Build a URL-to-tab lookup from all AI Windows.
 * Returns { byUrl: Map<string, tab>, byHost: Map<string, tab> }.
 *
 * @returns {{ byUrl: Map<string, object>, byHost: Map<string, object> }}
 */
function buildTabIndex() {
  const byUrl = new Map();
  const byHost = new Map();

  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (!lazy.AIWindow.isAIWindowActive(win) || win.closed || !win.gBrowser) {
      continue;
    }
    for (const tab of win.gBrowser.tabs) {
      const spec = tab?.linkedBrowser?.currentURI?.spec;
      if (!spec) {
        continue;
      }
      if (!byUrl.has(spec)) {
        byUrl.set(spec, tab);
      }
      try {
        const host = tab.linkedBrowser.currentURI.hostPort;
        if (!byHost.has(host)) {
          byHost.set(host, tab);
        }
      } catch {
        // no hostPort available
      }
    }
  }

  return { byUrl, byHost };
}

const EXTRACTION_MODES = {
  viewport(pe, opts) {
    return pe.getText({ ...opts, justViewport: true });
  },
  reader(pe, opts) {
    return pe.getReaderModeContent(opts);
  },
  full(pe, opts) {
    return pe.getText(opts);
  },
};

const MODE_LABELS = {
  viewport: "current viewport",
  reader: "reader mode",
  full: "full page",
};

/**
 * Shared extraction logic used by both GetPageContent and RunSearch.
 * Tries the primary mode, falls back to "full" when reader mode yields nothing.
 *
 * @param {object} pageExtractor
 * @param {object} options
 * @param {string} options.mode - "reader", "full", or "viewport"
 * @param {string} options.label - human-readable label for error messages
 * @param {number} options.maxLength
 * @returns {Promise<string>}
 */
export async function runExtraction(
  pageExtractor,
  { mode = "reader", label = "", maxLength = 10000 } = {}
) {
  const selectedMode = EXTRACTION_MODES[mode] ? mode : "reader";

  const extractionOptions = {
    normalizeWhitespace: true,
    maxLength,
    sufficientLength: maxLength,
    justViewport: false,
  };

  let extraction = null;
  try {
    extraction = await EXTRACTION_MODES[selectedMode](
      pageExtractor,
      extractionOptions
    );
  } catch (err) {
    console.error("[SmartWindow] extraction mode failed", selectedMode, err);
  }

  let actualMode = selectedMode;

  if (!extraction && selectedMode === "reader") {
    try {
      extraction = await EXTRACTION_MODES.full(
        pageExtractor,
        extractionOptions
      );
      if (extraction) {
        actualMode = "full";
      }
    } catch (err) {
      console.error("[SmartWindow] extraction fallback failed", err);
    }
  }

  if (!extraction?.text) {
    return `get_page_content(${selectedMode}) returned no content for ${label}.`;
  }

  const wasTruncated = extraction.text.length >= maxLength;
  const truncationMarker = wasTruncated ? "\u2026" : "";
  let result = `Content (${MODE_LABELS[actualMode]}) from ${label}:\n\n${extraction.text}${truncationMarker}`;
  if (extraction.links?.length) {
    result += `\n\nLinks found on page:\n${extraction.links.join("\n")}`;
  }
  return result;
}

/**
 * Class for handling page content extraction with configurable modes and limits.
 */
export class GetPageContent {
  static DEFAULT_MODE = "reader";
  static MAX_CHARACTERS = 10000;

  /**
   * Tool entrypoint for get_page_content.
   *
   * @param {object} toolParams
   * @param {string[]} toolParams.url_list
   * @param {Set<string>} allowedUrls
   * @param {object} securityProperties - Security flags from the conversation.
   * @param {boolean} [securityProperties.untrusted_input]
   * @param {boolean} [securityProperties.private_data]
   * @returns {Promise<Array<string>>}
   */
  static async getPageContent(
    { url_list },
    allowedUrls = new Set(),
    securityProperties = {}
  ) {
    if (!Array.isArray(url_list)) {
      throw new Error("getPageContent now requires { url_list: [...] }");
    }

    // Build the tab index once for all URLs
    const tabIndex = buildTabIndex();

    const promises = url_list.map(url =>
      GetPageContent.#processSingleURL(
        url,
        allowedUrls,
        securityProperties,
        tabIndex
      )
    );

    return Promise.all(promises);
  }

  /**
   * @param {string} url
   * @param {Set<string>} allowedUrls
   * @param {object} securityProperties
   * @param {{ byUrl: Map<string, object>, byHost: Map<string, object> }} tabIndex
   * @returns {Promise<string>}
   */
  static async #processSingleURL(
    url,
    allowedUrls,
    securityProperties,
    tabIndex
  ) {
    try {
      if (!allowedUrls.has(url)) {
        //  Bug 2006418  - This will load the page headlessly, and then extract the content.
        // It might be a better idea to have the lifetime of the page be tied to the chat
        // while it's open, and with a "keep alive" timeout. For now it's simpler to just
        // load the page fresh every time.
        if (
          Services.prefs.getBoolPref(
            "browser.smartwindow.checkSecurityFlags",
            true
          ) &&
          securityProperties.untrusted_input &&
          securityProperties.private_data
        ) {
          return `get_page_content is not available for ${url} when the conversation involves both untrusted input and private data.`;
        }
        return PageExtractorParent.getHeadlessExtractor(url, pageExtractor =>
          runExtraction(pageExtractor, {
            mode: GetPageContent.DEFAULT_MODE,
            label: url,
            maxLength: GetPageContent.MAX_CHARACTERS,
          })
        );
      }

      // Look up the tab from the prebuilt index
      let targetTab = tabIndex.byUrl.get(url) || null;

      // Fallback: hostname match for protocol differences
      if (!targetTab) {
        try {
          const host = new URL(url).host;
          targetTab = tabIndex.byHost.get(host) || null;
        } catch {
          // Invalid URL
        }
      }

      if (!targetTab) {
        return `Cannot find URL: ${url}, page content extraction failed.`;
      }

      const currentWindowContext =
        targetTab.linkedBrowser.browsingContext?.currentWindowContext;

      if (!currentWindowContext) {
        return `Cannot access content from "${targetTab.label}" at ${url}.`;
      }

      const pageExtractor =
        await currentWindowContext.getActor("PageExtractor");

      return runExtraction(pageExtractor, {
        mode: GetPageContent.DEFAULT_MODE,
        label: `"${targetTab.label}" (${url})`,
        maxLength: GetPageContent.MAX_CHARACTERS,
      });
    } catch (error) {
      // Bug 2006425 - Decide on the strategy for error handling in tool calls
      console.error(error);
      return `Error retrieving content from ${url}.`;
    }
  }
}

export async function getUserMemories(_toolParams, _secProps) {
  const memories = await lazy.MemoriesManager.getAllMemories();

  return memories.map(memory => memory.memory_summary);
}
