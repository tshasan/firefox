/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { DebugLayoutBlock, HoveredDebugBlock } from './PageExtractor.d.ts'
 */

/**
 * Debug-only visualization for GetTextOptions._debugLayout: draws a
 * live-tracking highlight box over every text block, canvas, and link
 * DOMExtractor accepted, using the same canvasFrame AnonymousContent
 * primitive DevTools' own inspector highlighter is built on (see
 * Document.insertAnonymousContent) — immune to the page's own CSS/JS,
 * rendered above all page content, and removed as a unit via
 * removeAnonymousContent() rather than having to find our own nodes back
 * out of the page.
 *
 * Re-measures every animation frame, so boxes keep tracking scrolling,
 * resizing, and layout changes for as long as they're shown, rather than
 * freezing at the rect captured during extraction.
 *
 * Never reachable outside of the private _debugLayout option: has no
 * effect on real extraction output.
 */

const XHTML_NS = "http://www.w3.org/1999/xhtml";

const COLORS = {
  text: "#0060df",
  canvas: "#7542e5",
  link: "#12bc00",
};

// A per-kind pixel inset so overlapping boxes (e.g. a link inside a text
// block) are drawn as concentric rectangles instead of one border sitting
// exactly on top of the other, where only the last-painted one would be
// visible.
const KIND_INSET_PX = {
  text: 0,
  link: 3,
  canvas: 6,
};

/**
 * Untruncated block info for the panel's selected-block display (see
 * getHoveredDebugBlock()) — a native title-attribute tooltip was tried
 * first, but its length and layout aren't controllable, so the panel shows
 * this instead, polling it rather than needing a push-event channel across
 * the content/parent-process and WebExtension boundaries.
 *
 * @param {DebugLayoutBlock} block
 * @returns {HoveredDebugBlock}
 */
function describeBlock(block) {
  return {
    kind: block.kind,
    tag: block.element.tagName.toLowerCase(),
    text: block.text,
    href: block.href,
  };
}

/**
 * @type {WeakMap<Document, { stop(): void }>}
 */
const gOverlaysByDocument = new WeakMap();

/**
 * @type {WeakMap<Document, ReturnType<typeof describeBlock> | null>}
 */
const gHoverByDocument = new WeakMap();

/**
 * insertAnonymousContent() can throw NS_ERROR_UNEXPECTED while the document
 * is still in the "interactive" readyState (see bug 1365075); retry once
 * it's complete.
 *
 * @param {Document} document
 */
async function insertAnonymousContentWithRetry(document) {
  try {
    return document.insertAnonymousContent();
  } catch (error) {
    if (
      error.result === Cr.NS_ERROR_UNEXPECTED &&
      document.readyState === "interactive"
    ) {
      await new Promise(resolve =>
        document.addEventListener("readystatechange", resolve, {
          once: true,
        })
      );
      return document.insertAnonymousContent();
    }
    throw error;
  }
}

/**
 * @param {Document} document
 * @param {DebugLayoutBlock[]} blocks
 */
export async function showDebugLayoutOverlay(document, blocks) {
  clearDebugLayoutOverlay(document);

  const window = document.defaultView;
  if (!window) {
    return;
  }

  // Reserves this document's slot (with a no-op stop()) before the await
  // below, so a clear() or a second show() landing while
  // insertAnonymousContentWithRetry() is still pending finds this call
  // already registered and can invalidate it, instead of the two racing to
  // register last.
  const overlay = { stop() {} };
  gOverlaysByDocument.set(document, overlay);

  const anonymousContent = await insertAnonymousContentWithRetry(document);
  // The document may have navigated away, or a newer show()/clear() call may
  // have superseded this one, while insertAnonymousContentWithRetry() above
  // was retrying.
  if (
    document.defaultView !== window ||
    gOverlaysByDocument.get(document) !== overlay
  ) {
    document.removeAnonymousContent(anonymousContent);
    return;
  }

  const root = anonymousContent.root;
  const style = document.createElementNS(XHTML_NS, "style");
  style.textContent = `
    div {
      position: fixed;
      top: 0;
      left: 0;
      box-sizing: border-box;
      pointer-events: none;
      display: none;
    }
  `;
  root.appendChild(style);

  const entries = blocks
    .filter(block => block.element.isConnected)
    .map(block => {
      const box = document.createElementNS(XHTML_NS, "div");
      const color = COLORS[block.kind];
      box.style.border = `2px solid ${color}`;
      box.style.backgroundColor = `${color}22`;
      // Overrides the stylesheet's `pointer-events: none` (inline style
      // wins) so the box can receive clicks to drive the panel's selected-
      // block display. mouseenter/mouseleave were tried first but don't
      // reliably reach listeners on canvasFrame anonymous content; click
      // does (it's the same mechanism DevTools' own interactive highlighter
      // handles, e.g. the flexbox/grid resize grips, rely on). Only the
      // boxes opt in, not the full-viewport container, so empty space
      // between boxes still passes clicks through to the page — but any
      // box itself still intercepts the click underneath it either way.
      box.style.pointerEvents = "auto";
      const info = describeBlock(block);
      box.addEventListener("click", () => {
        gHoverByDocument.set(document, info);
      });
      root.appendChild(box);
      return { element: block.element, box, inset: KIND_INSET_PX[block.kind] };
    });

  let rafId;
  function reposition() {
    // Read every entry's rect before writing any box's style, so no write
    // in this pass can force a layout flush ahead of the next entry's read.
    const rects = entries.map(({ element }) =>
      element.isConnected ? element.getBoundingClientRect() : null
    );
    entries.forEach(({ box, inset }, i) => {
      const rect = rects[i];
      if (!rect) {
        box.style.display = "none";
        return;
      }
      box.style.display = "block";
      box.style.transform = `translate(${rect.left + inset}px, ${rect.top + inset}px)`;
      box.style.width = `${Math.max(0, rect.width - 2 * inset)}px`;
      box.style.height = `${Math.max(0, rect.height - 2 * inset)}px`;
    });
    rafId = window.requestAnimationFrame(reposition);
  }
  rafId = window.requestAnimationFrame(reposition);

  overlay.stop = () => {
    window.cancelAnimationFrame(rafId);
    gHoverByDocument.delete(document);
    try {
      document.removeAnonymousContent(anonymousContent);
    } catch {
      // The document may already be torn down (navigation/closed tab).
    }
  };
}

/**
 * @param {Document} document
 */
export function clearDebugLayoutOverlay(document) {
  const overlay = gOverlaysByDocument.get(document);
  if (overlay) {
    overlay.stop();
    gOverlaysByDocument.delete(document);
  }
}

/**
 * The block currently under the mouse in the debug overlay, for the panel
 * to poll and display in full (no truncation) — see PageExtractorChild's
 * "PageExtractorParent:GetHoveredDebugBlock" message.
 *
 * @param {Document} document
 * @returns {HoveredDebugBlock | null}
 */
export function getHoveredDebugBlock(document) {
  return gHoverByDocument.get(document) ?? null;
}
