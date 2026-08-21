/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { GetTextOptions, CanvasSnapshot, DOMExtractionResult, ExtractionResult, PageMetadata, ReaderModeDocument } from './PageExtractor.d.ts'
 * @import { PageExtractorParent } from './PageExtractorParent.sys.mjs'
 */

/**
 * We wait for the page to be ready before extracting content headlessly. It's hard
 * to know when a page is "ready", however the strategy here is to wait for
 * DOMContentLoaded, and then a requestIdleCallback. This way the page has time
 * to do an initial amount of work. However, if we wait too long, it will be felt by
 * the user as lag. To mitigate this, wait for at least 2 seconds for the page to settle.
 */
const MAX_REQUEST_IDLE_CALLBACK_DELAY_MS = 2000;

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  resolveMaxCanvasDimension,
  resolveCanvasQuality,
} from "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  console: () =>
    console.createInstance({
      prefix: "PageExtractorChild",
      maxLogLevelPref: "browser.ml.logLevel",
    }),
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  extractTextFromDOM:
    "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs",
  shouldExtractYouTube:
    "moz-src:///toolkit/components/pageextractor/YouTubeExtraction.sys.mjs",
  getYouTubeContent:
    "moz-src:///toolkit/components/pageextractor/YouTubeExtraction.sys.mjs",
  PageExtractorEvent:
    "moz-src:///toolkit/components/pageextractor/PageExtractorEvents.sys.mjs",
  showDebugLayoutOverlay:
    "moz-src:///toolkit/components/pageextractor/DebugLayoutOverlay.sys.mjs",
  clearDebugLayoutOverlay:
    "moz-src:///toolkit/components/pageextractor/DebugLayoutOverlay.sys.mjs",
  getHoveredDebugBlock:
    "moz-src:///toolkit/components/pageextractor/DebugLayoutOverlay.sys.mjs",
  isProbablyReaderable: "resource://gre/modules/Readerable.sys.mjs",
  youtubeTimeoutMs: {
    pref: "browser.pageextractor.youtube.timeoutMs",
    default: 3000,
  },
});

/**
 * Extract a variety of content from pages for use in a smart window.
 */
export class PageExtractorChild extends JSWindowActorChild {
  /**
   * Route the messages coming from the parent process.
   *
   * @param {object} message
   * @param {string} message.name
   * @param {any} message.data
   *
   * @returns {Promise<unknown>}
   */
  async receiveMessage({ name, data }) {
    switch (name) {
      case "PageExtractorParent:GetText": {
        const { options, flowId } = data;
        await this.waitForPageReady(flowId);
        return this.getText(options, flowId);
      }
      case "PageExtractorParent:WaitForPageReady":
        return this.waitForPageReady(data?.flowId);
      case "PageExtractorParent:GetPageMetadata":
        return this.#getPageMetadata(data?.flowId);
      case "PageExtractorParent:ClearDebugOverlay":
        return this.#clearDebugOverlay();
      case "PageExtractorParent:GetHoveredDebugBlock":
        return this.#getHoveredDebugBlock();
    }
    return Promise.reject(new Error("Unknown message: " + name));
  }

