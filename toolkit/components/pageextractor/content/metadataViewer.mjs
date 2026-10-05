/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { MetaTagEntry, StructuredDataNode, StructuredDataValue, StructuredMetadata } from '../PageExtractor.d.ts'
 */

const { getSchemaOrgAncestors, getSchemaOrgTypeName } =
  ChromeUtils.importESModule(
    "moz-src:///toolkit/components/pageextractor/SchemaOrgVocabulary.sys.mjs"
  );

/**
 * Tags that state the same thing in different vocabularies. Grouping them is
 * this viewer's choice; the parser keeps them apart.
 */
const TAG_GROUPS = [
  ["Title", ["og:title", "twitter:title"]],
  ["Description", ["description", "og:description", "twitter:description"]],
  [
    "Image",
    [
      "og:image",
      "og:image:url",
      "og:image:secure_url",
      "twitter:image",
      "twitter:image:src",
    ],
  ],
  ["Site name", ["og:site_name"]],
  ["Address", ["og:url"]],
];

const SOURCE_LABELS = {
  html: "HTML",
  opengraph: "Open Graph",
  twitter: "Twitter Card",
  link: "Link",
};

const browserWindow = window.browsingContext.topChromeWindow;
const tabPicker = /** @type {HTMLSelectElement} */ (
  document.getElementById("tab-picker")
);

/**
 * @param {string} tag
 * @param {object} [properties]
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElement}
 */
function h(tag, properties = {}, children = []) {
  const element = Object.assign(document.createElement(tag), properties);
  element.append(...children);
  return element;
}

/**
 * @param {string} type
 * @returns {HTMLElement}
 */
function renderType(type) {
  const name = getSchemaOrgTypeName(type);
  const ancestors = name ? getSchemaOrgAncestors(name) : [];
  let lineage = "";
  if (!name) {
    lineage = " (not a schema.org type)";
  } else if (ancestors.length) {
    lineage = ` is a kind of ${ancestors.join(" › ")}`;
  }
  return h("span", {}, [
    h("span", { className: "declared-type", textContent: name ?? type }),
    lineage ? h("span", { className: "lineage", textContent: lineage }) : "",
  ]);
}

function viewerTab() {
  return browserWindow.gBrowser.getTabForBrowser(
    window.browsingContext.top.embedderElement
  );
}

function fillTabPicker() {
  const ownTab = viewerTab();
  const tabs = browserWindow.gBrowser.tabs.filter(tab => tab != ownTab);
  const previous = tabPicker.value;
  tabPicker.replaceChildren(
    ...tabs.map((tab, index) =>
      h("option", {
        value: String(index),
        textContent: tab.label,
        tab,
      })
    )
  );
  const options = [...tabPicker.options];
  const mostRecent = options.reduce(
    (best, option) =>
      !best || option.tab.lastAccessed > best.tab.lastAccessed ? option : best,
    null
  );
  tabPicker.value = options.some(o => o.value == previous)
    ? previous
    : (mostRecent?.value ?? "");
}

/**
 * @returns {Promise<void>}
 */
async function read() {
  const status = document.getElementById("status");
  const option = tabPicker.selectedOptions[0];
  for (const id of ["summary", "tags", "nodes", "blocks"]) {
    document.getElementById(id).replaceChildren();
  }
  if (!option) {
    status.textContent = "Open a web page in another tab to inspect it.";
    return;
  }
  const browser = option.tab.linkedBrowser;
  let actor;
  try {
    actor =
      browser.browsingContext.currentWindowGlobal.getActor("PageExtractor");
  } catch {
    status.textContent = "This page cannot be inspected.";
    return;
  }
  status.textContent = "Reading…";
  const start = performance.now();
  /** @type {StructuredMetadata} */
  let metadata;
  try {
    ({ structuredMetadata: metadata } = await actor.getPageMetadata());
  } catch (error) {
    status.textContent = `The page could not be read: ${error.message}`;
    return;
  }
  status.textContent = `Read ${browser.currentURI.spec} in ${Math.round(
    performance.now() - start
  )} ms.`;
  renderSummary(metadata);
  renderTags(metadata);
  renderNodes(metadata.structuredData.nodes);
  renderBlocks(metadata);
}

/**
 * @param {StructuredMetadata} metadata
 */
function renderSummary(metadata) {
  const { nodes } = metadata.structuredData;
  /** @type {Map<string, string>} */
  const types = new Map();
  for (const type of nodes.filter(n => n.isTopLevel).flatMap(n => n.types)) {
    const key = getSchemaOrgTypeName(type) ?? type;
    if (!types.has(key)) {
      types.set(key, type);
    }
  }
  const syntaxes = [
    ...new Set(
      nodes.map(n => (n.syntax == "json-ld" ? "JSON-LD" : "Microdata"))
    ),
  ];
  document.getElementById("summary").append(
    h("h2", { textContent: "Declared types" }),
    types.size
      ? h(
          "ul",
          {},
          [...types.values()].map(type => h("li", {}, [renderType(type)]))
        )
      : h("p", { textContent: "The page declares no schema.org type." }),
    h("p", {
      className: "lineage",
      textContent: `${nodes.length} items from ${
        syntaxes.join(" and ") || "no structured data"
      }, ${metadata.metaTags.length} search and social tags.`,
    })
  );
}

