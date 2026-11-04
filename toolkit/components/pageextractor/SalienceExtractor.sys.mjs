/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @see {extractSalientText} for a high level overview of this file.
 */

/**
 * @import { GetTextOptions, DOMExtractionResult } from './PageExtractor.d.ts'
 */

import {
  CONTENT_EXCLUDED_TAGS,
  WHITESPACE_REGEX,
  escapeMarkdownLink,
} from "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs";
import {
  SalienceSemantics,
  controlsPopup,
} from "moz-src:///toolkit/components/pageextractor/SalienceSemantics.sys.mjs";
import {
  Priority,
  selectSalienceRuns,
} from "moz-src:///toolkit/components/pageextractor/SalienceSelection.sys.mjs";

const LEADING_NEWLINES_REGEX = /^\n+/;
const LEADING_NON_SPACE_REGEX = /^\S/;
const TRAILING_NON_SPACE_REGEX = /\S$/;

// The DOMExtractor excludes CODE when it splits blocks, and still reads inline
// code. This walk visits every text node, so it has to keep CODE.
const EXCLUDED_TAGS = new Set(
  [...CONTENT_EXCLUDED_TAGS].filter(tagName => tagName !== "CODE")
);

/** A user can't read text smaller than this, in CSS pixels. */
const MIN_FONT_SIZE_PX = 2;

/** A user can't see text below this opacity, multiplied through its ancestors. */
const MIN_OPACITY = 0.1;

/** A user can't see text below this WCAG contrast ratio against its background. */
const MIN_CONTRAST_RATIO = 1.2;

/** A user can't see text that paints less than this area after clipping, in square CSS pixels. */
const MIN_VISIBLE_AREA_PX = 4;

/**
 * A user can bring clipped text into view when its container is at least this
 * big, in CSS pixels, like a carousel. The 1px boxes of visually hidden text
 * are smaller.
 */
const MIN_REACHABLE_CLIP_SIZE_PX = 8;

/**
 * Each non-boilerplate priority collects this many times the sufficient
 * length, so lower-priority text can't exhaust the main content's budget.
 */
const CANDIDATE_LENGTH_FACTOR = 2;

/** Each section collects up to the sufficient length, and at least this much. */
const MIN_SECTION_LENGTH = 128;

/** Limits on the aria-labelledby targets that selection keeps with a section. */
const MAX_LABELS_PER_SECTION = 4;
const MAX_LABEL_TARGETS = 32;

/** How many ancestors of a header list to check for popup controls. */
const POPUP_SEARCH_DEPTH = 4;

/**
 * Boilerplate only fills in when the rest of the page has less text than this,
 * as on a page that is mostly navigation.
 */
const MIN_CONTENT_LENGTH = 1000;

/** Adjacent text from different elements this far apart reads as separate words, in CSS pixels. */
const WORD_GAP_PX = 2;

/** A run with at least this much text outside links reads as a paragraph. */
const MIN_PARAGRAPH_LENGTH = 25;

/** The inferred content container holds at least this share of the paragraph text. */
const CONTENT_TEXT_SHARE = 0.7;

/**
 * Media that a page can paint behind text without the text's ancestors' computed
 * style showing it, like a hero image behind a headline.
 */
const MEDIA_SELECTOR = "img, picture, video, canvas, svg";

/** How many ancestors of low contrast text to search for media behind it. */
const MEDIA_SEARCH_DEPTH = 6;

const LETTER_REGEX = /\p{L}/u;

/** A user can scroll other overflow into view, so these are the ones that clip text. */
const CLIPPING_OVERFLOWS = new Set(["hidden", "clip"]);

/** A short block this much larger than the median font size reads as a heading. */
const VISUAL_HEADING_FONT_SCALE = 1.5;
const VISUAL_HEADING_MAX_LENGTH = 120;

/** The priority of the regions marked up with these landmark roles. */
const ROLE_PRIORITIES = new Map([
  ["main", Priority.CONTENT],
  ["article", Priority.CONTENT],
  ["dialog", Priority.CONTENT],
  ["alertdialog", Priority.CONTENT],
  ["complementary", Priority.UNMARKED],
  ["banner", Priority.BOILERPLATE],
  ["search", Priority.BOILERPLATE],
  ["navigation", Priority.BOILERPLATE],
  ["contentinfo", Priority.BOILERPLATE],
]);

const CELL_SELECTOR =
  'td, th, [role~="cell"], [role~="columnheader"], [role~="rowheader"], [role~="gridcell"]';
const CELL_ROLES = new Set(["cell", "columnheader", "rowheader", "gridcell"]);
const TABLE_SELECTOR = 'table, [role~="table"], [role~="grid"]';
const TABLE_ROLES = new Set(["table", "grid"]);

/**
 * @typedef {object} RGBA
 * @property {number} r - 0-255
 * @property {number} g - 0-255
 * @property {number} b - 0-255
 * @property {number} a - 0-1
 */

/**
 * A rectangle in viewport coordinates.
 *
 * @typedef {object} Box
 * @property {number} left - The x coordinate of the left edge.
 * @property {number} top - The y coordinate of the top edge.
 * @property {number} right - The x coordinate of the right edge.
 * @property {number} bottom - The y coordinate of the bottom edge.
 */

/**
 * @typedef {object} TextSegment
 * @property {string} text - The text as it appears in the DOM.
 * @property {string | null} href - The link target when the text is inside an anchor.
 */

/**
 * Perceivable text that renders within one block, or one table row.
 */
class SalienceRun {
  /** @type {Element} */
  block;