  /**
   * Debug-only: removes the live-tracking highlight overlay a prior
   * getText({ _debugLayout: true }) call left showing, if any.
   */
  #clearDebugOverlay() {
    if (this.document) {
      lazy.clearDebugLayoutOverlay(this.document);
    }
  }

  /**
   * Debug-only: the block currently under the mouse in the debug overlay,
   * for a devtools panel to poll and display in full (untruncated).
   */
  #getHoveredDebugBlock() {
    return this.document ? lazy.getHoveredDebugBlock(this.document) : null;
  }

  /**
   * Resolves after DOMContentLoaded, an idle callback, and a double
   * requestAnimationFrame so layout and paint are committed before
   * extraction reads page geometry.
   *
   * @param {string | undefined} flowId
   * @returns {Promise<{ status: string }>}
   */
  async waitForPageReady(flowId) {
    const event = this.#startEvent("wait-for-ready", { flowId });
    const doc = this.document;
    const win = doc.documentGlobal;
    try {
      if (doc.readyState == "loading") {
        await new Promise(resolve => {
          doc.addEventListener("DOMContentLoaded", resolve, { once: true });
        });
      } else {
        lazy.console.log("The page is already interactive");
      }

      await new Promise(resolve => {
        win.requestIdleCallback(resolve, {
          timeout: MAX_REQUEST_IDLE_CALLBACK_DELAY_MS,
        });
      });

      const wasHidden = doc.hidden;
      if (!wasHidden) {
        await new Promise(resolve => {
          win.requestAnimationFrame(() => win.requestAnimationFrame(resolve));
        });
      }

      const status = wasHidden ? "document-hidden" : "success";
      event.finish({ status });
      return { status };
    } catch (error) {
      event.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }

  /**
   * @param {string | undefined} flowId
   * @returns {Promise<{ result: PageMetadata, eventData: { strategy: string } }>}
   */
  async #getPageMetadata(flowId) {
    const event = this.#startEvent("get-page-metadata", { flowId });
    try {
      let result;
      let strategy;
      if (this.isAboutReader()) {
        const document = this.browsingContext?.window?.document;
        const extraction = await this.getText(
          { removeBoilerplate: true },
          flowId
        );
        const text = extraction?.result?.text ?? "";
        const language = document?.querySelector(".container")?.lang ?? "";
        result = {
          structuredDataTypes: [],
          wordCount: this.#getWordCount(language, text),
          language,
          isReaderable: true,
        };
        strategy = "about-reader";
      } else {
        result = await this.getPageMetadata();
        strategy = "dom";
      }
      event.addData({ strategy });
      event.finish({ status: "success" });
      return { result, eventData: { strategy } };
    } catch (error) {
      event.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }

  /**
   * @see PageExtractorParent#getPageMetadata for docs
   *
   * @returns {Promise<PageMetadata>}
   */
  async getPageMetadata() {
    const document = this.browsingContext?.window?.document;

    if (!document) {
      return Promise.reject(
        new Error("No document available for page metadata extraction.")
      );
    }

    const structuredDataTypes = this.#extractStructuredDataTypes(document);
    const language = this.#detectLanguage(document);
    const wordCount = this.#getWordCount(language, document.body.innerText);
    const isReaderable = lazy.isProbablyReaderable(document);

    return { structuredDataTypes, wordCount, language, isReaderable };
  }

  /**
   * This will establish a word count of the text argument based on the provided language.
   *
   * @param {string} language
   * @param {string} text
   * @returns {number}
   */
  #getWordCount(language, text) {
    let wordCount = 0;
    const segmenter = new Intl.Segmenter(language || undefined, {
      granularity: "word",
    });
    for (const { isWordLike } of segmenter.segment(text)) {
      if (isWordLike) {
        wordCount++;
      }
    }
    return wordCount;
  }

  /**
   * This extracts various `@type` values within the JSON-LD structured data markup of a page.
   *
   * @param {Document} document
   * @returns {string[]}
   */
  #extractStructuredDataTypes(document) {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json" i]'
    );
    const types = new Set();

    const asArray = value => {
      if (Array.isArray(value)) {
        return value;
      }
      return value == null ? [] : [value];
    };

    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }

      // JSON-LD can be:
      // - an object
      // - an array of objects
      // - an object with @graph: [...]
      const topLevelItems = asArray(parsed);
      const graphItems = topLevelItems.flatMap(x => asArray(x?.["@graph"]));
      const items = graphItems.length ? graphItems : topLevelItems;

      for (const item of items) {
        for (const t of asArray(item?.["@type"])) {
          if (typeof t === "string") {
            types.add(t);
          }
        }
      }
    }

    return Array.from(types);
  }

  /**
   * Query the lang tag of the document.
   *
   * @param {Document} document
   * @returns {string}
   */
  #detectLanguage(document) {
    const declared = document?.documentElement?.lang;
    if (declared) {
      try {
        return new Intl.Locale(declared).baseName;
      } catch {
        return "";
      }
    }
    return "";
  }

  /**
   * @see PageExtractorParent#getText for docs
   *
   * @param {GetTextOptions} options
   * @param {string | undefined} flowId
   * @returns {Promise<{ result: ExtractionResult, eventData: { strategy: string, siteStrategy: string | undefined } } | null>}
   */
  async getText(options = {}, flowId) {
    const event = this.#startEvent("get-text", {
      flowId,
      options,
      strategy: "dom",
    });
    let strategy = "dom";
    let siteStrategy;
    const window = this.browsingContext?.window;
    /** @type {Document} */
    let document = window?.document;
    /** @type {HTMLElement} */
    let rootNode;

    // YouTube extraction is a best-effort enhancement: any failure is logged
    // and degrades to an empty string so the generic page extraction is used.
    let youtubeContentPromise = null;
    const sourceUrl = URL.parse(options.sourceUrl);
    if (lazy.shouldExtractYouTube(sourceUrl)) {
      youtubeContentPromise = this.#getYouTubeContentWithEvents(
        document,
        sourceUrl,
        options,
        event.flowId
      );
    }

    if (this.isAboutReader()) {
      strategy = "about-reader";
      event.addData({ strategy });
      // If about:reader is loaded, find the proper rootNode so that we just get the
      // content and not any of the UI. This will get passed to DOMExtractor so that
      // the rest of the GetTextOptions can be applied.

      lazy.console.log("Extracting content from about:reader");
      // TODO - Explain what's different between this document and the browsing context.
      document = this.manager.contentWindow.document;

      if (!document) {
        lazy.console.log("No content document was available");
        event.finish({ status: "unavailable" });
        return null;
      }

      /** @type {HTMLElement?} */
      rootNode = document.querySelector(".container");
      if (!rootNode) {
        lazy.console.log("No container was found in reader mode.");
        event.finish({ status: "unavailable" });
        return null;
      }
    } else if (options.removeBoilerplate) {
      // Boilerplate removal is requested. See if reader mode can be applied, and then
      // use that for boilerplate removal.

      if (
        (document && lazy.isProbablyReaderable(document)) ||
        options._forceRemoveBoilerplate
      ) {
        // Run the document through reader mode, and use the DOMParser version of the
        // content.
        const readerModeDocument = await this.#parseReaderDocument(
          document,
          event.flowId
        );
        if (readerModeDocument) {
          strategy = "reader";
          event.addData({ strategy });
          lazy.console.log("Document is readerable");
          const outputEvent = this.#startEvent("reader-output-parse", {
            flowId: event.flowId,
            strategy,
          });
          document = new DOMParser().parseFromString(
            readerModeDocument.content,
            "text/html"
          );
          outputEvent.finish({ status: "success" });
          rootNode = document.body;
        } else {
          lazy.console.log(
            "Document is not readerable, boilerplate will not be removed"
          );
        }
      } else {
        lazy.console.log(
          "Document is not readerable, boilerplate will not be removed"
        );
      }
    }

    if (!document || !rootNode) {
      lazy.console.log("Extracting content without boilerplate removal.");
      // No document or no root node is here, we should use the default extraction
      // strategy, of getting content directly from the hpage.
      document = window?.document;
      rootNode = document.body;
    }

    if (!document) {
      lazy.console.log("No document was found.");
      event.finish({ status: "unavailable" });
      return null;
    }

    // All of the content gets extracted using the DOMExtractor, which knows how
    // to apply certain settings in GetTextOptions.
    const extraction = this.#extractFromDOM(
      document,
      rootNode,
      options,
      event.flowId,
      strategy
    );
    const { text, links, canvases, debugBlocks } = extraction;
    // "default" means no site-specific strategy applied; only surface the
    // named ones (e.g. "google-search", "youtube") on the top-level event.
    if (extraction.siteStrategy && extraction.siteStrategy !== "default") {
      siteStrategy = extraction.siteStrategy;
      event.addData({ siteStrategy });
    }

    let canvasSnapshots = [];
    if (options.includeCanvasSnapshots && canvases.length) {
      canvasSnapshots = await this.#captureCanvases(
        canvases,
        options,
        event.flowId
      );
    }

    if (debugBlocks?.length && this.document) {
      // Uses the live document rather than the local `document`, which the
      // reader-mode path above may have reassigned to a detached
      // DOMParser().parseFromString() result with no defaultView.
      lazy.showDebugLayoutOverlay(this.document, debugBlocks).catch(error => {
        lazy.console.debug("Failed to show PageExtractor debug overlay", error);
      });
    }

    // On YouTube a transcript block replaces the generic walk. Without
    // a transcript the generic walk is kept (so comments and other page content
    // survive) and the clean metadata block (header fields + description), which
    // that walk only captures noisily and truncated, is prepended to it.
    const youtube = youtubeContentPromise ? await youtubeContentPromise : null;
    let finalText = text;
    if (youtube?.text) {
      finalText = youtube.replacesContent
        ? youtube.text
        : [youtube.text, text].filter(Boolean).join("\n\n");
      strategy = youtube.replacesContent ? "youtube-transcript" : "youtube-dom";
      event.addData({ strategy });
    }

    lazy.console.log("GetText", options);
    lazy.console.debug({ text: finalText, links, canvasSnapshots });

    event.finish({
      status: "success",
      textLength: finalText.length,
      linkCount: links.length,
      canvasCount: canvasSnapshots.length,
    });
    return {
      result: {
        text: finalText,
        links,
        canvasSnapshots,
        // Mirrors eventData below (used for the caller's own telemetry
        // bookkeeping) so debug tooling can see which strategy actually
        // ran without needing its own copy of getStrategyForUrl()'s
        // sourceUrl-matching logic.
        strategy,
      },
      eventData: { strategy, siteStrategy },
    };
  }

  /**
   * @param {Document} document
   * @param {URL} sourceUrl
   * @param {GetTextOptions} options
   * @param {string | undefined} flowId
   * @returns {Promise<{ text: string, replacesContent: boolean }>}
   */
  async #getYouTubeContentWithEvents(document, sourceUrl, options, flowId) {
    const event = this.#startEvent("youtube-extract", {
      flowId,
      strategy: "youtube",
    });
    try {
      const result = await lazy.getYouTubeContent(document, {
        timeoutMs: lazy.youtubeTimeoutMs,
        sufficientLength: options.sufficientLength,
        currentVideoId: sourceUrl.searchParams.get("v"),
      });
      event.finish({
        status: result.text ? "success" : "empty",
        textLength: result.text.length,
      });
      return result;
    } catch (error) {
      event.finish({ status: "error", errorName: error.name });
      lazy.console.warn?.("Failed to extract YouTube content", error);
      return { text: "", replacesContent: false };
    }
  }

  /**
   * @param {Document} document
   * @param {string | undefined} flowId
   * @returns {Promise<ReaderModeDocument | null>}
   */
  async #parseReaderDocument(document, flowId) {
    const event = this.#startEvent("reader-parse", {
      flowId,
      strategy: "reader",
    });
    try {
      const result = await lazy.ReaderMode.parseDocument(document);
      event.finish({ status: result ? "success" : "unavailable" });
      return result;
    } catch (error) {
      event.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }

  /**
   * @param {Document} document
   * @param {HTMLElement} rootNode
   * @param {GetTextOptions} options
   * @param {string | undefined} flowId
   * @param {string | undefined} strategy
   * @returns {DOMExtractionResult}
   */
  #extractFromDOM(document, rootNode, options, flowId, strategy) {
    const event = this.#startEvent("dom-extract", {
      flowId,
      strategy,
    });
    try {
      const result = lazy.extractTextFromDOM(document, rootNode, options);
      event.finish({
        status: "success",
        textLength: result.text.length,
        linkCount: result.links.length,
        canvasCount: result.canvases.length,
        siteStrategy: result.siteStrategy,
      });
      return result;
    } catch (error) {
      event.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }

  /**
   * @param {string} phase
   * @param {Record<string, any>} [data]
   */
  #startEvent(phase, data = {}) {
    return new lazy.PageExtractorEvent(phase, {
      process: "content",
      innerWindowId: this.contentWindow?.windowGlobalChild?.innerWindowId ?? 0,
      ...data,
    });
  }

  /**
   * Checks if about:reader is loaded, which requires special handling.
   *
   * @returns {boolean}
   */
  isAboutReader() {
    // Accessing the documentURIObject in this way does not materialize the
    // `window.location.href` and should be a cheaper check here.
    let url = this.manager.contentWindow.document.documentURIObject;
    return url.schemeIs("about") && url.pathQueryRef.startsWith("reader?");
  }

  /**
   * Capture canvas elements as WebP blobs. WebP is chosen for its superior
   * compression-to-quality ratio compared to PNG/JPEG, reducing the data sent
   * to language models while preserving visual fidelity.
   *
   * @param {HTMLCanvasElement[]} canvases
   * @param {GetTextOptions} options
   * @param {string | undefined} flowId
   * @returns {Promise<CanvasSnapshot[]>}
   */
  async #captureCanvases(canvases, options, flowId) {
    const event = this.#startEvent("canvas-capture", { flowId });
    const maxDimension = resolveMaxCanvasDimension(options);
    const quality = resolveCanvasQuality(options);

    try {
      const results = await Promise.all(
        canvases.map(c => this.#captureCanvas(c, maxDimension, quality))
      );
      const snapshots = results.filter(Boolean);
      event.finish({ status: "success", canvasCount: snapshots.length });
      return snapshots;
    } catch (error) {
      event.finish({ status: "error", errorName: error.name });
      throw error;
    }
  }

  /**
   * Capture a canvas element as a WebP blob. Uses OffscreenCanvas to avoid
   * blocking the main thread during scaling and blob conversion. ImageBitmap
   * is used as the source to efficiently transfer pixel data from the
   * original canvas.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} maxDimension
   * @param {number} quality
   * @returns {Promise<CanvasSnapshot | null>}
   */
  async #captureCanvas(canvas, maxDimension, quality) {
    const window = canvas.documentGlobal;
    const { width: originalWidth, height: originalHeight } = canvas;

    try {
      const bitmap = await window.createImageBitmap(canvas);

      const scale = Math.min(
        1,
        maxDimension / Math.max(originalWidth, originalHeight)
      );
      const targetWidth = Math.floor(originalWidth * scale);
      const targetHeight = Math.floor(originalHeight * scale);

      const offscreen = new window.OffscreenCanvas(targetWidth, targetHeight);
      // Alpha is enabled to preserve transparency in canvases that use it.
      // willReadFrequently is false because we only draw and convert to blob,
      // never reading pixels back, so hardware acceleration is preferred.
      const ctx = offscreen.getContext("2d", {
        alpha: true,
        willReadFrequently: false,
      });

      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      bitmap.close();

      let blob;
      try {
        blob = await offscreen.convertToBlob({
          type: "image/webp",
          quality,
        });
      } catch (securityError) {
        // Tainted canvas fall back to original canvas toBlob which works
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob(
            b => (b ? resolve(b) : reject(new Error("toBlob failed"))),
            "image/webp",
            quality
          );
        });

        return {
          blob,
          width: originalWidth,
          height: originalHeight,
        };
      }

      return {
        blob,
        width: targetWidth,
        height: targetHeight,
      };
    } catch (error) {
      lazy.console.debug?.("Canvas capture failed:", error);
      return null;
    }
  }
}
