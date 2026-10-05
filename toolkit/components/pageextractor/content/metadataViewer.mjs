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
/** @type {Map<string, MozTabbrowserTab>} */
let tabsByValue = new Map();

/**
 * @param {string} tag
 * @param {object} [properties]
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElement}
 */
function buildElement(tag, properties = {}, children = []) {
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
  return buildElement("span", {}, [
    buildElement("span", {
      className: "declared-type",
      textContent: name ?? type,
    }),
    lineage
      ? buildElement("span", { className: "lineage", textContent: lineage })
      : "",
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
  tabsByValue = new Map(tabs.map((tab, index) => [String(index), tab]));
  tabPicker.replaceChildren(
    ...[...tabsByValue].map(([value, tab]) =>
      buildElement("option", { value, textContent: tab.label })
    )
  );
  const mostRecent = tabs.reduce(
    (best, tab) => (!best || tab.lastAccessed > best.lastAccessed ? tab : best),
    null
  );
  if (tabsByValue.has(previous)) {
    tabPicker.value = previous;
  } else if (mostRecent) {
    tabPicker.value = String(tabs.indexOf(mostRecent));
  }
}

/**
 * @returns {Promise<void>}
 */
async function read() {
  const status = document.getElementById("status");
  const tab = tabsByValue.get(tabPicker.value);
  for (const id of ["summary", "tags", "nodes", "blocks"]) {
    document.getElementById(id).replaceChildren();
  }
  if (!tab) {
    status.textContent = "Open a web page in another tab to inspect it.";
    return;
  }
  const browser = tab.linkedBrowser;
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
    metadata = await actor.getStructuredMetadata();
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
  for (const type of nodes
    .filter(node => node.isTopLevel)
    .flatMap(node => node.types)) {
    const key = getSchemaOrgTypeName(type) ?? type;
    if (!types.has(key)) {
      types.set(key, type);
    }
  }
  const syntaxes = [
    ...new Set(
      nodes.map(node => (node.syntax == "json-ld" ? "JSON-LD" : "Microdata"))
    ),
  ];
  document.getElementById("summary").append(
    buildElement("h2", { textContent: "Declared types" }),
    types.size
      ? buildElement(
          "ul",
          {},
          [...types.values()].map(type =>
            buildElement("li", {}, [renderType(type)])
          )
        )
      : buildElement("p", {
          textContent: "The page declares no schema.org type.",
        }),
    buildElement("p", {
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
      entry =>
        names.includes(entry.name) ||
        (label == "Address" && entry.name == "link rel=canonical")
    );
    if (!found.length) {
      continue;
    }
    found.forEach(entry => grouped.add(entry));
    const distinct = new Set(found.map(entry => entry.value.trim()));
    rows.push(
      buildElement("tr", {}, [
        buildElement("th", {}, [
          label,
          distinct.size > 1
            ? buildElement("span", {
                className: "badge conflict",
                textContent: "sources disagree",
              })
            : "",
        ]),
        buildElement(
          "td",
          {},
          found.map(entry =>
            buildElement("div", {}, [
              buildElement("span", {
                className: "badge",
                textContent: `${SOURCE_LABELS[entry.source]} ${entry.name}`,
              }),
              " ",
              entry.value,
            ])
          )
        ),
      ])
    );
  }
  for (const entry of entries.filter(entry => !grouped.has(entry))) {
    rows.push(
      buildElement("tr", {}, [
        buildElement("th", {}, [entry.name]),
        buildElement("td", {}, [
          buildElement("span", {
            className: "badge",
            textContent: SOURCE_LABELS[entry.source],
          }),
          " ",
          entry.value,
        ]),
      ])
    );
  }
  document
    .getElementById("tags")
    .append(
      rows.length
        ? buildElement("table", {}, rows)
        : buildElement("p", { textContent: "No search or social tags." })
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
      return buildElement(
        "ol",
        {},
        value["@list"].map(item => buildElement("li", {}, [renderValue(item)]))
      );
    }
    const index = firstIndex.get(value["@id"]);
    if (index === undefined) {
      return buildElement("span", {
        className: "id",
        textContent: value["@id"],
      });
    }
    const target = nodes[index];
    const name = target.properties.name?.[0];
    const label = [
      target.types.map(type => getSchemaOrgTypeName(type) ?? type).join("/"),
      name !== undefined && typeof name != "object" ? `"${name}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return buildElement("a", {
      href: `#node-${index}`,
      textContent: `→ ${label || value["@id"]}`,
    });
  };

  const indices = [...nodes.keys()];
  const order = [
    ...indices.filter(index => nodes[index].isTopLevel),
    ...indices.filter(index => !nodes[index].isTopLevel),
  ];
  document.getElementById("nodes").append(
    ...order.map(index => {
      const node = nodes[index];
      return buildElement(
        "article",
        { className: "card", id: `node-${index}` },
        [
          buildElement("div", { className: "card-header" }, [
            ...(node.types.length
              ? node.types.map(renderType)
              : [
                  buildElement("span", {
                    className: "declared-type",
                    textContent: "Item",
                  }),
                ]),
            buildElement("span", {
              className: "badge",
              textContent:
                node.syntax == "json-ld"
                  ? `JSON-LD block ${node.blockIndex + 1}`
                  : "Microdata",
            }),
            buildElement("span", {
              className: "badge",
              textContent: node.isTopLevel ? "top level" : "nested",
            }),
            buildElement("span", { className: "id", textContent: node.id }),
          ]),
          buildElement(
            "table",
            {},
            Object.entries(node.properties).map(([property, values]) =>
              buildElement("tr", {}, [
                buildElement("th", { textContent: property }),
                buildElement(
                  "td",
                  {},
                  values.map(value =>
                    buildElement("div", {}, [renderValue(value)])
                  )
                ),
              ])
            )
          ),
        ]
      );
    })
  );
  if (!nodes.length) {
    document
      .getElementById("nodes")
      .append(buildElement("p", { textContent: "No JSON-LD or microdata." }));
  }
}

/**
 * @param {StructuredMetadata} metadata
 */
function renderBlocks(metadata) {
  const { jsonLdBlocks } = metadata.structuredData;
  document.getElementById("blocks").append(
    ...jsonLdBlocks.map((block, index) =>
      buildElement("li", {
        textContent: `Block ${index + 1}: ${block.status}${
          typeof block.context == "string" ? `, context ${block.context}` : ""
        }`,
      })
    )
  );
  if (!jsonLdBlocks.length) {
    document
      .getElementById("blocks")
      .append(buildElement("li", { textContent: "No JSON-LD blocks." }));
  }
}

tabPicker.addEventListener("change", read);
document.getElementById("refresh").addEventListener("click", () => {
  fillTabPicker();
  read();
});
fillTabPicker();
read();
