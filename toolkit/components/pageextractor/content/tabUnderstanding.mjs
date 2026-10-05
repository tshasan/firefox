/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { StructuredDataNode, StructuredDataValue, StructuredMetadata } from '../PageExtractor.d.ts'
 */

const { getSchemaOrgAncestors, getSchemaOrgTypeName, isSchemaOrgType } =
  ChromeUtils.importESModule(
    "moz-src:///toolkit/components/pageextractor/SchemaOrgVocabulary.sys.mjs"
  );

/**
 * Types that describe the site around the content rather than the content.
 */
const SCAFFOLDING_TYPES = new Set([
  "BreadcrumbList",
  "CollectionPage",
  "ImageObject",
  "ItemList",
  "Person",
  "SearchAction",
  "SiteNavigationElement",
  "SpeakableSpecification",
  "WebPage",
  "WebSite",
  "WPFooter",
  "WPHeader",
]);

/**
 * @typedef {Map<string, StructuredDataNode>} NodesById
 */

/**
 * @typedef {object} Fact
 * @property {string} label - Shown next to the value.
 * @property {string[]} paths - Property paths to try in order, following
 *   references, e.g. "author.name".
 * @property {(values: StructuredDataValue[], nodesById: NodesById) => string} [format] - Turns
 *   the values into display text. Defaults to the first literal value.
 */

/**
 * @typedef {object} Group
 * @property {string} label - The heading the group's tabs are shown under.
 * @property {string[]} types - schema.org types, matched with their subtypes.
 * @property {string[]} [openGraphTypes] - og:type values, for pages without
 *   schema.org data.
 * @property {Fact[]} facts - The key facts shown for a page of this kind.
 */

/**
 * The kinds of page, most specific first: a recipe page often also declares
 * itself an Article, and the recipe is what it is about.
 *
 * @type {Group[]}
 */
const GROUPS = [
  {
    label: "Recipes",
    types: ["Recipe"],
    facts: [
      { label: "Total time", paths: ["totalTime"], format: formatDuration },
      { label: "Serves", paths: ["recipeYield"] },
      {
        label: "Ingredients",
        paths: ["recipeIngredient"],
        format: values => String(values.length),
      },
      { label: "Rating", paths: ["aggregateRating"], format: formatRating },
      { label: "By", paths: ["author.name"] },
    ],
  },
  {
    label: "Events",
    types: ["Event"],
    facts: [
      { label: "When", paths: ["startDate"], format: formatDate },
      { label: "Where", paths: ["location.name", "location"] },
    ],
  },
  {
    label: "Shopping",
    types: ["Product", "ProductGroup"],
    openGraphTypes: ["product", "og:product"],
    facts: [
      { label: "Brand", paths: ["brand.name", "brand"] },
      { label: "Price", paths: ["offers"], format: formatPrice },
      {
        label: "Availability",
        paths: ["offers.availability"],
        format: formatEnumeration,
      },
      { label: "Rating", paths: ["aggregateRating"], format: formatRating },
    ],
  },
  {
    label: "Watch, read and listen",
    types: [
      "Book",
      "CreativeWorkSeries",
      "Movie",
      "MusicAlbum",
      "MusicPlaylist",
      "MusicRecording",
      "PodcastEpisode",
      "TVEpisode",
      "TVSeries",
      "VideoGame",
      "VideoObject",
    ],
    openGraphTypes: [
      "book",
      "music.album",
      "music.playlist",
      "music.song",
      "video.episode",
      "video.movie",
      "video.other",
      "video.tv_show",
    ],
    facts: [
      {
        label: "By",
        paths: [
          "director.name",
          "author.name",
          "byArtist.name",
          "creator.name",
        ],
      },
      {
        label: "Released",
        paths: ["datePublished", "dateCreated", "uploadDate"],
        format: formatDate,
      },
      { label: "Length", paths: ["duration"], format: formatDuration },
      { label: "Rating", paths: ["aggregateRating"], format: formatRating },
    ],
  },
  {
    label: "Learning",
    types: ["Course", "LearningResource"],
    facts: [
      { label: "From", paths: ["provider.name", "provider"] },
      { label: "Rating", paths: ["aggregateRating"], format: formatRating },
    ],
  },
  {
    label: "Apps and code",
    types: ["SoftwareApplication", "SoftwareSourceCode"],
    facts: [
      { label: "Category", paths: ["applicationCategory"] },
      { label: "Runs on", paths: ["operatingSystem"] },
      { label: "Rating", paths: ["aggregateRating"], format: formatRating },
    ],
  },
  {
    label: "Health",
    types: ["MedicalWebPage", "MedicalEntity"],
    facts: [{ label: "Reviewed", paths: ["lastReviewed"], format: formatDate }],
  },
  {
    label: "Places",
    types: ["Place"],
    facts: [
      { label: "Address", paths: ["address.streetAddress", "address"] },
      { label: "Rating", paths: ["aggregateRating"], format: formatRating },
    ],
  },
  {
    label: "Articles",
    types: ["Article"],
    openGraphTypes: ["article"],
    facts: [
      { label: "Published", paths: ["datePublished"], format: formatDate },
      { label: "Updated", paths: ["dateModified"], format: formatDate },
      { label: "By", paths: ["author.name", "author"] },
      { label: "Section", paths: ["articleSection"] },
    ],
  },
  {
    label: "Guides and answers",
    types: ["FAQPage", "QAPage", "HowTo"],
    facts: [],
  },
];

