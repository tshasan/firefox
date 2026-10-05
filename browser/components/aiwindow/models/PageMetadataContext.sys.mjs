/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { StructuredDataNode, StructuredDataValue, StructuredMetadata } from "moz-src:///toolkit/components/pageextractor/PageExtractor.d.ts"
 */

import {
  getSchemaOrgAncestors,
  getSchemaOrgTypeName,
} from "moz-src:///toolkit/components/pageextractor/SchemaOrgVocabulary.sys.mjs";

export const PAGE_METADATA_PREF = "browser.smartwindow.pageMetadata.enabled";

const SOURCE_LABELS = {
  html: "HTML",
  opengraph: "Open Graph",
  twitter: "Twitter Card",
};

const MAX_NODES = 10;
const MAX_PROPERTIES = 20;
const MAX_META_TAGS = 20;
const MAX_VALUE_LENGTH = 300;
const MAX_LENGTH = 4000;

/**
 * @param {string} text
 * @returns {string}
 */
function clean(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_VALUE_LENGTH
    ? collapsed.slice(0, MAX_VALUE_LENGTH) + "…"
    : collapsed;
}

/**
 * @param {string} type
 * @returns {string} e.g. "NewsArticle (a kind of Article, CreativeWork)".
 */
function describeType(type) {
  const name = getSchemaOrgTypeName(type);
  if (!name) {
    return clean(type);
  }
  const ancestors = getSchemaOrgAncestors(name).filter(a => a != "Thing");
  return ancestors.length
    ? `${name} (a kind of ${ancestors.join(", ")})`
    : name;
}

/**
 * @param {StructuredDataValue} value
 * @param {Map<string, StructuredDataNode>} nodesById
 * @param {boolean} followReferences
 * @returns {string}
 */
function describeValue(value, nodesById, followReferences = true) {
  if (typeof value != "object") {
    return String(value);
  }
  if ("@value" in value) {
    return String(value["@value"]);
  }
  if ("@list" in value) {
    return value["@list"]
      .map(item => describeValue(item, nodesById, followReferences))
      .join(", ");
  }
  const node = nodesById.get(value["@id"]);
  if (!node || !followReferences) {
    return value["@id"];
  }
  // A referenced node is named rather than expanded, to keep the context short.
  const types = node.types.map(t => getSchemaOrgTypeName(t) ?? t).join("/");
  const name = node.properties.name?.[0];
  if (name === undefined) {
    return types || value["@id"];
  }
  const label = `"${describeValue(name, nodesById, false)}"`;
  return types ? `${types} ${label}` : label;
}

/**
 * Describes what a page declares about itself in a form a language model can
 * read: its top-level schema.org items with their properties, and its SEO and
 * social tags, each labelled with its source. Conflicting values are all
 * listed, so the model can weigh them against the page content.
 *
 * @param {StructuredMetadata} structuredMetadata
 * @returns {string} An empty string when the page declares nothing.
 */
export function formatPageMetadataForModel({ metaTags, structuredData }) {
  /** @type {Map<string, StructuredDataNode>} */
  const nodesById = new Map();
  for (const node of structuredData.nodes) {
    if (!nodesById.has(node.id)) {
      nodesById.set(node.id, node);
    }
  }

  const lines = [];
  const topLevel = structuredData.nodes.filter(node => node.isTopLevel);
  for (const node of topLevel.slice(0, MAX_NODES)) {
    lines.push(`- ${node.types.map(describeType).join(", ") || "Item"}`);
    for (const [property, values] of Object.entries(node.properties).slice(
      0,
      MAX_PROPERTIES
    )) {
      const described = values.map(v => describeValue(v, nodesById));
      lines.push(`  ${clean(property)}: ${clean(described.join("; "))}`);
    }
  }
  for (const { source, name, value } of metaTags.slice(0, MAX_META_TAGS)) {
    lines.push(`- ${clean(name)} (${SOURCE_LABELS[source]}): ${clean(value)}`);
  }
  if (!lines.length) {
    return "";
  }
  return (
    "Metadata the page declares about itself, which may be incomplete or " +
    `wrong:\n${lines.join("\n")}`
  ).slice(0, MAX_LENGTH);
}