  /** @type {Element | null} */
  section = null;
  /** @type {Element | null} */
  table = null;
  isTableHeader = false;
  hasDataCell = false;
  /** @type {Element[]} */
  contextBlocks = [];

  /** @type {TextSegment[]} */
  segments = [];

  /** Characters of text in the run. */
  textLength = 0;

  /** Characters of text in the run that are inside of links. */
  linkTextLength = 0;

  /** Characters of text in the run that are clipped out of view. */
  clippedOutTextLength = 0;

  /** Font size of the run's text, weighted by text length, in CSS pixels. */
  fontSizeSum = 0;

  /** @type {number | null} */
  headingLevel = null;

  /** The priority of the region the run is in. */
  regionPriority = Priority.UNMARKED;

  /** @type {Element | null} The table cell of the last text added. */
  lastCell = null;

  /** @type {Element | null} The parent of the last text added. */
  lastElement = null;

  /** @type {Box | null} The viewport bounds of the last text added. */
  lastRect = null;

  preserveWhitespace = false;

  /**
   * @param {Element} block
   */
  constructor(block) {
    this.block = block;
  }

  /**
   * Whether text from another element starts a new word, though the markup
   * has no whitespace before it, because margins or gaps separate it on
   * screen.
   *
   * @param {Element} element - The text's parent.
   * @param {Box} rect - The text's bounds in viewport coordinates.
   * @param {string} text
   * @returns {boolean}
   */
  startsNewWord(element, rect, text) {
    const { lastElement, lastRect } = this;
    return Boolean(
      lastElement &&
      lastElement !== element &&
      lastRect &&
      TRAILING_NON_SPACE_REGEX.test(this.segments.at(-1)?.text ?? "") &&
      LEADING_NON_SPACE_REGEX.test(text) &&
      (rect.left - lastRect.right > WORD_GAP_PX || rect.top >= lastRect.bottom)
    );
  }

  get isMostlyClippedOut() {
    return this.clippedOutTextLength * 2 > this.textLength;
  }

  get fontSize() {
    return this.textLength ? this.fontSizeSum / this.textLength : 0;
  }
}

/**
 * The caches for one extraction. Many text nodes share the same ancestors, so
 * each style, layout and role read happens once per element.
 */
class SalienceContext {
  /** @type {Window} */
  window;

  /** @type {GetTextOptions} */
  options;

  /** @type {Element} */
  rootNode;

  /** @type {SalienceRun[]} */
  runs = [];

  /** Characters of perceivable text collected at each region priority. */
  #candidateLengths = [0, 0, 0];

  /** The candidate length limit for each non-boilerplate priority. */
  maxCandidateLength = Infinity;

  /**
   * Whether the caller gave a sufficient length. Without one the walk keeps
   * every perceivable run and skips the section bookkeeping.
   */
  #hasBudget = false;

  #maxSectionLength = Infinity;

  /** @type {SalienceSemantics} */
  #semantics;

  /** @type {Map<Element, Element>} The section each element belongs to. */
  #sections = new Map();

  /** @type {Map<Element, Element>} The nearest section container. */
  #sectionContainers = new Map();

  /** @type {Map<Element, Element>} The current heading in each container. */
  #activeSections = new Map();

  /** @type {Map<Element, number>} Characters collected in each section. */
  #sectionLengths = new Map();

  /** @type {Map<Element, Element[]>} The label blocks of each container. */
  #sectionContexts = new Map();

  /** @type {Map<Element, boolean>} */
  #headers = new Map();

  /** @type {Map<Element, boolean>} */
  #popupGroups = new Map();

  /** @type {Map<Element, Box[]>} The media rects under each ancestor. */
  #mediaBoxes = new Map();

  #labelTargets = 0;

  get candidateLength() {
    return (
      this.#candidateLengths[Priority.CONTENT] +
      this.#candidateLengths[Priority.UNMARKED]
    );
  }

  /** @type {Map<Element, CSSStyleDeclaration>} */
  #styles = new Map();

  /** @type {Map<Element, number>} */
  #opacities = new Map();

  /**
   * The rectangle that an element's descendants are clipped to, in viewport
   * coordinates, or null when nothing clips them.
   *
   * @type {Map<Element, Box | null>}
   */
  #clipRects = new Map();

  /**
   * The opaque color behind an element's text, or null when the page paints
   * the text on an image and style can't tell the color.
   *
   * @type {Map<Element, RGBA | null>}
   */
  #backgrounds = new Map();

  /** @type {Map<Element, number | null>} */
  #contrasts = new Map();

  /** @type {Map<string, RGBA | null>} */
  #colors = new Map();

  /** @type {Map<Element, Element>} */
  #blocks = new Map();

  /** @type {Map<Element, number>} */
  #regionPriorities = new Map();

  /**
   * The parent of each walked element in the flattened tree. The walk flattens
   * nested slots, so an element's assignedSlot can differ from the slot the
   * walk visited it under.
   *
   * @type {Map<Element, Element>}
   */
  #flatParents = new Map();

  /**
   * @type {Map<Element, { cell: Element | null, href: string | null, headingLevel: number | null }>}
   */
  #elementContexts = new Map();

  /** @type {Range} */
  #range;

  /** @type {Box} The scrollable bounds of the document. */
  #documentBounds;

  /**
   * Boilerplate regions that the walk set aside, with where their runs go in
   * reading order. The extractor walks them when the content falls short.
   *
   * @type {Array<{ element: Element, flatParent: Element, runIndex: number }>}
   */
  #deferredRegions = [];

  #isWalkingDeferredRegions = false;

