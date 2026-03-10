/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { truncateTitle, isAllowedUrl } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ToolSanitizers.sys.mjs"
);

add_task(function test_truncateTitle_empty_inputs() {
  Assert.equal(truncateTitle(null), "", "null returns empty string");
  Assert.equal(truncateTitle(undefined), "", "undefined returns empty string");
  Assert.equal(truncateTitle(""), "", "empty string returns empty string");
});

add_task(function test_truncateTitle_short_strings() {
  Assert.equal(truncateTitle("Hello"), "Hello", "short string unchanged");
  Assert.equal(
    truncateTitle("A".repeat(99)),
    "A".repeat(99),
    "99 chars unchanged"
  );
  Assert.equal(
    truncateTitle("A".repeat(100)),
    "A".repeat(100),
    "100 chars unchanged"
  );
});

add_task(function test_truncateTitle_long_strings() {
  const result = truncateTitle("A".repeat(150));
  Assert.equal(result.length, 101, "truncated to 100 chars + ellipsis");
  Assert.equal(
    result,
    "A".repeat(100) + "\u2026",
    "100 content chars + ellipsis"
  );
});

add_task(function test_truncateTitle_boundary() {
  Assert.equal(
    truncateTitle("A".repeat(101)),
    "A".repeat(100) + "\u2026",
    "101 chars truncated to 100 + ellipsis"
  );
  Assert.equal(
    truncateTitle("A".repeat(100)),
    "A".repeat(100),
    "100 chars unchanged (no ellipsis)"
  );
});

add_task(function test_truncateTitle_custom_maxLen() {
  Assert.equal(
    truncateTitle("Hello World", 5),
    "Hello\u2026",
    "custom maxLen truncation with ellipsis"
  );
  Assert.equal(
    truncateTitle("Hi", 5),
    "Hi",
    "short string with custom maxLen unchanged"
  );
});

add_task(function test_isAllowedUrl_allowed() {
  Assert.ok(isAllowedUrl("http://example.com"), "http allowed");
  Assert.ok(isAllowedUrl("https://example.com"), "https allowed");
  Assert.ok(
    isAllowedUrl("https://example.com/path?q=1#anchor"),
    "https with path allowed"
  );
});

add_task(function test_isAllowedUrl_blocked() {
  Assert.ok(!isAllowedUrl("about:config"), "about: blocked");
  Assert.ok(
    !isAllowedUrl("chrome://browser/content/browser.xhtml"),
    "chrome: blocked"
  );
  Assert.ok(
    !isAllowedUrl("moz-extension://abc/page.html"),
    "moz-extension: blocked"
  );
  Assert.ok(!isAllowedUrl("file:///home/user/doc.html"), "file: blocked");
  Assert.ok(!isAllowedUrl("data:text/html,hello"), "data: blocked");
  Assert.ok(!isAllowedUrl("blob:https://example.com/abc"), "blob: blocked");
  Assert.ok(
    !isAllowedUrl("view-source:https://example.com"),
    "view-source: blocked"
  );
  Assert.ok(!isAllowedUrl("javascript:alert(1)"), "javascript: blocked");
});

add_task(function test_isAllowedUrl_malformed() {
  Assert.ok(!isAllowedUrl(""), "empty string returns false");
  Assert.ok(!isAllowedUrl("not a url"), "invalid URL returns false");
  Assert.ok(!isAllowedUrl(null), "null returns false");
  Assert.ok(!isAllowedUrl(undefined), "undefined returns false");
});

add_task(function test_isAllowedUrl_case_insensitive() {
  Assert.ok(isAllowedUrl("HTTP://EXAMPLE.COM"), "uppercase HTTP allowed");
  Assert.ok(isAllowedUrl("HTTPS://EXAMPLE.COM"), "uppercase HTTPS allowed");
  Assert.ok(isAllowedUrl("HtTpS://example.com"), "mixed case allowed");
});

add_task(function test_isAllowedUrl_custom_protocols() {
  const ftpOnly = new Set(["ftp:"]);
  Assert.ok(
    isAllowedUrl("ftp://example.com", ftpOnly),
    "ftp allowed with custom set"
  );
  Assert.ok(
    !isAllowedUrl("https://example.com", ftpOnly),
    "https blocked with ftp-only set"
  );
});