/**
 * @param {StructuredMetadata} metadata
 */
function renderTags(metadata) {
  /** @type {(MetaTagEntry | { source: string, name: string, value: string })[]} */
  const entries = [
    ...metadata.metaTags,
    ...metadata.links.map(({ rel, href }) => ({
      source: "link",
      name: `link rel=${rel}`,
      value: href,
    })),
  ];
  const grouped = new Set();
  const rows = [];
  for (const [label, names] of TAG_GROUPS) {
    const found = entries.filter(
      e =>
        names.includes(e.name) ||
        (label == "Address" && e.name == "link rel=canonical")
    );
    if (!found.length) {
      continue;
    }
    found.forEach(e => grouped.add(e));
    const distinct = new Set(found.map(e => e.value.trim()));
    rows.push(
      h("tr", {}, [
        h("th", {}, [
          label,
          distinct.size > 1
            ? h("span", {
                className: "badge conflict",
                textContent: "sources disagree",
              })
            : "",
        ]),
        h(
          "td",
          {},
          found.map(e =>
            h("div", {}, [
              h("span", {
                className: "badge",
                textContent: `${SOURCE_LABELS[e.source]} ${e.name}`,
              }),
              " ",
              e.value,
            ])
          )
        ),
      ])
    );
  }
  for (const e of entries.filter(e => !grouped.has(e))) {
    rows.push(
      h("tr", {}, [
        h("th", {}, [e.name]),
        h("td", {}, [
          h("span", {
            className: "badge",
            textContent: SOURCE_LABELS[e.source],
          }),
          " ",
          e.value,
        ]),
      ])
    );
  }
  document
    .getElementById("tags")
    .append(
      rows.length
        ? h("table", {}, rows)
        : h("p", { textContent: "No search or social tags." })
    );
}

/**
 * @param {StructuredDataNode[]} nodes
 */
function renderNodes(nodes) {
  /** @type {Map<string, number>} */
  const firstIndex = new Map();
  nodes.forEach((node, index) => {
    if (!firstIndex.has(node.id)) {
      firstIndex.set(node.id, index);
    }
  });

  /**
   * @param {StructuredDataValue} value
   * @returns {Node | string}
   */
  const renderValue = value => {
    if (typeof value != "object") {
      return String(value);
    }
    if ("@value" in value) {
      const qualifiers = [value["@type"], value["@language"]].filter(Boolean);
      return `${value["@value"]}${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}`;
    }
    if ("@list" in value) {
      return h(
        "ol",
        {},
        value["@list"].map(item => h("li", {}, [renderValue(item)]))
      );
    }
    const index = firstIndex.get(value["@id"]);
    if (index === undefined) {
      return h("span", { className: "id", textContent: value["@id"] });
    }
    const target = nodes[index];
    const name = target.properties.name?.[0];
    const label = [
      target.types.map(t => getSchemaOrgTypeName(t) ?? t).join("/"),
      name !== undefined && typeof name != "object" ? `"${name}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return h("a", {
      href: `#node-${index}`,
      textContent: `→ ${label || value["@id"]}`,
    });
  };

  const order = [
    ...nodes.filter(n => n.isTopLevel),
    ...nodes.filter(n => !n.isTopLevel),
  ];
  document.getElementById("nodes").append(
    ...order.map(node =>
      h("article", { className: "card", id: `node-${nodes.indexOf(node)}` }, [
        h("div", { className: "card-header" }, [
          ...(node.types.length
            ? node.types.map(renderType)
            : [h("span", { className: "declared-type", textContent: "Item" })]),
          h("span", {
            className: "badge",
            textContent:
              node.syntax == "json-ld"
                ? `JSON-LD block ${node.blockIndex + 1}`
                : "Microdata",
          }),
          h("span", {
            className: "badge",
            textContent: node.isTopLevel ? "top level" : "nested",
          }),
          h("span", { className: "id", textContent: node.id }),
        ]),
        h(
          "table",
          {},
          Object.entries(node.properties).map(([property, values]) =>
            h("tr", {}, [
              h("th", { textContent: property }),
              h(
                "td",
                {},
                values.map(value => h("div", {}, [renderValue(value)]))
              ),
            ])
          )
        ),
      ])
    )
  );
  if (!nodes.length) {
    document
      .getElementById("nodes")
      .append(h("p", { textContent: "No JSON-LD or microdata." }));
  }
}

/**
 * @param {StructuredMetadata} metadata
 */
function renderBlocks(metadata) {
  const { jsonLdBlocks } = metadata.structuredData;
  document.getElementById("blocks").append(
    ...jsonLdBlocks.map((block, index) =>
      h("li", {
        textContent: `Block ${index + 1}: ${block.status}${
          typeof block.context == "string" ? `, context ${block.context}` : ""
        }`,
      })
    )
  );
  if (!jsonLdBlocks.length) {
    document
      .getElementById("blocks")
      .append(h("li", { textContent: "No JSON-LD blocks." }));
  }
}

tabPicker.addEventListener("change", read);
document.getElementById("refresh").addEventListener("click", () => {
  fillTabPicker();
  read();
});
fillTabPicker();
read();
