/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { JsonLdBlock, LinkEntry, MetaTagEntry, MetadataSource, StructuredDataNode, StructuredDataValue, StructuredMetadata } from './PageExtractor.d.ts'
 */

const HTML_META_NAMES = new Set([
  "description",
  "keywords",
  "author",
  "robots",
]);

/**
 * The Open Graph prefix and the vocabularies the protocol defines for its
 * object types. See https://ogp.me/#types
 */
const OPEN_GRAPH_PREFIXES = [
  "og:",
  "article:",
  "book:",
  "profile:",
  "music:",
  "video:",
];

const LINK_RELS = ["canonical"];

const JSON_LD_KEYWORDS = new Set([
  "@base",
  "@context",
  "@direction",
  "@graph",
  "@id",
  "@included",
  "@index",
  "@json",
  "@language",
  "@list",
  "@nest",
  "@reverse",
  "@set",
  "@type",
  "@value",
  "@vocab",
]);

/**
 * Pages reference the schema.org context rather than inline it. Its keyword
 * aliases are the only part of it that changes how a document is read without
 * expanding terms. See
 * https://github.com/schemaorg/schemaorg/blob/main/data/releases/30.1/schemaorgcontext.jsonld
 */
const SCHEMA_ORG_CONTEXT_URL =
  /^https?:\/\/schema\.org(\/(docs\/jsonldcontext\.jsonld?)?)?$/i;
const SCHEMA_ORG_CONTEXT_ALIASES = [
  ["id", "@id"],
  ["type", "@type"],
];

const MAX_META_TAGS = 500;
const MAX_JSON_LD_TOTAL_LENGTH = 2_000_000;
const MAX_NODES = 1000;
const MAX_DEPTH = 32;
const MAX_MICRODATA_VALUE_LENGTH = 10_000;
// Through itemref, many items can share the same properties, so the work and
// the output are bounded across all items rather than per item.
const MAX_MICRODATA_ELEMENTS = 200_000;
const MAX_MICRODATA_CHARACTERS = 1_000_000;

/**
 * Collects the SEO, social and schema.org metadata a page declares about
 * itself. Nothing is chosen or merged here: every value keeps its source, and
 * repeated or conflicting values are all returned so that callers can decide
 * which ones matter.
 *
 * @param {Document} document
 * @returns {StructuredMetadata}
 */
export function extractStructuredMetadata(document) {
  const collector = new NodeCollector();
  const jsonLdBlocks = extractJsonLd(document, collector);
  attempt(() => extractMicrodata(document, collector), undefined);
  return {
    metaTags: attempt(() => extractMetaTags(document), []),
    links: attempt(() => extractLinks(document), []),
    structuredData: { nodes: collector.nodes, jsonLdBlocks },
  };
}

/**
 * Keeps one malformed source from taking the others down with it.
 *
 * @template T
 * @param {() => T} task
 * @param {T} fallback
 * @returns {T}
 */
function attempt(task, fallback) {
  try {
    return task();
  } catch (error) {
    console.error("Failed to extract part of the structured metadata", error);
    return fallback;
  }
}

/**
 * @param {string} name - A lowercased meta name or property.
 * @returns {MetadataSource | null}
 */
function metaSource(name) {
  if (HTML_META_NAMES.has(name)) {
    return "html";
  }
  if (OPEN_GRAPH_PREFIXES.some(prefix => name.startsWith(prefix))) {
    return "opengraph";
  }
  if (name.startsWith("twitter:")) {
    return "twitter";
  }
  return null;
}

/**
 * Open Graph is specified with the RDFa `property` attribute and Twitter Cards
 * with `name`, but pages mix both up, so either attribute is read.
 *
 * @param {Document} document
 * @returns {MetaTagEntry[]}
 */
function extractMetaTags(document) {
  /** @type {MetaTagEntry[]} */
  const entries = [];
  for (const meta of document.querySelectorAll("meta[content]")) {
    const value = meta.getAttribute("content");
    if (!value.trim()) {
      continue;
    }
    const names = new Set(
      [meta.getAttribute("property"), meta.getAttribute("name")]
        .filter(Boolean)
        .map(name => name.toLowerCase())
    );
    for (const name of names) {
      const source = metaSource(name);
      if (source) {
        entries.push({ source, name, value });
      }
    }
    if (entries.length >= MAX_META_TAGS) {
      return entries.slice(0, MAX_META_TAGS);
    }
  }
  return entries;
}

