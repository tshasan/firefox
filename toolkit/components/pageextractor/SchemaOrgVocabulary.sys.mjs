/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

import { SCHEMA_ORG_TYPE_PARENTS } from "moz-src:///toolkit/components/pageextractor/SchemaOrgTypes.sys.mjs";

export { SCHEMA_ORG_VERSION } from "moz-src:///toolkit/components/pageextractor/SchemaOrgTypes.sys.mjs";

/**
 * JSON-LD writes types as terms ("Recipe"), compact IRIs ("schema:Recipe") or
 * IRIs, and microdata writes them as IRIs.
 */
const SCHEMA_ORG_TYPE_PREFIX = /^(?:https?:\/\/schema\.org\/|schema:)/i;

/**
 * @param {string} type - A type as written by the page.
 * @returns {string | null} The schema.org type name, e.g. "Recipe", or null
 *   when the type is not part of schema.org.
 */
export function getSchemaOrgTypeName(type) {
  const name = type.replace(SCHEMA_ORG_TYPE_PREFIX, "");
  return Object.hasOwn(SCHEMA_ORG_TYPE_PARENTS, name) ? name : null;
}

/**
 * @param {string} type - A type as written by the page.
 * @returns {readonly string[]} The schema.org types it inherits from, nearest first,
 *   e.g. ["Article", "CreativeWork", "Thing"] for "NewsArticle".
 */
export function getSchemaOrgAncestors(type) {
  const name = getSchemaOrgTypeName(type);
  if (!name) {
    return [];
  }
  let cached = ancestorsByType.get(name);
  if (!cached) {
    cached = Object.freeze(collectAncestors(name));
    ancestorsByType.set(name, cached);
  }
  return cached;
}

/**
 * The vocabulary never changes, and consumers ask about the same few types
 * for every node on every page.
 *
 * @type {Map<string, readonly string[]>}
 */
const ancestorsByType = new Map();

/**
 * @param {string} name - A schema.org type name.
 * @returns {string[]}
 */
function collectAncestors(name) {
  const ancestors = new Set();
  const pending = [...SCHEMA_ORG_TYPE_PARENTS[name]];
  while (pending.length) {
    const parent = pending.shift();
    if (!ancestors.has(parent)) {
      ancestors.add(parent);
      pending.push(...(SCHEMA_ORG_TYPE_PARENTS[parent] ?? []));
    }
  }
  return [...ancestors];
}

/**
 * @param {string} type - A type as written by the page.
 * @param {string} ancestor - A schema.org type name, e.g. "CreativeWork".
 * @returns {boolean} Whether the type is the ancestor or inherits from it.
 */
export function isSchemaOrgType(type, ancestor) {
  const name = getSchemaOrgTypeName(type);
  return (
    !!name &&
    (name == ancestor || getSchemaOrgAncestors(name).includes(ancestor))
  );
}
