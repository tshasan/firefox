/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const MAX_TITLE_LENGTH = 100;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Truncate a string to maxLen characters, appending a Unicode ellipsis
 * when the string is actually shortened.
 * Returns "" for null/undefined input.
 *
 * @param {string} str
 * @param {number} [maxLen=MAX_TITLE_LENGTH]
 * @returns {string}
 */
export function truncateTitle(str, maxLen = MAX_TITLE_LENGTH) {
  if (!str) {
    return "";
  }
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen) + "\u2026";
}

/**
 * Check if a URL uses an allowed protocol (http/https by default).
 * Returns false for malformed URLs or disallowed protocols.
 *
 * @param {string} url
 * @param {Set<string>} [protocols=ALLOWED_PROTOCOLS]
 * @returns {boolean}
 */
export function isAllowedUrl(url, protocols = ALLOWED_PROTOCOLS) {
  try {
    return protocols.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