/**
 * @param {Document} document
 * @returns {LinkEntry[]}
 */
function extractLinks(document) {
  /** @type {LinkEntry[]} */
  const links = [];
  for (const link of document.querySelectorAll("link[rel][href]")) {
    const rel = LINK_RELS.find(r => link.relList.contains(r));
    if (rel && link.href) {
      links.push({ rel, href: link.href });
    }
  }
  return links;
}

/**
 * The nodes collected from every syntax. They share one size limit and one
 * blank node numbering, so ids never collide across syntaxes.
 */
class NodeCollector {
  /** @type {StructuredDataNode[]} */
  nodes = [];

  #blankNodeCount = 0;

  newBlankNodeId() {
    return `_:b${this.#blankNodeCount++}`;
  }

  /**
   * @param {StructuredDataNode} node
   * @returns {boolean} false when the node was dropped by the size limit.
   */
  add(node) {
    if (this.nodes.length >= MAX_NODES) {
      return false;
    }
    this.nodes.push(node);
    return true;
  }
}

/**
 * @typedef {object} JsonLdScope
 * @property {Map<string, string>} aliases - Terms the active context maps to a
 *   keyword.
 * @property {string} base - The base URL `@id` values resolve against.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return !!value && typeof value == "object" && !Array.isArray(value);
}

/**
 * Applies a local `@context` to the active scope. Only what changes how keys
 * are read is kept: keyword aliases and `@base`. Other term definitions are
 * ignored, since expanding terms would require fetching remote contexts.
 *
 * @param {JsonLdScope} scope
 * @param {unknown} context
 * @param {string} documentBase
 * @returns {JsonLdScope}
 */
function applyContext(scope, context, documentBase) {
  let { aliases, base } = scope;
  for (const item of [context].flat()) {
    if (item === null) {
      aliases = new Map();
      base = documentBase;
    } else if (typeof item == "string") {
      if (SCHEMA_ORG_CONTEXT_URL.test(item)) {
        aliases = new Map([...aliases, ...SCHEMA_ORG_CONTEXT_ALIASES]);
      }
    } else if (isPlainObject(item)) {
      aliases = new Map(aliases);
      for (const [term, definition] of Object.entries(item)) {
        if (term == "@base") {
          if (typeof definition == "string") {
            base = URL.parse(definition, base)?.href ?? base;
          } else if (definition === null) {
            base = documentBase;
          }
          continue;
        }
        const target = isPlainObject(definition)
          ? definition["@id"]
          : definition;
        if (typeof target == "string" && JSON_LD_KEYWORDS.has(target)) {
          aliases.set(term, target);
        } else {
          aliases.delete(term);
        }
      }
    }
  }
  return { aliases, base };
}

/**
 * Splits an object's entries into keywords, resolving aliases, and properties.
 * The properties of `@nest` objects are lifted into the object.
 *
 * @param {Record<string, any>} object
 * @param {JsonLdScope} scope
 * @param {number} [depth]
 * @returns {{ keywords: Map<string, any>, properties: [string, any][] }}
 */
function readEntries(object, scope, depth = 0) {
  const keywords = new Map();
  /** @type {[string, any][]} */
  const properties = [];
  for (const [key, value] of Object.entries(object)) {
    const keyword = key.startsWith("@") ? key : scope.aliases.get(key);
    if (!keyword) {
      properties.push([key, value]);
    } else if (keyword == "@nest") {
      if (depth >= MAX_DEPTH) {
        continue;
      }
      for (const nested of [value].flat().filter(isPlainObject)) {
        for (const entry of readEntries(nested, scope, depth + 1).properties) {
          properties.push(entry);
        }
      }
    } else {
      keywords.set(keyword, value);
    }
  }
  return { keywords, properties };
}

