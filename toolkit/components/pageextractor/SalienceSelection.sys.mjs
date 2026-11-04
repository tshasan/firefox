/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * To cut text down to the sufficient length, the extractor keeps regions in
 * this order, and each region in reading order.
 */
export const Priority = {
  // The page's own content, from the main and article landmarks or dialogs.
  CONTENT: 0,
  // Text outside of any landmark, and sidebars. Sidebars often describe the
  // page, like a repository's details or a product's specifications.
  UNMARKED: 1,
  // Navigation, banners, footers and fixed or sticky overlays.
  BOILERPLATE: 2,
};

const MAX_TABLE_HEADER_ROWS = 8;

/** A selected group stops taking body text past this many characters. */
const MAX_GROUP_BODY_LENGTH = 160;

/**
 * Short "label: value" lines right after a group, like a product's
 * specifications, read as part of it.
 */
const MAX_TRAILING_FIELDS = 3;
const MAX_FIELD_LENGTH = 160;
const FIELD_LABEL_REGEX = /^[^:]{1,40}:/;

/**
 * The run fields that selection reads.
 *
 * @typedef {object} SelectableRun
 * @property {Element} block - The block the run's text lays out in.
 * @property {Element | null} section - The heading or container that starts
 *   the run's section.
 * @property {Element | null} table - The table the run is a row of.
 * @property {boolean} isTableHeader - Whether the run is a row of column
 *   headers.
 * @property {Element[]} contextBlocks - The blocks of the section's
 *   aria-labelledby targets.
 * @property {boolean} preserveWhitespace - Whether the run keeps its
 *   whitespace, like a code block.
 * @property {boolean} isMostlyClippedOut - Whether the user has to bring most
 *   of the run into view.
 * @property {number} regionPriority - A Priority value.
 */

/**
 * Picks the runs to keep under a character target. It rotates across the
 * sections of each priority, visible text before clipped text, and keeps each
 * picked run's headings, table headers and labels with it.
 *
 * @param {SelectableRun[]} runs
 * @param {string[]} lines - The formatted text of each run.
 * @param {Array<number | null>} headingLevels - The heading level of each run.
 * @param {number} sufficientLength
 * @returns {boolean[]} Whether to keep each run.
 */
export function selectSalienceRuns(
  runs,
  lines,
  headingLevels,
  sufficientLength
) {
  const keep = runs.map(() => false);
  /** @type {Array<number | null>} The open heading run at each level. */
  const headings = Array(6).fill(null);
  /** @type {number[][]} */
  const dependencies = runs.map(() => []);
  /** @type {Map<Element, number[]>} */
  const tableHeaders = new Map();
  /** @type {Map<Element, number>} */
  const blockIndices = new Map();
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    blockIndices.set(run.block, i);
    const level = headingLevels[i];
    if (level && run.regionPriority < Priority.BOILERPLATE) {
      headings.fill(null, level - 1);
      headings[level - 1] = i;
    }
    dependencies[i].push(...headings.filter(index => index !== null));
    if (run.table) {
      if (run.isTableHeader) {
        let headers = tableHeaders.get(run.table);
        if (!headers) {
          headers = [];
          tableHeaders.set(run.table, headers);
        }
        if (headers.length < MAX_TABLE_HEADER_ROWS) {
          headers.push(i);
        }
      } else {
        dependencies[i].push(...(tableHeaders.get(run.table) ?? []));
      }
    }
  }

  /** @type {Map<Element | null, number[]>} */
  const groups = new Map();
  for (let i = 0; i < runs.length; i++) {
    if (!lines[i]) {
      continue;
    }
    const run = runs[i];
    for (const block of run.contextBlocks) {
      const index = blockIndices.get(block);
      if (index !== undefined) {
        dependencies[i].push(index);
      }
    }
    if (
      run.preserveWhitespace &&
      i &&
      !headingLevels[i - 1] &&
      runs[i - 1].section === run.section &&
      !runs[i - 1].preserveWhitespace
    ) {
      dependencies[i].push(i - 1);
    }
    let group = groups.get(run.section);
    if (!group) {
      group = [];
      groups.set(run.section, group);
    }
    group.push(i);
  }

  let length = 0;
  for (
    let priority = Priority.CONTENT;
    priority <= Priority.BOILERPLATE;
    priority++
  ) {
    for (const clipped of [false, true]) {
      let sections = [...groups.values()]
        .map(group => ({
          indices: group.filter(
            i =>
              runs[i].regionPriority === priority &&
              runs[i].isMostlyClippedOut === clipped
          ),
          cursor: 0,
        }))
        .filter(group => group.indices.length);
      while (sections.length && length < sufficientLength) {
        const remaining = [];
        for (const group of sections) {
          if (length >= sufficientLength) {
            break;
          }
          while (
            group.cursor < group.indices.length &&
            keep[group.indices[group.cursor]]
          ) {
            group.cursor++;
          }
          if (group.cursor === group.indices.length) {
            continue;
          }
          /** @type {Set<number>} */
          const unit = new Set();
          let bodyLength = 0;
          while (group.cursor < group.indices.length) {
            const index = group.indices[group.cursor];
            if (bodyLength && headingLevels[index]) {
              break;
            }
            group.cursor++;
            for (const dependency of dependencies[index]) {
              unit.add(dependency);
            }
            unit.add(index);
            if (!headingLevels[index] && !runs[index].isTableHeader) {
              bodyLength += lines[index].length;
            }
            if (
              bodyLength >=
              Math.min(MAX_GROUP_BODY_LENGTH, sufficientLength / 4)
            ) {
              break;
            }
          }
          for (
            let fields = 0;
            fields < MAX_TRAILING_FIELDS && group.cursor < group.indices.length;
            fields++
          ) {
            const index = group.indices[group.cursor];
            if (
              headingLevels[index] ||
              lines[index].length > MAX_FIELD_LENGTH ||
              !FIELD_LABEL_REGEX.test(lines[index])
            ) {
              break;
            }
            group.cursor++;
            unit.add(index);
          }
          const cost = [...unit].reduce(
            (sum, i) => sum + (keep[i] ? 0 : lines[i].length + 1),
            0
          );
          if (group.cursor < group.indices.length) {
            remaining.push(group);
          }
          if (length && cost > sufficientLength * 2) {
            continue;
          }
          for (const i of unit) {
            keep[i] = true;
          }
          length += cost;
        }
        sections = remaining;
      }
    }
  }
  return keep;
}