  /** @type {Element | null} The closed disclosure the walk is inside. */
  #disclosure = null;

  /**
   * @param {Document} document
   * @param {Element} rootNode
   * @param {GetTextOptions} options
   * @param {SalienceSemantics} semantics
   */
  constructor(document, rootNode, options, semantics) {
    this.window = /** @type {Window} */ (document.defaultView);
    this.options = options;
    this.rootNode = rootNode;
    this.#range = document.createRange();
    this.#semantics = semantics;
    if (options.sufficientLength !== undefined) {
      this.#hasBudget = true;
      this.maxCandidateLength =
        options.sufficientLength * CANDIDATE_LENGTH_FACTOR;
      this.#maxSectionLength = Math.max(
        MIN_SECTION_LENGTH,
        options.sufficientLength
      );
    }

    const { scrollX, scrollY, scrollMinX, scrollMinY, scrollMaxX, scrollMaxY } =
      this.window;
    const { clientWidth, clientHeight } = document.documentElement;
    const left = scrollMinX - scrollX;
    const top = scrollMinY - scrollY;
    this.#documentBounds = {
      left,
      top,
      right: left + clientWidth + scrollMaxX - scrollMinX,
      bottom: top + clientHeight + scrollMaxY - scrollMinY,
    };
  }

  /**
   * @param {Element} element
   * @returns {CSSStyleDeclaration}
   */
  style(element) {
    let style = this.#styles.get(element);
    if (!style) {
      style = /** @type {CSSStyleDeclaration} */ (
        this.window.getComputedStyle(element)
      );
      this.#styles.set(element, style);
    }
    return style;
  }

  /**
   * Walks the flattened tree, to visit shadow DOM and slotted content in the
   * order they render.
   *
   * @param {Node} node
   * @param {Element} flatParent - The parent of the node in the flattened tree.
   */
  walk(node, flatParent) {
    const { nodeType } = node;
    if (nodeType === Node.TEXT_NODE) {
      this.#visitText(/** @type {Text} */ (node), flatParent);
      return;
    }
    if (
      nodeType !== Node.ELEMENT_NODE ||
      this.#candidateLengths[Priority.CONTENT] >= this.maxCandidateLength
    ) {
      return;
    }

    const element = /** @type {Element} */ (node);
    this.#flatParents.set(element, flatParent);
    if (EXCLUDED_TAGS.has(element.tagName.toUpperCase())) {
      return;
    }
    if (
      !this.#isWalkingDeferredRegions &&
      this.#hasBudget &&
      this.#regionPriority(element) >= Priority.BOILERPLATE &&
      // Controls like tablists can wrap content, so only defer landmarks and
      // overlays.
      !this.#semantics.get(element).isAuxiliary &&
      this.#regionPriority(flatParent) < Priority.BOILERPLATE
    ) {
      this.#deferredRegions.push({
        element,
        flatParent,
        runIndex: this.runs.length,
      });
      return;
    }
    let disclosure = null;
    if (
      !element.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        // The constructor flushed layout to measure the document bounds, and
        // the walk changes nothing.
        flush: false,
      }) &&
      this.style(element).display !== "contents"
    ) {
      const { display, opacity } = this.style(element);
      disclosure =
        this.#disclosure ??
        (display !== "none" && opacity !== "0"
          ? element.closest('details:not([open]), [hidden="until-found"]')
          : null);
      if (!disclosure || display === "none" || opacity === "0") {
        // The element has no box, or is fully transparent, and descendants
        // can't override either. They can override "visibility", so
        // #visitText checks that per text node.
        return;
      }
    }

    if (this.#hasBudget) {
      const parentContainer =
        this.#sectionContainers.get(flatParent) ?? this.rootNode;
      const semantics = this.#semantics.get(element);
      const container = semantics.isSection ? element : parentContainer;
      this.#sectionContainers.set(element, container);
      if (
        semantics.headingLevel &&
        this.#regionPriority(element) < Priority.BOILERPLATE
      ) {
        this.#activeSections.set(container, element);
      }
      this.#sections.set(
        element,
        this.#activeSections.get(container) ?? container
      );
    }

    const outerDisclosure = this.#disclosure;
    // A user can open a closed details element or find text hidden until
    // found, so its text stays, after the visible text.
    this.#disclosure = disclosure ?? outerDisclosure;
    for (const child of flatChildren(element)) {
      this.walk(child, element);
    }
    this.#disclosure = outerDisclosure;
  }

  /**
   * Walks the deferred boilerplate regions when the content falls short of the
   * sufficient length, and puts their runs back in reading order.
   */
  walkDeferredRegions() {
    const { sufficientLength } = this.options;
    if (
      sufficientLength !== undefined &&
      this.candidateLength >= Math.min(sufficientLength, MIN_CONTENT_LENGTH)
    ) {
      return;
    }
    this.#isWalkingDeferredRegions = true;
    const runs = this.runs;
    // Walk each region into its own runs, so #visitText can't merge its first
    // text into the run before it. Splice from the end, so the earlier run
    // indices stay valid.
    for (const {
      element,
      flatParent,
      runIndex,
    } of this.#deferredRegions.toReversed()) {
      this.runs = [];
      this.walk(element, flatParent);
      runs.splice(runIndex, 0, ...this.runs);
    }
    this.runs = runs;
  }

  /**
   * Finds the main content when landmarks don't mark it, from where the
   * paragraph text concentrates, and demotes link-dense runs outside the
   * content, like menus and footers built without landmarks.
   */
  refinePriorities() {
    const { runs } = this;
    let contentLength = 0;
    let unmarkedLength = 0;
    for (const run of runs) {
      if (run.regionPriority === Priority.CONTENT) {
        contentLength += run.textLength;
      } else if (run.regionPriority === Priority.UNMARKED) {
        unmarkedLength += run.textLength;
      }
    }
    if (contentLength * 4 < unmarkedLength) {
      const totals = new Map();
      let total = 0;
      for (const run of runs) {
        const text = run.textLength - run.linkTextLength;
        if (
          run.regionPriority !== Priority.UNMARKED ||
          text < MIN_PARAGRAPH_LENGTH
        ) {
          continue;
        }
        total += text;
        for (
          let element = this.#parent(run.block);
          element;
          element = this.#parent(element)
        ) {
          totals.set(element, (totals.get(element) ?? 0) + text);
        }
      }
      // Containers holding most of the text nest, so the smallest total over
      // the share is the deepest one.
      let container = null;
      let containerTotal = Infinity;
      for (const [element, sum] of totals) {
        if (sum >= total * CONTENT_TEXT_SHARE && sum < containerTotal) {
          container = element;
          containerTotal = sum;
        }
      }
      // The content starts at the page title, so a container below it, like
      // a long table, grows to take in the introduction.
      let title = null;
      for (const run of runs) {
        if (
          run.headingLevel &&
          run.regionPriority < Priority.BOILERPLATE &&
          (!title || run.headingLevel < title.headingLevel)
        ) {
          title = run;
        }
      }
      const isInside = (element, ancestor) => {
        for (; element; element = this.#parent(element)) {
          if (element === ancestor) {
            return true;
          }
        }
        return false;
      };
      while (container && title && !isInside(title.block, container)) {
        container = this.#parent(container);
      }
      if (container && container !== this.rootNode) {
        const inside = new Map();
        const isInsideContainer = element => {
          let result = inside.get(element);
          if (result === undefined) {
            const parent = this.#parent(element);
            result =
              element === container ||
              Boolean(parent && isInsideContainer(parent));
            inside.set(element, result);
          }
          return result;
        };
        for (const run of runs) {
          if (
            run.regionPriority === Priority.UNMARKED &&
            isInsideContainer(run.block)
          ) {
            run.regionPriority = Priority.CONTENT;
            contentLength += run.textLength;
          }
        }
      }
    }
    if (contentLength < MIN_CONTENT_LENGTH) {
      return;
    }
    for (const run of runs) {
      if (
        run.regionPriority === Priority.UNMARKED &&
        run.linkTextLength * 2 >= run.textLength
      ) {
        run.regionPriority = Priority.BOILERPLATE;
      }
    }
  }

  /**
   * @param {Text} text
   * @param {Element} element - The text node's parent in the flattened tree.
   */
  #visitText(text, element) {
    const section = this.#sections.get(element) ?? this.rootNode;
    const priority = this.#hasBudget
      ? this.#regionPriority(element)
      : Priority.UNMARKED;
    if (
      priority < Priority.BOILERPLATE &&
      (this.#candidateLengths[priority] >= this.maxCandidateLength ||
        (this.#sectionLengths.get(section) ?? 0) >= this.#maxSectionLength)
    ) {
      return;
    }
    const { data } = text;
    if (!data.trim()) {
      // Whitespace still separates the inline content around it.
      const run = this.runs.at(-1);
      if (run?.block === this.#blockFor(element)) {
        run.segments.push({ text: data, href: null });
      }
      return;
    }

    const style = this.style(element);
    if (style.visibility !== "visible") {
      return;
    }

    const fontSize = parseFloat(style.fontSize);
    if (fontSize < MIN_FONT_SIZE_PX) {
      return;
    }

    if (this.#opacity(element) < MIN_OPACITY) {
      return;
    }

    let placement = this.#textPlacement(text, element, style);
    if (this.#disclosure) {
      placement = {
        rect:
          placement?.rect ?? toBox(this.#disclosure.getBoundingClientRect()),
        isClippedOut: true,
      };
    }
    if (!placement) {
      return;
    }
    if (
      this.options.justViewport &&
      (placement.rect.bottom <= 0 ||
        placement.rect.top >= this.window.innerHeight ||
        placement.rect.right <= 0 ||
        placement.rect.left >= this.window.innerWidth)
    ) {
      return;
    }

    const contrast = this.#contrast(element);
    if (contrast !== null && contrast < MIN_CONTRAST_RATIO) {
      return;
    }

    const block = this.#blockFor(element);
    let run = this.runs.at(-1);
    if (run?.block !== block) {
      run = this.#createRun(block);
      this.runs.push(run);
    }

    const { cell, href, headingLevel } = this.#elementContext(element);
    run.headingLevel ??= headingLevel;
    if (cell) {
      const role = this.#semantics.get(cell).role;
      if (role === "cell" || role === "gridcell") {
        run.hasDataCell = true;
        run.isTableHeader = false;
      } else if (role === "columnheader" && !run.hasDataCell) {
        run.isTableHeader = true;
      }
    }

    const { rect } = placement;
    if (cell !== run.lastCell) {
      if (run.lastCell) {
        run.segments.push({ text: " | ", href: null });
      }
      run.lastCell = cell;
    } else if (run.startsNewWord(element, rect, data)) {
      run.segments.push({ text: " ", href: null });
    }
    run.lastElement = element;
    run.lastRect = rect;

    const { length } = data;
    run.segments.push({ text: applyTextTransform(data, style), href });
    run.textLength += length;
    if (this.#hasBudget && run.regionPriority < Priority.BOILERPLATE) {
      this.#candidateLengths[run.regionPriority] += length;
      this.#sectionLengths.set(
        section,
        (this.#sectionLengths.get(section) ?? 0) + length
      );
    }
    if (href) {
      run.linkTextLength += length;
    }
    if (placement.isClippedOut) {
      run.clippedOutTextLength += length;
    }
    run.fontSizeSum += fontSize * length;
  }

  /**
   * @param {Element} element
   */
  #elementContext(element) {
    let context = this.#elementContexts.get(element);
    if (!context) {
      const heading = element.closest(
        'h1, h2, h3, h4, h5, h6, [role~="heading"]'
      );
      context = {
        cell: this.#closestRole(element, CELL_SELECTOR, CELL_ROLES),
        href: getLinkHref(element),
        headingLevel: heading
          ? this.#semantics.get(heading).headingLevel
          : null,
      };
      this.#elementContexts.set(element, context);
    }
    return context;
  }

  /**
   * Returns the nearest ancestor matching the selector whose computed role is
   * one of the roles, so a role attribute that falls back to an unknown token
   * doesn't count.
   *
   * @param {Element} element
   * @param {string} selector
   * @param {Set<string>} roles
   * @returns {Element | null}
   */
  #closestRole(element, selector, roles) {
    let candidate = element.closest(selector);
    while (candidate) {
      const { role } = this.#semantics.get(candidate);
      if (role && roles.has(role)) {
        return candidate;
      }
      candidate = candidate.parentElement?.closest(selector);
    }
    return null;
  }

  /**
   * Returns the parent of the element in the flattened tree, or null at the
   * root node.
   *
   * @param {Element} element
   * @returns {Element | null}
   */
  #parent(element) {
    if (element === this.rootNode) {
      return null;
    }
    return this.#flatParents.get(element) ?? getFlatParent(element);
  }

  /**
   * @param {Element} block
   * @returns {SalienceRun}
   */
  #createRun(block) {
    const run = new SalienceRun(block);
    const { whiteSpaceCollapse } = this.style(block);
    run.preserveWhitespace =
      whiteSpaceCollapse === "preserve" ||
      whiteSpaceCollapse === "break-spaces";
    run.regionPriority = this.#regionPriority(block);
    if (!this.#hasBudget) {
      return run;
    }
    run.section = this.#sections.get(block) ?? this.rootNode;
    run.table = this.#closestRole(block, TABLE_SELECTOR, TABLE_ROLES);
    const container = this.#sectionContainers.get(block) ?? run.section;
    let contextBlocks = this.#sectionContexts.get(container);
    if (!contextBlocks) {
      contextBlocks = [];
      const root = /** @type {Document | ShadowRoot} */ (
        container.getRootNode()
      );
      for (const id of (
        container
          .getAttribute("aria-labelledby")
          ?.trim()
          .split(WHITESPACE_REGEX) ?? []
      ).slice(0, MAX_LABELS_PER_SECTION)) {
        if (this.#labelTargets >= MAX_LABEL_TARGETS) {
          break;
        }
        this.#labelTargets++;
        const label = root.getElementById(id);
        if (label) {
          contextBlocks.push(this.#blockFor(label));
        }
      }
      this.#sectionContexts.set(container, contextBlocks);
    }
    run.contextBlocks = contextBlocks;
    return run;
  }

  /**
   * Returns where the page paints the text, or null when the user can't see it
   * or bring it into view.
   *
   * The user can bring text clipped out of a visible container into view, like
   * a carousel slide or a truncated article, so it stays. Scrolling reaches
   * past a container's end edges and nothing before its start edges, which is
   * where off-page text like "left: -9999px" lands.
   *
   * @param {Text} text
   * @param {Element} element
   * @param {CSSStyleDeclaration} style
   * @returns {{ rect: Box, isClippedOut: boolean } | null}
   */
  #textPlacement(text, element, style) {
    this.#range.selectNodeContents(text);
    const clip = this.#clipRect(element);

    let visibleArea = 0;
    let clippedArea = 0;
    /** @type {Box | null} */
    let visibleUnion = null;
    /** @type {Box | null} */
    let clippedUnion = null;
    for (const lineRect of this.#range.getClientRects()) {
      const line = toBox(lineRect);
      const lineArea = getArea(line);
      if (!lineArea) {
        continue;
      }
      clippedArea += lineArea;
      clippedUnion = clippedUnion ? unionBoxes(clippedUnion, line) : line;

      let box = intersectBoxes(line, this.#documentBounds);
      if (clip) {
        box = intersectBoxes(box, clip);
      }
      const area = getArea(box);
      if (area) {
        visibleArea += area;
        visibleUnion = visibleUnion ? unionBoxes(visibleUnion, box) : box;
      }
    }

    if (visibleUnion && visibleArea >= MIN_VISIBLE_AREA_PX) {
      return { rect: visibleUnion, isClippedOut: false };
    }

    if (
      clip &&
      clippedUnion &&
      clippedArea >= MIN_VISIBLE_AREA_PX &&
      clip.right - clip.left >= MIN_REACHABLE_CLIP_SIZE_PX &&
      clip.bottom - clip.top >= MIN_REACHABLE_CLIP_SIZE_PX &&
      clippedUnion.top >= clip.top &&
      (style.direction === "rtl"
        ? clippedUnion.right <= clip.right
        : clippedUnion.left >= clip.left)
    ) {
      return { rect: clippedUnion, isClippedOut: true };
    }

    return null;
  }

  /**
   * @param {Element} element
   * @returns {Box | null}
   */
  #clipRect(element) {
    if (this.#clipRects.has(element)) {
      return this.#clipRects.get(element) ?? null;
    }

    const parent = this.#parent(element);
    let clip = parent ? this.#clipRect(parent) : null;

    const {
      overflowX,
      overflowY,
      clipPath,
      clip: clipProperty,
    } = this.style(element);
    if (
      CLIPPING_OVERFLOWS.has(overflowX) ||
      CLIPPING_OVERFLOWS.has(overflowY) ||
      clipPath !== "none" ||
      clipProperty !== "auto"
    ) {
      const box = toBox(element.getBoundingClientRect());
      clip = clip ? intersectBoxes(clip, box) : box;
    }

    this.#clipRects.set(element, clip);
    return clip;
  }

  /**
   * @param {Element} element
   * @returns {number}
   */
  #opacity(element) {
    let opacity = this.#opacities.get(element);
    if (opacity === undefined) {
      const parent = this.#parent(element);
      opacity =
        parseFloat(this.style(element).opacity) *
        (parent ? this.#opacity(parent) : 1);
      this.#opacities.set(element, opacity);
    }
    return opacity;
  }

  /**
   * Returns the WCAG contrast ratio of the element's text against its
   * background, or null when style can't tell the background.
   *
   * @param {Element} element
   * @returns {number | null}
   */
  #contrast(element) {
    if (this.#contrasts.has(element)) {
      return this.#contrasts.get(element) ?? null;
    }

    const style = this.style(element);
    // background-clip: text fills the text with the background, often an image
    // or a gradient.
    const background =
      style.backgroundClip === "text" ? null : this.#background(element);
    const foreground = this.#parseColor(
      style.webkitTextFillColor || style.color
    );
    let contrast =
      background && foreground
        ? contrastRatio(compositeOver(foreground, background), background)
        : null;
    if (
      contrast !== null &&
      contrast < MIN_CONTRAST_RATIO &&
      this.#isOverMedia(element)
    ) {
      contrast = null;
    }

    this.#contrasts.set(element, contrast);
    return contrast;
  }

  /**
   * Returns true when media in the element's nearest ancestors overlaps it.
   * Style can't tell what the text then sits on.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  #isOverMedia(element) {
    const box = toBox(element.getBoundingClientRect());
    /** @type {Element | null} */
    let ancestor = element;
    for (let depth = 0; ancestor && depth < MEDIA_SEARCH_DEPTH; depth++) {
      let mediaBoxes = this.#mediaBoxes.get(ancestor);
      if (!mediaBoxes) {
        mediaBoxes = Array.from(
          ancestor.querySelectorAll(MEDIA_SELECTOR),
          media => toBox(media.getBoundingClientRect())
        );
        this.#mediaBoxes.set(ancestor, mediaBoxes);
      }
      if (mediaBoxes.some(mediaBox => getArea(intersectBoxes(mediaBox, box)))) {
        return true;
      }
      ancestor = this.#parent(ancestor);
    }
    return false;
  }

  /**
   * @param {string} color - Any CSS color.
   * @returns {RGBA | null}
   */
  #parseColor(color) {
    let rgba = this.#colors.get(color);
    if (rgba === undefined) {
      rgba = InspectorUtils.colorToRGBA(color);
      this.#colors.set(color, rgba);
    }
    return rgba;
  }

  /**
   * @param {Element} element
   * @returns {RGBA | null}
   */
  #background(element) {
    if (this.#backgrounds.has(element)) {
      return this.#backgrounds.get(element) ?? null;
    }

    const style = this.style(element);
    // Ancestors of the root node can paint the background.
    const parent = this.#flatParents.get(element) ?? getFlatParent(element);

    /** @type {RGBA | null} */
    let background;
    if (style.backgroundImage !== "none") {
      background = null;
    } else {
      const color = this.#parseColor(style.backgroundColor);
      const below = parent
        ? this.#background(parent)
        : { r: 255, g: 255, b: 255, a: 1 };
      if (color?.a === 1) {
        background = color;
      } else if (!below) {
        background = null;
      } else {
        background = color ? compositeOver(color, below) : below;
      }
    }

    this.#backgrounds.set(element, background);
    return background;
  }

  /**
   * Returns the nearest flat tree ancestor that lays out as a block, where
   * inline content reflows into lines. A table row's cells share one block, so
   * the row reads as one line.
   *
   * @param {Element} element
   * @returns {Element}
   */
  #blockFor(element) {
    let block = this.#blocks.get(element);
    if (!block) {
      const { display } = this.style(element);
      const parent = this.#parent(element);
      const isInline =
        display.startsWith("inline") ||
        display === "contents" ||
        display === "table-cell" ||
        (element.hasAttribute("role") &&
          CELL_ROLES.has(this.#semantics.get(element).role ?? ""));
      block =
        isInline && parent && element !== this.rootNode
          ? this.#blockFor(parent)
          : element;
      this.#blocks.set(element, block);
    }
    return block;
  }

  /**
   * Returns the priority of the nearest region containing the element: a
   * landmark from the ARIA role attribute or the element's implicit role, or a
   * fixed or sticky overlay like a cookie banner or a site header.
   *
   * @param {Element} element
   * @returns {number}
   */
  #regionPriority(element) {
    let priority = this.#regionPriorities.get(element);
    if (priority === undefined) {
      const semantics = this.#semantics.get(element);
      const { role } = semantics;
      const { position } = this.style(element);
      if (
        semantics.isAuxiliary ||
        (role === "list" &&
          this.#insideHeader(element) &&
          this.#insidePopup(element))
      ) {
        priority = Priority.BOILERPLATE;
      } else if (role === "tabpanel") {
        // Pages put tab panels inside the tablist with the tabs, and the
        // panel's priority comes from outside the controls.
        let parent = this.#parent(element);
        while (parent && this.#semantics.get(parent).isAuxiliary) {
          parent = this.#parent(parent);
        }
        priority = parent ? this.#regionPriority(parent) : Priority.UNMARKED;
      } else if (role && ROLE_PRIORITIES.has(role)) {
        priority = /** @type {number} */ (ROLE_PRIORITIES.get(role));
      } else if (position === "fixed" || position === "sticky") {
        priority = Priority.BOILERPLATE;
      } else {
        const parent = this.#parent(element);
        priority = parent ? this.#regionPriority(parent) : Priority.UNMARKED;
      }
      this.#regionPriorities.set(element, priority);
    }
    return priority;
  }

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  #insideHeader(element) {
    let header = this.#headers.get(element);
    if (header === undefined) {
      const parent = this.#parent(element);
      header =
        element.tagName.toUpperCase() === "HEADER" ||
        Boolean(parent && this.#insideHeader(parent));
      this.#headers.set(element, header);
    }
    return header;
  }

  /**
   * Whether a direct child of one of the element's nearest ancestors, below
   * the header, opens a popup. A header list next to a menu button is the
   * menu's content.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  #insidePopup(element) {
    let parent = this.#parent(element);
    for (let depth = 0; parent && depth < POPUP_SEARCH_DEPTH; depth++) {
      if (
        parent.tagName.toUpperCase() === "HEADER" ||
        parent === this.rootNode
      ) {
        break;
      }
      let popup = this.#popupGroups.get(parent);
      if (popup === undefined) {
        popup = false;
        for (const child of flatChildren(parent)) {
          const control = asElement(child);
          if (
            control &&
            (controlsPopup(control) || control.hasAttribute("popovertarget"))
          ) {
            popup = true;
            break;
          }
        }
        this.#popupGroups.set(parent, popup);
      }
      if (popup) {
        return true;
      }
      parent = this.#parent(parent);
    }
    return false;
  }
}

/**
 * Extracts the text of a page as a sighted user sees it.
 *
 * The DOMExtractor decides visibility with a few computed style checks, and
 * lets through text the user can't see: 0px fonts, text the color of its
 * background, text clipped to one pixel for screen readers, and text off the
 * page. Pages hide prompt injections from the user the same ways.
 *
 * This extractor measures the rendered layout of each text node:
 *
 *   1. It drops text the user can't perceive, from the font size, opacity
 *      through all ancestors, the painted area after overflow and clip-path
 *      clipping, and the contrast ratio against the background. It keeps text
 *      clipped out of a visible container, like a carousel slide, as the user
 *      can bring it into view.
 *
 *   2. It groups the remaining text into runs within a block, in reading
 *      order, as the DOMExtractor does. A table row is one run.
 *
 *   3. It gives each run the priority of its region. Main content comes first,
 *      then unmarked text and sidebars, then boilerplate: navigation, banners,
 *      footers and fixed overlays, found from ARIA landmarks and layout. Text
 *      the user has to bring into view comes after the visible text of its
 *      region.
 *
 * The output keeps reading order and selects runs with their section and table
 * context. To cut text down to `sufficientLength`, it samples evidence groups
 * across sections in priority order. It marks short text rendered much larger
 * than the rest of the page as a heading.
 *
 * Visibility doesn't come from the accessibility tree, which includes visually
 * hidden text for screen readers. aria-hidden text stays, as pages often use it
 * for the visual version of screen reader text.
 *
 * @param {Document} document
 * @param {Element} rootNode
 * @param {GetTextOptions} options
 * @returns {Promise<DOMExtractionResult>}
 */
export async function extractSalientText(document, rootNode, options) {
  const semantics = await SalienceSemantics.create(document);
  const context = new SalienceContext(document, rootNode, options, semantics);
  try {
    for (const child of flatChildren(rootNode)) {
      context.walk(child, rootNode);
    }
    context.walkDeferredRegions();
    context.refinePriorities();
  } finally {
    semantics.dispose();
  }

  const { runs } = context;
  const medianFontSize = getMedianFontSize(runs);

  const headingLevels = runs.map(run =>
    getHeadingLevelForRun(run, medianFontSize)
  );
  const lines = runs.map((run, index) =>
    formatRun(run, headingLevels[index], options.useSimpleText ?? false)
  );

  const { sufficientLength } = options;
  const keep =
    sufficientLength === undefined
      ? keepAllContent(runs)
      : selectSalienceRuns(runs, lines, headingLevels, sufficientLength);

  /** @type {string[]} */
  const kept = [];
  /** @type {Set<string>} */
  const links = new Set();
  for (let i = 0; i < runs.length; i++) {
    if (keep[i] && lines[i]) {
      kept.push(lines[i]);
      for (const { href } of runs[i].segments) {
        if (href) {
          links.add(href);
        }
      }
    }
  }

  return {
    text: kept.join("\n"),
    links: [...links],
    canvases: [],
    siteStrategy: null,
  };
}

/**
 * Keeps every non-boilerplate run, and boilerplate too when the rest of the
 * page is too short to stand alone.
 *
 * @param {SalienceRun[]} runs
 * @returns {boolean[]}
 */
function keepAllContent(runs) {
  const contentLength = runs.reduce(
    (sum, run) =>
      run.regionPriority < Priority.BOILERPLATE ? sum + run.textLength : sum,
    0
  );
  return runs.map(
    run =>
      run.regionPriority < Priority.BOILERPLATE ||
      contentLength < MIN_CONTENT_LENGTH
  );
}

/**
 * @param {SalienceRun[]} runs
 * @returns {number}
 */
function getMedianFontSize(runs) {
  const sorted = runs.toSorted((a, b) => a.fontSize - b.fontSize);
  const half = sorted.reduce((sum, run) => sum + run.textLength, 0) / 2;
  let seen = 0;
  for (const run of sorted) {
    seen += run.textLength;
    if (seen >= half) {
      return run.fontSize;
    }
  }
  return 16;
}

/**
 * Returns the heading level from the markup, or 2 for short text rendered much
 * larger than the rest of the page.
 *
 * @param {SalienceRun} run
 * @param {number} medianFontSize
 * @returns {number | null}
 */
function getHeadingLevelForRun(run, medianFontSize) {
  if (run.headingLevel) {
    return run.headingLevel;
  }
  const isVisualHeading =
    run.fontSize >= medianFontSize * VISUAL_HEADING_FONT_SCALE &&
    run.textLength <= VISUAL_HEADING_MAX_LENGTH &&
    // Large numbers, like the ranks of a list, aren't headings.
    run.segments.some(segment => LETTER_REGEX.test(segment.text));
  return isVisualHeading ? 2 : null;
}

/**
 * @param {SalienceRun} run
 * @param {number | null} headingLevel
 * @param {boolean} useSimpleText
 * @returns {string}
 */
function formatRun(run, headingLevel, useSimpleText) {
  // A run that is one link, like a card or a menu item, reads the same without
  // the link target, and the target would use up the budget.
  const isSingleLink =
    run.linkTextLength === run.textLength &&
    new Set(run.segments.map(segment => segment.href).filter(Boolean)).size ===
      1;

  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < run.segments.length; ) {
    const { href } = run.segments[i];
    let text = "";
    for (; i < run.segments.length && run.segments[i].href === href; i++) {
      text += run.segments[i].text;
    }
    if (href && !useSimpleText && !isSingleLink) {
      const leading = text.slice(0, text.length - text.trimStart().length);
      const trailing = text.slice(text.trimEnd().length);
      parts.push(leading, escapeMarkdownLink(text.trim(), href), trailing);
    } else {
      parts.push(text);
    }
  }

  let text = parts.join("");
  text =
    run.preserveWhitespace && !useSimpleText
      ? text.replace(LEADING_NEWLINES_REGEX, "").trimEnd()
      : text.replace(WHITESPACE_REGEX, " ").trim();

  if (useSimpleText || !text || !headingLevel) {
    return text;
  }
  return `${"#".repeat(headingLevel)} ${text}`;
}