/**
 * Flattens the JSON-LD blocks of a document into nodes, following the shape of
 * the JSON-LD 1.1 flattening algorithm: every node object becomes a node, and
 * where it was embedded a `{ "@id" }` reference is left instead. Unlike that
 * algorithm, nodes sharing an `@id` are not merged, so conflicting
 * declarations stay apart, and terms are kept as written rather than expanded
 * against `@context`. Callers can read the block's `@context` to interpret
 * them.
 *
 * @param {Document} document
 * @param {NodeCollector} collector
 * @returns {JsonLdBlock[]}
 */
function extractJsonLd(document, collector) {
  /** @type {JsonLdBlock[]} */
  const blocks = [];
  const documentBase = document.baseURI;
  let remainingLength = MAX_JSON_LD_TOTAL_LENGTH;
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json" i]'
  );

  for (const [blockIndex, script] of scripts.entries()) {
    const text = script.textContent ?? "";
    if (text.length > remainingLength) {
      blocks.push({ context: null, status: "too-large" });
      continue;
    }
    remainingLength -= text.length;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (!parsed || typeof parsed != "object") {
      blocks.push({ context: null, status: "invalid" });
      continue;
    }

    let truncated = false;
    /** @type {Map<string, string>} */
    const blankNodeLabels = new Map();

    /**
     * @param {unknown} id
     * @param {JsonLdScope} scope
     * @returns {string}
     */
    const nodeId = (id, scope) => {
      if (typeof id != "string") {
        return collector.newBlankNodeId();
      }
      // Blank node labels only identify a node within one JSON-LD document.
      if (id.startsWith("_:")) {
        let label = blankNodeLabels.get(id);
        if (!label) {
          label = collector.newBlankNodeId();
          blankNodeLabels.set(id, label);
        }
        return label;
      }
      return URL.parse(id, scope.base)?.href ?? id;
    };

    /**
     * @param {StructuredDataNode} node
     * @returns {boolean}
     */
    const addNode = node => {
      if (!collector.add(node)) {
        truncated = true;
        return false;
      }
      return true;
    };

    /**
     * Adds the node, the nodes embedded in it, and the members of its graph.
     *
     * @param {Record<string, any>} object
     * @param {JsonLdScope} scope
     * @param {boolean} isTopLevel
     * @param {number} depth
     * @returns {StructuredDataValue | null} A reference to the node.
     */
    const visitNode = (object, scope, isTopLevel, depth) => {
      if (depth > MAX_DEPTH) {
        truncated = true;
        return null;
      }
      if ("@context" in object) {
        scope = applyContext(scope, object["@context"], documentBase);
      }
      const { keywords, properties } = readEntries(object, scope);
      const types = [keywords.get("@type")]
        .flat()
        .filter(t => typeof t == "string");
      const reverse = keywords.get("@reverse");

      /** @type {StructuredDataValue | null} */
      let reference = keywords.has("@id")
        ? { "@id": nodeId(keywords.get("@id"), scope) }
        : null;

      if (types.length || properties.length || isPlainObject(reverse)) {
        /** @type {StructuredDataNode} */
        const node = {
          id: reference?.["@id"] ?? collector.newBlankNodeId(),
          types,
          properties: Object.create(null),
          isTopLevel,
          syntax: "json-ld",
          blockIndex,
        };
        if (!addNode(node)) {
          return null;
        }
        reference = { "@id": node.id };
        for (const [key, value] of properties) {
          const values = toValues(value, scope, depth + 1);
          if (values.length) {
            node.properties[key] = (node.properties[key] ?? []).concat(values);
          }
        }
        if (isPlainObject(reverse)) {
          addReverseNodes(node.id, reverse, scope, depth + 1);
        }
      }

      for (const keyword of ["@graph", "@included"]) {
        for (const member of [keywords.get(keyword) ?? []].flat()) {
          if (isPlainObject(member)) {
            visitNode(member, scope, isTopLevel, depth + 1);
          }
        }
      }
      return reference;
    };

    /**
     * A reverse property states a property of other nodes that points back at
     * this one. Since nodes are not merged, each statement becomes a node of
     * its own that holds only that property.
     *
     * @param {string} id
     * @param {Record<string, any>} reverse
     * @param {JsonLdScope} scope
     * @param {number} depth
     */
    const addReverseNodes = (id, reverse, scope, depth) => {
      for (const [key, value] of readEntries(reverse, scope).properties) {
        for (const subject of toValues(value, scope, depth + 1)) {
          if (isPlainObject(subject) && "@id" in subject) {
            addNode({
              id: subject["@id"],
              types: [],
              properties: Object.assign(Object.create(null), {
                [key]: [{ "@id": id }],
              }),
              isTopLevel: false,
              syntax: "json-ld",
              blockIndex,
            });
          }
        }
      }
    };

    /**
     * @param {unknown} value
     * @param {JsonLdScope} scope
     * @param {number} depth
     * @returns {StructuredDataValue[]}
     */
    const toValues = (value, scope, depth) => {
      if (value === null || value === undefined) {
        return [];
      }
      if (typeof value != "object") {
        return [/** @type {string | number | boolean} */ (value)];
      }
      if (depth > MAX_DEPTH) {
        truncated = true;
        return [];
      }
      if (Array.isArray(value)) {
        return value.flatMap(item => toValues(item, scope, depth + 1));
      }
      const valueScope =
        "@context" in value
          ? applyContext(scope, value["@context"], documentBase)
          : scope;
      const { keywords } = readEntries(value, valueScope);
      if (keywords.has("@value")) {
        const literal = keywords.get("@value");
        if (literal === null || typeof literal == "object") {
          return [];
        }
        /** @type {StructuredDataValue} */
        const valueObject = { "@value": literal };
        for (const key of ["@type", "@language", "@direction"]) {
          if (typeof keywords.get(key) == "string") {
            valueObject[key] = keywords.get(key);
          }
        }
        return [valueObject];
      }
      if (keywords.has("@list")) {
        return [
          { "@list": toListValues(keywords.get("@list"), scope, depth + 1) },
        ];
      }
      if (keywords.has("@set")) {
        return toValues(keywords.get("@set"), scope, depth + 1);
      }
      const reference = visitNode(value, scope, false, depth);
      return reference ? [reference] : [];
    };

    /**
     * Unlike other arrays, an array inside a list is a list of its own.
     *
     * @param {unknown} value
     * @param {JsonLdScope} scope
     * @param {number} depth
     * @returns {StructuredDataValue[]}
     */
    const toListValues = (value, scope, depth) => {
      if (depth > MAX_DEPTH) {
        truncated = true;
        return [];
      }
      return [value]
        .flat()
        .flatMap(item =>
          Array.isArray(item)
            ? [{ "@list": toListValues(item, scope, depth + 1) }]
            : toValues(item, scope, depth + 1)
        );
    };

    /** @type {JsonLdScope} */
    const rootScope = { aliases: new Map(), base: documentBase };
    let context = null;
    try {
      for (const item of [parsed].flat()) {
        if (isPlainObject(item)) {
          context ??= item["@context"] ?? null;
          visitNode(item, rootScope, true, 0);
        }
      }
    } catch (error) {
      console.error("Failed to read a JSON-LD block", error);
      truncated = true;
    }
    blocks.push({ context, status: truncated ? "truncated" : "parsed" });
  }

  return blocks;
}