const OTHER_GROUP = { label: "Other pages", types: [], facts: [] };
const NOT_LOADED_GROUP = { label: "Not loaded yet", types: [], facts: [] };

const browserWindow = window.browsingContext.topChromeWindow;

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
 * @param {StructuredDataValue[]} values
 * @returns {string}
 */
function literal(values) {
  const [value] = values;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value != "object") {
    return String(value);
  }
  if ("@value" in value) {
    return String(value["@value"]);
  }
  return "";
}

/**
 * @param {StructuredDataValue[]} values
 * @returns {string} The first value, with schema.org enumeration members such
 *   as "https://schema.org/InStock" read as words.
 */
function formatText(values) {
  const text = literal(values);
  return /^https?:\/\/schema\.org\//i.test(text)
    ? formatEnumeration(values)
    : text;
}

/**
 * @param {StructuredDataValue[]} values
 * @returns {string} e.g. "1 hr 15 min" for "PT1H15M".
 */
function formatDuration(values) {
  const text = literal(values);
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:[\d.]+S)?)?$/i.exec(
    text
  );
  if (!match) {
    return text;
  }
  let [, days, hours, minutes] = match.map(Number);
  // Pages often state a long time in minutes alone, e.g. PT260M.
  hours = (hours || 0) + Math.floor((minutes || 0) / 60);
  minutes = (minutes || 0) % 60;
  const parts = [];
  if (days) {
    parts.push(`${days} d`);
  }
  if (hours) {
    parts.push(`${hours} hr`);
  }
  if (minutes) {
    parts.push(`${minutes} min`);
  }
  return parts.join(" ") || text;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * @param {StructuredDataValue[]} values
 * @returns {string}
 */
function formatDate(values) {
  const text = literal(values);
  const date = new Date(text);
  if (isNaN(date)) {
    return text;
  }
  return (/T\d/.test(text) ? DATE_TIME_FORMAT : DATE_FORMAT).format(date);
}

/**
 * @param {StructuredDataValue[]} values
 * @returns {string} e.g. "In stock" for "https://schema.org/InStock".
 */