/**
 * Returns the children of an element in the flattened tree. A shadow host's
 * shadow tree replaces its light children, and a slot's assigned nodes replace
 * the slot's own children.
 *
 * @param {Element} element
 * @returns {Iterable<Node>}
 */
function flatChildren(element) {
  const shadowRoot = element.openOrClosedShadowRoot;
  if (shadowRoot) {
    return shadowRoot.childNodes;
  }
  if (HTMLSlotElement.isInstance(element)) {
    const assigned = element.assignedNodes({ flatten: true });
    if (assigned.length) {
      return assigned;
    }
  }
  return element.childNodes;
}

/**
 * @param {Element} element
 * @returns {Element | null}
 */
function getFlatParent(element) {
  const slot = element.assignedSlot;
  if (slot) {
    return slot;
  }
  const parent = element.parentNode;
  if (parent && ShadowRoot.isInstance(parent)) {
    return parent.host;
  }
  return asElement(parent);
}

/**
 * @param {Element} element
 * @returns {string | null}
 */
function getLinkHref(element) {
  const anchor = element.closest("a[href]");
  return anchor && HTMLAnchorElement.isInstance(anchor) ? anchor.href : null;
}

/**
 * @param {string} text
 * @param {CSSStyleDeclaration} style
 * @returns {string}
 */
