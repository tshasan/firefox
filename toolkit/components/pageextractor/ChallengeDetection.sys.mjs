/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * Detects known bot-detection interstitials ("captcha walls") so a headless
 * extraction can hand off to a real, foreground tab for the user to solve
 * the challenge, rather than reading the challenge page's own text.
 *
 * Each entry's title/selectors are captured from real challenge markup and
 * are prototype-quality: vendors' challenge pages aren't a stable,
 * documented API, so these heuristics need upkeep if they drift. Add a
 * vendor by appending a verified entry to PROVIDERS below — don't add
 * entries for markup you haven't confirmed against a live challenge page.
 */

const PROVIDERS = [
  {
    provider: "cloudflare",
    titleRegex: /^(just a moment|attention required)/i,
    // Deliberately narrow to markers of an *active* interstitial. Broader
    // signals like a `.cf-turnstile` widget or a
    // `challenges.cloudflare.com` script tag are false positives: CloudFlare's
    // Bot Management embeds those on ordinary pages too (an invisible
    // Turnstile check that runs even once the visitor is already trusted), so
    // they're still present long after any challenge has cleared.
    selectors: [
      "#cf-wrapper",
      "#challenge-running",
      "#challenge-stage",
      "#challenge-error-title",
    ],
  },
  // Add a vendor by appending a verified entry here once its challenge-page
  // markup has been captured — e.g.
  // { provider: "perimeterx", titleRegex: /.../, selectors: [...] }.
];

function matchesProvider({ titleRegex, selectors }, document) {
  if (titleRegex.test(document.title.trim())) {
    return true;
  }
  return selectors.some(selector => document.querySelector(selector));
}

/**
 * @param {Document | undefined} document
 * @returns {string | null} the matching provider's id, or null if no known
 *   challenge is present
 */
export function detectChallengeProvider(document) {
  if (!document) {
    return null;
  }
  return (
    PROVIDERS.find(entry => matchesProvider(entry, document))?.provider ?? null
  );
}