/**
 * Collects HTML microdata items into nodes, following the WHATWG microdata
 * model: https://html.spec.whatwg.org/multipage/microdata.html
 *
 * @param {Document} document
 * @param {NodeCollector} collector
 */
function extractMicrodata(document, collector) {
  /**
   * Through `itemref`, one item can be the value of several properties. It is
   * collected once.
   *
   * @type {Map<Element, string>}
   */
  const itemIds = new Map();
  const budget = {
    elements: MAX_MICRODATA_ELEMENTS,
    characters: MAX_MICRODATA_CHARACTERS,
  };

  /**
   * @param {Element} element
   * @param {boolean} isTopLevel
   * @param {Set<Element>} ancestors - The items being collected, to stop
   *   cycles.
   * @returns {string | null} The id of the item's node.
   */
  const visitItem = (element, isTopLevel, ancestors) => {
    const knownId = itemIds.get(element);
    if (knownId) {
      return knownId;
    }
    if (
      ancestors.has(element) ||
      ancestors.size > MAX_DEPTH ||
      budget.elements <= 0 ||
      budget.characters <= 0
    ) {
      return null;
    }
    const itemid = element.getAttribute("itemid");
    /** @type {StructuredDataNode} */
    const node = {
      id:
        (itemid && URL.parse(itemid, element.baseURI)?.href) ||
        collector.newBlankNodeId(),
      types: tokens(element.getAttribute("itemtype")),
      properties: Object.create(null),
      isTopLevel,
      syntax: "microdata",
      blockIndex: null,
    };
    if (!collector.add(node)) {
      return null;
    }
    itemIds.set(element, node.id);

    const nextAncestors = new Set(ancestors).add(element);
    for (const property of crawlProperties(element, budget)) {
      if (budget.characters <= 0) {
        break;
      }
      /** @type {StructuredDataValue} */
      let value;
      if (property.hasAttribute("itemscope")) {
        const id = visitItem(property, false, nextAncestors);
        if (!id) {
          continue;
        }
        value = { "@id": id };
      } else {
        const maxLength = Math.min(
          MAX_MICRODATA_VALUE_LENGTH,
          budget.characters
        );
        value = microdataPropertyValue(property, maxLength).slice(0, maxLength);
        budget.characters -= value.length;
      }
      for (const name of tokens(property.getAttribute("itemprop"))) {
        (node.properties[name] ??= []).push(value);
      }
    }
    return node.id;
  };

  for (const element of document.querySelectorAll(
    "[itemscope]:not([itemprop])"
  )) {
    visitItem(element, true, new Set());
  }
}

