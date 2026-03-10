/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const { searchBrowsingHistory } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

/**
 * searchBrowsingHistory tests
 *
 * Wrapper test: ensures Tools.searchBrowsingHistory() returns a valid JSON
 * structure for time-range browsing history search (empty searchTerm).
 */

add_task(async function test_searchBrowsingHistory_wrapper() {
  const outputStr = await searchBrowsingHistory({
    searchTerm: "",
    startTs: null,
    endTs: null,
  });

  const output = JSON.parse(outputStr);

  Assert.equal(output.searchTerm, "", "searchTerm match");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");

  // No error expected for empty searchTerm path.
  Assert.ok(!("error" in output), "no error field present");

  // Some basic structure sanity checks.
  Assert.ok("count" in output, "count field present");
  Assert.equal(output.count, output.results.length, "count matches results");
});

add_task(async function test_searchBrowsingHistory_ignores_llm_history_limit() {
  // Bug 2020811: LLM must not be able to control the history limit.
  // historyLimit in params should be silently ignored.
  const outputStr = await searchBrowsingHistory({
    searchTerm: "",
    startTs: null,
    endTs: null,
    historyLimit: 9999,
  });

  const output = JSON.parse(outputStr);

  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.lessOrEqual(
    output.results.length,
    15,
    "result count never exceeds hardcoded limit of 15"
  );
});

add_task(async function test_searchBrowsingHistory_no_favicon_or_thumbnail() {
  const outputStr = await searchBrowsingHistory({
    searchTerm: "",
    startTs: null,
    endTs: null,
  });

  const output = JSON.parse(outputStr);

  Assert.ok(Array.isArray(output.results), "results is an array");
  for (const [idx, item] of output.results.entries()) {
    Assert.ok(!("favicon" in item), `favicon absent for result[${idx}]`);
    Assert.ok(!("thumbnail" in item), `thumbnail absent for result[${idx}]`);
  }
});

/**
 * searchBrowsingHistory wrapper robustness tests
 *
 * Ensures wrapper tolerates missing or invalid tool arguments.
 */

// test: tool called with no arguments
add_task(async function test_searchBrowsingHistory_wrapper_no_args() {
  const outputStr = await searchBrowsingHistory();
  const output = JSON.parse(outputStr);

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");

  // Wrapper may legitimately return an error (e.g. semantic DB not initialized).
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with undefined
add_task(async function test_searchBrowsingHistory_wrapper_undefined_args() {
  const outputStr = await searchBrowsingHistory(undefined);
  const output = JSON.parse(outputStr);

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with null
add_task(async function test_searchBrowsingHistory_wrapper_null_args() {
  const outputStr = await searchBrowsingHistory(null);
  const output = JSON.parse(outputStr);

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with non-object (string)
add_task(async function test_searchBrowsingHistory_wrapper_string_args() {
  const outputStr = await searchBrowsingHistory("mozilla");
  const output = JSON.parse(outputStr);

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with non-object (number)
add_task(async function test_searchBrowsingHistory_wrapper_number_args() {
  const outputStr = await searchBrowsingHistory(123);
  const output = JSON.parse(outputStr);

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with non-object (boolean)
add_task(async function test_searchBrowsingHistory_wrapper_boolean_args() {
  const outputStr = await searchBrowsingHistory(true);
  const output = JSON.parse(outputStr);

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});
