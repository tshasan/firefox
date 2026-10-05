/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { JsonLdBlock, JsonLdNode, JsonLdValue, LinkEntry, MetaTagEntry, MetadataSource, StructuredMetadata } from './PageExtractor.d.ts'
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

const MAX_META_TAGS = 500;
const MAX_JSON_LD_TOTAL_LENGTH = 2_000_000;
const MAX_JSON_LD_NODES = 1000;
const MAX_JSON_LD_DEPTH = 32;

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
  return {
    metaTags: extractMetaTags(document),
    links: extractLinks(document),
    jsonLd: extractJsonLd(document),
  };
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
 * Flattens the JSON-LD blocks of a document into a list of nodes, following
 * the shape of the JSON-LD 1.1 flattening algorithm: every node object becomes
 * a node, and where it was embedded a `{ "@id" }` reference is left instead.
 * Unlike that algorithm, nodes sharing an `@id` are not merged, so conflicting
 * declarations stay apart, and terms are not expanded against `@context`, as
 * that would require fetching remote contexts. Callers can read the block's
 * `@context` to interpret them.
 *
 * @param {Document} document
 * @returns {{ nodes: JsonLdNode[], blocks: JsonLdBlock[] }}
 */
function extractJsonLd(document) {
  /** @type {JsonLdNode[]} */
  const nodes = [];
  /** @type {JsonLdBlock[]} */
  const blocks = [];
  let blankNodeCount = 0;
  let remainingLength = MAX_JSON_LD_TOTAL_LENGTH;
  const baseURI = document.baseURI;
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json" i]'
  );

  for (const [scriptIndex, script] of scripts.entries()) {
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
     * @returns {string}
     */
    const nodeId = id => {
      if (typeof id != "string") {
        return `_:b${blankNodeCount++}`;
      }
      // Blank node labels only identify a node within one JSON-LD document.
      if (id.startsWith("_:")) {
        let label = blankNodeLabels.get(id);
        if (!label) {
          label = `_:b${blankNodeCount++}`;
          blankNodeLabels.set(id, label);
        }
        return label;
      }
      return URL.parse(id, baseURI)?.href ?? id;
    };

    /**
     * Adds the node and the nodes embedded in it.
     *
     * @param {Record<string, any>} object
     * @param {boolean} isTopLevel
     * @param {number} depth
     * @returns {JsonLdValue | null} A reference to the node.
     */
    const addNode = (object, isTopLevel, depth) => {
      const keys = Object.keys(object).filter(key => key != "@context");
      if (keys.length == 1 && keys[0] == "@id") {
        return { "@id": nodeId(object["@id"]) };
      }
      if (nodes.length >= MAX_JSON_LD_NODES) {
        truncated = true;
        return null;
      }
      /** @type {JsonLdNode} */
      const node = {
        id: nodeId(object["@id"]),
        types: [object["@type"]].flat().filter(t => typeof t == "string"),
        properties: Object.create(null),
        isTopLevel,
        scriptIndex,
      };
      nodes.push(node);
      for (const key of keys) {
        if (key.startsWith("@")) {
          continue;
        }
        const values = toValues(object[key], depth + 1);
        if (values.length) {
          node.properties[key] = values;
        }
      }
      return { "@id": node.id };
    };

    /**
     * @param {unknown} value
     * @param {number} depth
     * @returns {JsonLdValue[]}
     */
    const toValues = (value, depth) => {
      if (value === null || value === undefined) {
        return [];
      }
      if (typeof value != "object") {
        return [/** @type {string | number | boolean} */ (value)];
      }
      if (depth > MAX_JSON_LD_DEPTH) {
        truncated = true;
        return [];
      }
      if (Array.isArray(value)) {
        return value.flatMap(item => toValues(item, depth + 1));
      }
      const object = /** @type {Record<string, any>} */ (value);
      if ("@value" in object) {
        const literal = object["@value"];
        if (literal === null || typeof literal == "object") {
          return [];
        }
        /** @type {JsonLdValue} */
        const valueObject = { "@value": literal };
        for (const key of ["@type", "@language", "@direction"]) {
          if (typeof object[key] == "string") {
            valueObject[key] = object[key];
          }
        }
        return [valueObject];
      }
      if ("@list" in object) {
        return [{ "@list": toListValues(object["@list"], depth + 1) }];
      }
      if ("@set" in object) {
        return toValues(object["@set"], depth + 1);
      }
      const reference = addNode(object, false, depth);
      return reference ? [reference] : [];
    };

    /**
     * Unlike other arrays, an array inside a list is a list of its own.
     *
     * @param {unknown} value
     * @param {number} depth
     * @returns {JsonLdValue[]}
     */
    const toListValues = (value, depth) => {
      if (depth > MAX_JSON_LD_DEPTH) {
        truncated = true;
        return [];
      }
      return [value]
        .flat()
        .flatMap(item =>
          Array.isArray(item)
            ? [{ "@list": toListValues(item, depth + 1) }]
            : toValues(item, depth + 1)
        );
    };

    let context = null;
    for (const item of [parsed].flat()) {
      if (!item || typeof item != "object" || Array.isArray(item)) {
        continue;
      }
      context ??= item["@context"] ?? null;
      const { "@graph": graph, ...rest } = item;
      if (graph === undefined || Object.keys(rest).some(k => k != "@context")) {
        addNode(graph === undefined ? item : rest, true, 0);
      }
      for (const member of [graph ?? []].flat()) {
        if (member && typeof member == "object" && !Array.isArray(member)) {
          addNode(member, true, 1);
        }
      }
    }
    blocks.push({ context, status: truncated ? "truncated" : "parsed" });
  }

  return { nodes, blocks };
}