/**
 * @param {string | null} attribute
 * @returns {string[]} The unique space-separated tokens, in order.
 */
function tokens(attribute) {
  return [...new Set(attribute?.split(/[\t\n\f\r ]+/).filter(Boolean))];
}

/**
 * The elements holding an item's properties, in tree order. See
 * https://html.spec.whatwg.org/multipage/microdata.html#associating-names-with-items
 *
 * @param {Element} root
 * @param {{ elements: number }} budget - The elements left to visit across all
 *   items. Visiting stops when it runs out.
 * @returns {Element[]}
 */
function crawlProperties(root, budget) {
  const results = [];
  const memory = new Set([root]);
  const pending = [...root.children];
  const rootNode = /** @type {Document | ShadowRoot} */ (root.getRootNode());
  for (const id of tokens(root.getAttribute("itemref"))) {
    const referenced = rootNode.getElementById?.(id);
    if (referenced) {
      pending.push(referenced);
    }
  }
  while (pending.length && budget.elements > 0) {
    const current = pending.pop();
    if (memory.has(current)) {
      continue;
    }
    memory.add(current);
    budget.elements--;
    if (!current.hasAttribute("itemscope")) {
      for (const child of current.children) {
        pending.push(child);
      }
    }
    if (tokens(current.getAttribute("itemprop")).length) {
      results.push(current);
    }
  }
  return results.sort((a, b) =>
    a.compareDocumentPosition(b) & a.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
}

/**
 * See https://html.spec.whatwg.org/multipage/microdata.html#values
 *
 * @param {Element} element
 * @param {number} maxLength
 * @returns {string}
 */
function microdataPropertyValue(element, maxLength) {
  /** @param {string} attribute */
  const url = attribute => {
    const value = element.getAttribute(attribute);
    return value === null
      ? ""
      : (URL.parse(value, element.baseURI)?.href ?? "");
  };
  switch (element.localName) {
    case "meta":
      return element.getAttribute("content") ?? "";
    case "audio":
    case "embed":
    case "iframe":
    case "img":
    case "source":
    case "track":
    case "video":
      return url("src");
    case "a":
    case "area":
    case "link":
      return url("href");
    case "object":
      return url("data");
    case "data":
    case "meter":
      return element.getAttribute("value") ?? "";
    case "time":
      if (element.hasAttribute("datetime")) {
        return element.getAttribute("datetime");
      }
  }
  return boundedTextContent(element, maxLength);
}

/**
 * The element's textContent, read only as far as needed, since nested
 * properties would otherwise each read their whole subtree.
 *
 * @param {Element} element
 * @param {number} maxLength
 * @returns {string}
 */
function boundedTextContent(element, maxLength) {
  const walker = element.ownerDocument.createTreeWalker(
    element,
    4 // NodeFilter.SHOW_TEXT
  );
  let text = "";
  while (text.length < maxLength && walker.nextNode()) {
    text += walker.currentNode.nodeValue;
  }
  return text.slice(0, maxLength);
}
