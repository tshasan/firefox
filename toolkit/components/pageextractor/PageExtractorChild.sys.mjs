/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { GetTextOptions, GetDOMOptions, CanvasSnapshot, ExtractionResult } from './PageExtractor.d.ts'
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

const lazy = XPCOMUtils.declareLazy({
  console: () =>
    console.createInstance({
      prefix: "PageExtractorChild",
      maxLogLevelPref: "browser.ml.logLevel",
    }),
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  extractTextFromDOM:
    "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs",
  isProbablyReaderable: "resource://gre/modules/Readerable.sys.mjs",
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
      case "PageExtractorParent:GetReaderModeContent":
        if (this.isAboutReader()) {
          return this.getAboutReaderContent(data);
        }
        return this.getReaderModeContent(data);
      case "PageExtractorParent:GetText":
        if (this.isAboutReader()) {
          return (
            this.getAboutReaderContent(data) ?? {
              text: "",
              links: [],
              canvasSnapshots: [],
            }
          );
        }
        return this.getText(data);
      case "PageExtractorParent:WaitForPageReady":
        return this.waitForPageReady();
    }
    return Promise.reject(new Error("Unknown message: " + name));
  }

  /**
   * This function resolves once the page is ready after a requestIdleCallback.
   *
   * @returns {Promise<void>}
   */
  async waitForPageReady() {
    return new Promise(resolve => {
      const waitForIdle = () => {
        this.document.ownerGlobal.requestIdleCallback(() => resolve(), {
          timeout: MAX_REQUEST_IDLE_CALLBACK_DELAY_MS,
        });
      };

      if (this.document.readyState == "loading") {
        this.document.addEventListener("DOMContentLoaded", waitForIdle);
      } else {
        lazy.console.log("The page is already interactive");
        waitForIdle();
      }
    });
  }

  /**
   * Collapse whitespace and/or truncate text based on options.
   *
   * @param {string} text
   * @param {Partial<GetTextOptions>} options
   * @returns {string}
   */
  static #postProcessText(text, options) {
    if (!text) {
      return "";
    }
    let result = text;
    if (options.normalizeWhitespace) {
      result = result.replace(/\s+/g, " ").trim();
    }
    const { maxLength } = options;
    if (maxLength !== undefined && result.length > maxLength) {
      return result.substring(0, Math.max(0, maxLength));
    }
    return result;
  }

  /**
   * @see PageExtractorParent#getReaderModeContent for docs
   *
   * @param {Partial<GetTextOptions> & { force?: boolean }} options
   * @returns {Promise<ExtractionResult | null>}
   */
  async getReaderModeContent(options = {}) {
    const force = !!options.force;

    const window = this.browsingContext?.window;
    const document = window?.document;

    if (!force && (!document || !lazy.isProbablyReaderable(document))) {
      return null;
    }

    if (!document) {
      return null;
    }

    const article = await lazy.ReaderMode.parseDocument(document);
    if (!article) {
      return null;
    }

    let text = (article.textContent || "").trim();
    if (!options.normalizeWhitespace) {
      // Replace duplicate whitespace with either a single newline or space.
      // Skipped when normalizeWhitespace is set, since #postProcessText will
      // collapse all whitespace anyway.
      text = text.replace(/(\s*\n\s*)|\s{2,}/g, (_, nl) => (nl ? "\n" : " "));
    }

    if (article.title) {
      text = article.title + "\n\n" + text;
    }

    text = PageExtractorChild.#postProcessText(text, options);

    lazy.console.log("GetReaderModeContent", { force });
    lazy.console.debug(text);

    return { text, links: [], canvasSnapshots: [] };
  }

  /**
   * @see PageExtractorParent#getText for docs
   *
   * @param {Partial<GetTextOptions>} options
   * @returns {Promise<ExtractionResult>}
   */
  async getText(options = {}) {
    const window = this.browsingContext?.window;
    const document = window?.document;

    if (!document) {
      return { text: "", links: [], canvasSnapshots: [] };
    }

    const { text, links, canvases } = lazy.extractTextFromDOM(
      document,
      options
    );

    let canvasSnapshots = [];
    if (options.includeCanvasSnapshots && canvases.length) {
      canvasSnapshots = await this.#captureCanvases(canvases, options);
    }

    const processedText = PageExtractorChild.#postProcessText(text, options);

    lazy.console.log("GetText", options);
    lazy.console.debug({ text: processedText, links, canvasSnapshots });

    return { text: processedText, links, canvasSnapshots };
  }

  /**
   * Special case extracting text from Reader Mode. The original article content is not
   * retained once reader mode is activated. It is rendered out to the page. Rather
   * than cache an additional copy of the article, just extract the text from the
   * actual reader mode DOM.
   *
   * @param {Partial<GetTextOptions>} options
   * @returns {ExtractionResult | null}
   */
  getAboutReaderContent(options = {}) {
    lazy.console.log("Using special text extraction strategy for about:reader");
    const document = this.document;

    if (!document) {
      return null;
    }

    /** @type {HTMLElement} */
    const contentEl = document.querySelector(".moz-reader-content");

    if (!contentEl) {
      return null;
    }
    const title = document.querySelector(".reader-title")?.innerText ?? "";
    const content = contentEl.innerText;

    if (!title && !content) {
      return null;
    }

    const raw = title ? `${title}\n\n${content}`.trim() : content.trim();
    const text = PageExtractorChild.#postProcessText(raw, options);

    return { text, links: [], canvasSnapshots: [] };
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
   * @returns {Promise<CanvasSnapshot[]>}
   */
  async #captureCanvases(canvases, options) {
    const maxDimension = options.maxCanvasDimension ?? 1024;
    const quality = options.canvasQuality ?? 0.8;
    const window = this.browsingContext?.window;

    if (!window) {
      return [];
    }

    const results = await Promise.all(
      canvases.map(c => this.#captureCanvas(c, maxDimension, quality, window))
    );
    return results.filter(Boolean);
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
   * @param {Window} window
   * @returns {Promise<CanvasSnapshot | null>}
   */
  async #captureCanvas(canvas, maxDimension, quality, window) {
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
