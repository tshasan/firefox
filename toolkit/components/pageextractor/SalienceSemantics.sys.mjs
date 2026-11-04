/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @ts-check

const IMPLICIT_ROLES = new Map([
  ["MAIN", "main"],
  ["ARTICLE", "article"],
  ["SECTION", "region"],
  ["DIALOG", "dialog"],
  ["ASIDE", "complementary"],
  ["NAV", "navigation"],
  ["SEARCH", "search"],
  ["SELECT", "combobox"],
  ["BUTTON", "button"],
  ["TABLE", "table"],
  ["TR", "row"],
  ["TH", "columnheader"],
  ["TD", "cell"],
  ["UL", "list"],
  ["OL", "list"],
  ["LI", "listitem"],
]);
const AUXILIARY_ROLES = new Set([
  "combobox",
  "listbox",
  "menu",
  "menubar",
  "tablist",
  "toolbar",
  "search",
]);
const SECTION_ROLES = new Set([
  "main",
  "article",
  "region",
  "dialog",
  "alertdialog",
  "tabpanel",
]);
const ROLES = new Set([
  ...IMPLICIT_ROLES.values(),
  ...AUXILIARY_ROLES,
  ...SECTION_ROLES,
  "banner",
  "contentinfo",
  "heading",
  "rowheader",
  "grid",
  "gridcell",
  "tab",
  "option",
  "group",
  "link",
  "textbox",
  "none",
  "presentation",
  "alert",
  "application",
  "blockquote",
  "caption",
  "checkbox",
  "code",
  "definition",
  "deletion",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "img",
  "insertion",
  "log",
  "marquee",
  "math",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "note",
  "paragraph",
  "progressbar",
  "radio",
  "radiogroup",
  "rowgroup",
  "scrollbar",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "term",
  "time",
  "timer",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const ROLE_TOKEN_SEPARATOR = /\s+/;

/** Elements past this many accessibility lookups use their DOM role. */
const MAX_ACCESSIBILITY_LOOKUPS = 64;

/** How long to wait for a newly created accessible tree to fill in. */
const MAX_TREE_READY_WAIT_MS = 250;
const TREE_READY_POLL_MS = 10;

/** Accessible roles that change how the extractor treats an element. */
const NATIVE_ROLES = new Map([
  [Ci.nsIAccessibleRole.ROLE_HEADING, "heading"],
  [Ci.nsIAccessibleRole.ROLE_COMBOBOX, "combobox"],
  [Ci.nsIAccessibleRole.ROLE_LISTBOX, "listbox"],
  [Ci.nsIAccessibleRole.ROLE_COMBOBOX_LIST, "listbox"],
  [Ci.nsIAccessibleRole.ROLE_MENUPOPUP, "menu"],
  [Ci.nsIAccessibleRole.ROLE_MENUBAR, "menubar"],
  [Ci.nsIAccessibleRole.ROLE_PAGETABLIST, "tablist"],
  [Ci.nsIAccessibleRole.ROLE_PAGETAB, "tab"],
  [Ci.nsIAccessibleRole.ROLE_TABLE, "table"],
  [Ci.nsIAccessibleRole.ROLE_ROW, "row"],
  [Ci.nsIAccessibleRole.ROLE_COLUMNHEADER, "columnheader"],
  [Ci.nsIAccessibleRole.ROLE_ROWHEADER, "rowheader"],
  [Ci.nsIAccessibleRole.ROLE_CELL, "cell"],
  [Ci.nsIAccessibleRole.ROLE_TOOLBAR, "toolbar"],
]);

/** Documents whose accessible tree already had its chance to fill in. */
const preparedDocuments = new WeakSet();

/**
 * @typedef {object} ElementSemantics
 * @property {string | null} role - The ARIA role, explicit or implicit.
 * @property {number | null} headingLevel - 1-6, or null for non-headings.
 * @property {boolean} isSection - Whether the element starts a new section.
 * @property {boolean} isAuxiliary - Whether the element is a control, like a
 *   menu or a toolbar, rather than content.
 */

/**
 * Whether the element opens or controls a popup, like a menu button.
 *
 * @param {Element} element
 * @returns {boolean}
 */
export function controlsPopup(element) {
  return Boolean(
    element.getAttribute("aria-controls")?.trim() ||
    (element.hasAttribute("aria-haspopup") &&
      element.getAttribute("aria-haspopup") !== "false")
  );
}

/**
 * Rethrows anything but an XPCOM failure, which is how the accessibility
 * service reports that it is unavailable.
 *
 * @param {unknown} error
 */
function ignoreXPCOMError(error) {
  if (!(error instanceof Ci.nsIException)) {
    throw error;
  }
}

/**
 * Roles and heading hints for one extraction, from the accessibility tree when
 * it has an accessible for the element, and from DOM and ARIA otherwise.
 */
export class SalienceSemantics {
  /** @type {Map<Element, ElementSemantics>} */
  #cache = new Map();

  /** @type {nsIAccessibilityService | null} */
  #service = null;

  #lookups = 0;

  /**
   * @param {Document} document
   * @returns {Promise<SalienceSemantics>}
   */
  static async create(document) {
    const semantics = new SalienceSemantics();
    try {
      if (!Services.appinfo.accessibilityEnabled) {
        // Shutting the service down drops the document's accessible tree, so
        // the next start has to wait for a new one.
        preparedDocuments.delete(document);
      }
      const service = Cc["@mozilla.org/accessibilityService;1"].getService(
        Ci.nsIAccessibilityService
      );
      let accessible = service.getAccessibleFor(document);
      if (!accessible) {
        return semantics;
      }
      if (!preparedDocuments.has(document)) {
        const deadline = ChromeUtils.now() + MAX_TREE_READY_WAIT_MS;
        while (
          accessible &&
          !accessible.childCount &&
          ChromeUtils.now() < deadline
        ) {
          await new Promise(resolve =>
            /** @type {Window} */ (document.defaultView).setTimeout(
              resolve,
              TREE_READY_POLL_MS
            )
          );
          accessible = service.getAccessibleFromCache(document);
        }
        preparedDocuments.add(document);
      }
      semantics.#service = service;
    } catch (error) {
      ignoreXPCOMError(error);
    }
    return semantics;
  }

  dispose() {
    this.#service = null;
    this.#cache.clear();
  }

  /**
   * @param {Element} element
   * @returns {ElementSemantics}
   */
  get(element) {
    let semantics = this.#cache.get(element);
    if (semantics) {
      return semantics;
    }
    const tag = element.tagName.toUpperCase();
    const explicitRole = element
      .getAttribute("role")
      ?.trim()
      .split(ROLE_TOKEN_SEPARATOR)
      .find(role => ROLES.has(role));
    let role = explicitRole ?? IMPLICIT_ROLES.get(tag) ?? null;
    if (
      !explicitRole &&
      tag === "TH" &&
      element.getAttribute("scope") === "row"
    ) {
      role = "rowheader";
    }
    if (
      !explicitRole &&
      tag === "SELECT" &&
      /** @type {HTMLSelectElement} */ (
        element.multiple || /** @type {HTMLSelectElement} */ (element).size > 1
      )
    ) {
      role = "listbox";
    }
    if (!explicitRole && HEADING_TAGS.has(tag)) {
      role = "heading";
    }
    if (
      !explicitRole &&
      (tag === "HEADER" || tag === "FOOTER") &&
      !element.parentElement?.closest("article, aside, main, nav, section")
    ) {
      role = tag === "HEADER" ? "banner" : "contentinfo";
    }
    if (
      this.#service &&
      (role || tag.includes("-") || element.hasAttribute("tabindex")) &&
      this.#lookups < MAX_ACCESSIBILITY_LOOKUPS
    ) {
      this.#lookups++;
      try {
        const accessible = this.#service.getAccessibleFromCache(element);
        if (accessible) {
          role = NATIVE_ROLES.get(accessible.role) ?? role;
        }
      } catch (error) {
        ignoreXPCOMError(error);
      }
    }
    let headingLevel = null;
    if (role === "heading") {
      const level =
        explicitRole === "heading"
          ? parseInt(element.getAttribute("aria-level") ?? "", 10)
          : Number(tag.slice(1));
      headingLevel = level > 0 ? Math.min(level, 6) : 2;
    }
    semantics = {
      role,
      headingLevel,
      isSection: role !== null && SECTION_ROLES.has(role),
      isAuxiliary:
        (role !== null && AUXILIARY_ROLES.has(role)) ||
        (role === "button" && controlsPopup(element)),
    };
    this.#cache.set(element, semantics);
    return semantics;
  }
}