function applyTextTransform(text, style) {
  switch (style.textTransform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    default:
      return text;
  }
}

/**
 * @param {RGBA} top
 * @param {RGBA} bottom - Must be opaque.
 * @returns {RGBA}
 */
function compositeOver(top, bottom) {
  const { a } = top;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/**
 * @see https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 *
 * @param {RGBA} a
 * @param {RGBA} b
 * @returns {number}
 */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * @see https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
 *
 * @param {RGBA} color
 * @returns {number}
 */
function relativeLuminance({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map(channel => {
    const c = Math.min(Math.max(channel, 0), 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/**
 * @param {DOMRectReadOnly} rect
 * @returns {Box}
 */
function toBox(rect) {
  const { left, top, right, bottom } = rect;
  return { left, top, right, bottom };
}

/**
 * @param {Box} box
 * @returns {number}
 */
function getArea({ left, top, right, bottom }) {
  return Math.max(right - left, 0) * Math.max(bottom - top, 0);
}

/**
 * @param {Box} a
 * @param {Box} b
 * @returns {Box}
 */
function intersectBoxes(a, b) {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/**
 * @param {Box} a
 * @param {Box} b
 * @returns {Box}
 */
function unionBoxes(a, b) {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * @param {Node | null} node
 * @returns {Element | null}
 */
function asElement(node) {
  return node?.nodeType === Node.ELEMENT_NODE
    ? /** @type {Element} */ (node)
    : null;
}