function formatEnumeration(values) {
  const name = literal(values).replace(/^.*[/:]/, "");
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * @param {StructuredDataValue | undefined} value
 * @param {NodesById} nodesById
 * @returns {StructuredDataNode | undefined} The node a reference points to.
 */
function resolveNode(value, nodesById) {
  return value && typeof value == "object" && "@id" in value
    ? nodesById.get(value["@id"])
    : undefined;
}

/**
 * @param {StructuredDataValue[]} values
 * @param {NodesById} nodesById
 * @returns {string} e.g. "★ 4.8 (1,234)".
 */
function formatRating(values, nodesById) {
  const rating = resolveNode(values[0], nodesById);
  if (!rating) {
    return "";
  }
  const value = Number(literal(rating.properties.ratingValue ?? []));
  if (!value) {
    return "";
  }
  const count = Number(
    literal(
      rating.properties.ratingCount ?? rating.properties.reviewCount ?? []
    )
  );
  const best = Number(literal(rating.properties.bestRating ?? [])) || 5;
  const shown = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const score = best == 5 ? `★ ${shown}` : `${shown}/${best}`;
  return count ? `${score} (${count.toLocaleString()})` : score;
}

/**
 * @param {StructuredDataValue[]} values
 * @param {NodesById} nodesById
 * @returns {string}
 */
function formatPrice(values, nodesById) {
  const offer = resolveNode(values[0], nodesById);
  if (!offer) {
    return "";
  }
  const amount = Number(
    literal(offer.properties.price ?? offer.properties.lowPrice ?? [])
  );
  if (!amount) {
    return "";
  }
  const currency = literal(offer.properties.priceCurrency ?? []);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`.trim();
  }
}

/**
 * Follows a property path through references, e.g. "author.name".
 *
 * @param {StructuredDataNode} node
 * @param {string} path
 * @param {NodesById} nodesById
 * @returns {StructuredDataValue[]}
 */
function readPath(node, path, nodesById) {
  let values = [];
  /** @type {StructuredDataNode | undefined} */
  let current = node;
  for (const property of path.split(".")) {
    values = current?.properties[property] ?? [];
    current = resolveNode(values[0], nodesById);
  }
  return values;
}

/**
 * @param {StructuredDataNode} node
 * @returns {boolean}
 */
function isScaffolding(node) {
  return node.types.every(type => {
    const name = getSchemaOrgTypeName(type);
    return (
      !name ||
      SCAFFOLDING_TYPES.has(name) ||
      (isSchemaOrgType(name, "Organization") && !isSchemaOrgType(name, "Place"))
    );
  });
}

/**
 * Finds what kind of page this is from the page's own declarations: the
 * schema.org type of its main item, or else its Open Graph type.
 *
 * @param {StructuredMetadata} metadata
 * @returns {{ group: Group, node: StructuredDataNode | null, via: string }}
 */
function classify(metadata) {
  const candidates = metadata.structuredData.nodes.filter(
    node => node.isTopLevel && !isScaffolding(node)
  );
  for (const group of GROUPS) {
    const node = candidates.find(candidate =>
      candidate.types.some(type =>
        group.types.some(groupType => isSchemaOrgType(type, groupType))
      )
    );
    if (node) {
      return { group, node, via: "schema.org" };
    }
  }
  const openGraphType = metadata.metaTags
    .find(tag => tag.name == "og:type")
    ?.value.toLowerCase();
  for (const group of GROUPS) {
    if (openGraphType && group.openGraphTypes?.includes(openGraphType)) {
      return { group, node: null, via: "Open Graph" };
    }
  }
  return { group: OTHER_GROUP, node: null, via: "" };
}

/**
 * @param {StructuredDataNode} node
 * @returns {string} e.g. "Recipe, a kind of HowTo".
 */
function describeType(node) {
  const type = node.types.find(getSchemaOrgTypeName);
  if (!type) {
    return node.types[0] ?? "";
  }
  const name = getSchemaOrgTypeName(type);
  const parent = getSchemaOrgAncestors(name).find(
    ancestor => ancestor != "Thing"
  );
  return parent ? `${name}, a kind of ${parent}` : name;
}

/**
 * Builds an iCalendar file for an event, so it can be added to a calendar.
 *
 * @param {StructuredDataNode} node
 * @param {string} url
 * @param {NodesById} nodesById
 * @returns {Blob | null} null when the event has no start date.
 */
function eventCalendarFile(node, url, nodesById) {
  const start = new Date(literal(node.properties.startDate ?? []));
  if (isNaN(start)) {
    return null;
  }
  const end = new Date(literal(node.properties.endDate ?? []));
  const stamp = date => date.toISOString().replace(/[-:]|\.\d+/g, "");
  const escapeText = text =>
    text.replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mozilla//Firefox tab understanding//EN",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    ...(isNaN(end) ? [] : [`DTEND:${stamp(end)}`]),
    `SUMMARY:${escapeText(literal(node.properties.name ?? []))}`,
    `LOCATION:${escapeText(literal(readPath(node, "location.name", nodesById)))}`,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return new Blob([lines.join("\r\n")], { type: "text/calendar" });
}

/**
 * @param {MozTabbrowserTab} tab
 * @param {StructuredMetadata} metadata
 * @param {{ group: Group, node: StructuredDataNode | null, via: string }} kind
 * @param {number} durationMs
 * @returns {HTMLElement}
 */
function renderCard(tab, metadata, kind, durationMs) {
  const { node, group, via } = kind;
  const url = tab.linkedBrowser.currentURI.spec;
  /** @type {NodesById} */
  const nodesById = new Map();
  for (const candidate of metadata.structuredData.nodes) {
    if (!nodesById.has(candidate.id)) {
      nodesById.set(candidate.id, candidate);
    }
  }
  const facts = [];
  if (node) {
    for (const fact of group.facts) {
      for (const path of fact.paths) {
        const values = readPath(node, path, nodesById);
        const text = values.length
          ? (fact.format ?? formatText)(values, nodesById).trim()
          : "";
        if (text) {
          facts.push(
            buildElement("dt", { textContent: fact.label }),
            buildElement("dd", { textContent: text })
          );
          break;
        }
      }
    }
  }

  const description = metadata.metaTags.find(tag =>
    ["description", "og:description"].includes(tag.name)
  )?.value;

  const actions = [
    buildElement("button", {
      textContent: "Go to tab",
      onclick: () => (browserWindow.gBrowser.selectedTab = tab),
    }),
  ];
  const ingredients = node?.properties.recipeIngredient?.map(value =>
    literal([value])
  );
  /** @type {HTMLElement | null} */
  let ingredientList = null;
  if (ingredients?.length) {
    ingredientList = buildElement(
      "ul",
      { className: "ingredients", hidden: true },
      ingredients.map(item => buildElement("li", { textContent: item }))
    );
    const list = ingredientList;
    actions.push(
      buildElement("button", {
        textContent: "Show ingredients",
        onclick: event => {
          list.hidden = !list.hidden;
          event.target.textContent = list.hidden
            ? "Show ingredients"
            : "Hide ingredients";
        },
      })
    );
  }
  if (node && group.label == "Events") {
    const calendarFile = eventCalendarFile(node, url, nodesById);
    if (calendarFile) {
      actions.push(
        buildElement("button", {
          textContent: "Add to calendar",
          onclick: () => {
            const href = URL.createObjectURL(calendarFile);
            buildElement("a", { href, download: "event.ics" }).click();
            // The download reads the file asynchronously.
            setTimeout(() => URL.revokeObjectURL(href));
          },
        })
      );
    }
  }

  const host = URL.parse(url)?.host ?? url;
  return buildElement("article", { className: "card" }, [
    buildElement("div", { className: "card-title" }, [
      tab.image ? buildElement("img", { src: tab.image, alt: "" }) : "",
      buildElement("span", { textContent: tab.label }),
    ]),
    buildElement("div", {
      className: "meta",
      textContent: [
        host,
        node
          ? `declares ${describeType(node)}`
          : via && `Open Graph says ${group.label}`,
        `read in ${durationMs} ms`,
      ]
        .filter(Boolean)
        .join(" · "),
    }),
    facts.length ? buildElement("dl", { className: "facts" }, facts) : "",
    description && !facts.length
      ? buildElement("p", {
          className: "description",
          textContent: description,
        })
      : "",
    ingredientList ?? "",
    buildElement("div", { className: "actions" }, actions),
  ]);
}

/**
 * @typedef {{ status: "read", metadata: StructuredMetadata, durationMs: number } | { status: "not-loaded" | "not-web" }} TabReading
 */

/**
 * @param {MozTabbrowserTab} tab
 * @returns {Promise<TabReading>}
 */
async function readTab(tab) {
  const windowGlobal = tab.linkedBrowser.browsingContext?.currentWindowGlobal;
  if (tab.hasAttribute("pending") || !windowGlobal) {
    return { status: "not-loaded" };
  }
  let actor;
  try {
    actor = windowGlobal.getActor("PageExtractor");
  } catch {
    // Not a web page, e.g. about:newtab.
    return { status: "not-web" };
  }
  const start = performance.now();
  try {
    const metadata = await actor.getStructuredMetadata();
    return {
      status: "read",
      metadata,
      durationMs: Math.round(performance.now() - start),
    };
  } catch {
    return { status: "not-loaded" };
  }
}

async function render() {
  const status = document.getElementById("status");
  const ownBrowser = window.browsingContext.top.embedderElement;
  const tabs = browserWindow.gBrowser.tabs.filter(
    tab => tab.linkedBrowser != ownBrowser
  );
  status.textContent = `Reading ${tabs.length} tabs…`;
  const start = performance.now();
  const results = await Promise.all(tabs.map(readTab));
  const totalMs = Math.round(performance.now() - start);

  /** @type {Map<Group, HTMLElement[]>} */
  const cardsByGroup = new Map();
  let read = 0;
  results.forEach((result, index) => {
    if (result.status == "not-web") {
      return;
    }
    const tab = tabs[index];
    let card;
    let group = NOT_LOADED_GROUP;
    if (result.status == "read") {
      read++;
      const kind = classify(result.metadata);
      group = kind.group;
      card = renderCard(tab, result.metadata, kind, result.durationMs);
    } else {
      card = buildElement("article", { className: "card" }, [
        buildElement("div", { className: "card-title" }, [
          buildElement("span", { textContent: tab.label }),
        ]),
        buildElement("div", {
          className: "meta",
          textContent: "Select the tab to load it, then read again.",
        }),
      ]);
    }
    if (!cardsByGroup.has(group)) {
      cardsByGroup.set(group, []);
    }
    cardsByGroup.get(group).push(card);
  });

  const order = [...GROUPS, OTHER_GROUP, NOT_LOADED_GROUP];
  document.getElementById("groups").replaceChildren(
    ...order
      .filter(group => cardsByGroup.has(group))
      .map(group =>
        buildElement("section", { className: "group" }, [
          buildElement("h2", {}, [
            group.label,
            buildElement("span", {
              className: "count",
              textContent: String(cardsByGroup.get(group).length),
            }),
          ]),
          buildElement("div", { className: "cards" }, cardsByGroup.get(group)),
        ])
      )
  );
  status.textContent =
    `Read ${read} tabs in ${totalMs} ms, on this device. ` +
    "No AI model was used: each page says what it is.";
}

document.getElementById("refresh").addEventListener("click", render);
render();
