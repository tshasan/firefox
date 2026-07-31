/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SEARCH_ANSWER_SCHEMA, runSearchTheWeb } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/search/SearchWorkflow.sys.mjs"
);

const {
  GetPageContent,
  GET_PAGE_CONTENT,
  SEARCH_QUERY_ENDPOINT_PREF,
  SEARCH_QUERY_APIKEY_PREF,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { PURPOSES, MODEL_FEATURES, SERVICE_TYPES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);

const { Chat } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs"
);

const { replaceUrlsWithTokens, expandUrlTokensInToolParams } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs"
  );

const { MockEngineManager, MockSearchManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);

const TEST_MODEL = "test-model";
const SEARCH_ENDPOINT = "https://search.example.test/v1/search";
const SEARCH_API_KEY = "mock-search-api-key";

/**
 * Point the search provider at the mocked endpoint and provide a test API key.
 *
 * @returns {Promise<void>}
 */
async function pushSearchPrefs() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [SEARCH_QUERY_ENDPOINT_PREF, SEARCH_ENDPOINT],
      [SEARCH_QUERY_APIKEY_PREF, SEARCH_API_KEY],
    ],
  });
}

/**
 * Serve several real result pages from one HTTP server so the workflow's page
 * reads hit the real extractor.
 *
 * @param {string[]} bodies - HTML body for each result page.
 * @returns {{urls: string[], requestCounts: number[], server: object}}
 *   The page URLs, per-page request counts, and server.
 */
function serveResultPages(bodies) {
  const server = new HttpServer();
  const requestCounts = bodies.map(() => 0);
  const paths = bodies.map((body, index) => {
    const path = `/result-${index}.html`;
    server.registerPathHandler(path, (_request, response) => {
      requestCounts[index]++;
      response.setHeader("Content-Type", "text/html");
      response.write(body);
    });
    return path;
  });
  server.start(-1);
  const { primaryHost, primaryPort } = server.identity;
  const urls = paths.map(
    // eslint-disable-next-line @microsoft/sdl/no-insecure-url
    path => `http://${primaryHost}:${primaryPort}${path}`
  );
  return { urls, requestCounts, server };
}

/**
 * Serve result pages that hold their response open until the test releases
 * them, so a test can observe how many page reads are in flight at once.
 *
 * @param {string[]} bodies - HTML body for each result page.
 * @returns {{urls: string[], requestCounts: number[], pendingCount: () => number,
 *   releaseAll: () => void, server: object}} The page URLs, per-page request
 *   counts, the number of reads currently held open, a release callback, and
 *   the server.
 */
function serveGatedResultPages(bodies) {
  const server = new HttpServer();
  const requestCounts = bodies.map(() => 0);
  const pending = [];
  const paths = bodies.map((body, index) => {
    const path = `/gated-${index}.html`;
    server.registerPathHandler(path, (_request, response) => {
      requestCounts[index]++;
      response.setHeader("Content-Type", "text/html");
      response.processAsync();
      pending.push(() => {
        response.write(body);
        response.finish();
      });
    });
    return path;
  });
  server.start(-1);
  const { primaryHost, primaryPort } = server.identity;
  const urls = paths.map(
    // eslint-disable-next-line @microsoft/sdl/no-insecure-url
    path => `http://${primaryHost}:${primaryPort}${path}`
  );
  return {
    urls,
    requestCounts,
    pendingCount: () => pending.length,
    releaseAll: () => {
      for (const release of pending.splice(0)) {
        release();
      }
    },
    server,
  };
}

add_task(async function test_search_the_web_end_to_end() {
  const query = "What is the featured widget's price?";
  const pageContent = "The featured widget is on sale for nine dollars today.";
  const {
    urls: [pageUrl],
    requestCounts,
    server: pageServer,
  } = serveResultPages([
    `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Widget Store</title></head>
      <body><article><h1>Widget Store</h1><p>${pageContent}</p></article></body></html>`,
  ]);
  const results = [
    {
      title: "Widget Store",
      url: pageUrl,
      text: "A page containing the featured widget's price.",
    },
  ];
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query }, conversation);

    const search = await mockSearchManager.captureRequest();
    Assert.equal(
      search.request.url,
      SEARCH_ENDPOINT,
      "The provider uses the configured search endpoint"
    );
    Assert.equal(
      search.request.options.method,
      "POST",
      "The provider sends a POST request"
    );
    Assert.deepEqual(
      search.request.options.headers,
      {
        "Content-Type": "application/json",
        Accept: "application/json",
        "service-type": "search",
        Authorization: `Bearer ${SEARCH_API_KEY}`,
      },
      "The provider sends the expected search headers"
    );
    Assert.deepEqual(
      JSON.parse(search.request.options.body),
      { query, max_results: 10 },
      "The provider sends the expected search body"
    );
    search.respond({ results });

    const readTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.equal(
      readTurn.request.tool_choice,
      "auto",
      "The answer-generation model may request page content"
    );
    Assert.deepEqual(
      readTurn.request.tools.map(tool => tool.function.name),
      [GET_PAGE_CONTENT],
      "Only get_page_content is offered to the answer-generation model"
    );
    const readRequestArgs = JSON.stringify(readTurn.request.args);
    Assert.ok(
      readRequestArgs.includes(query),
      "The model request includes the search query"
    );
    Assert.ok(
      readRequestArgs.includes("Widget Store"),
      "The model request includes the normalized search result"
    );
    Assert.ok(
      readRequestArgs.includes("result_1"),
      "The search result has a stable result id"
    );
    readTurn.respond({
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "read_search_result",
          function: {
            name: GET_PAGE_CONTENT,
            arguments: JSON.stringify({ result_ids: ["result_1"] }),
          },
        },
      ],
    });

    // The one result has been read, so no further read could return content and
    // the flow goes straight to the forced-schema turn.
    const answerTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.equal(
      answerTurn.request.tool_choice,
      "none",
      "The final generation cannot call tools"
    );
    Assert.deepEqual(
      answerTurn.request.tools,
      [],
      "No tools are offered during final generation"
    );
    Assert.ok(
      JSON.stringify(answerTurn.request.args).includes(pageContent),
      "The final generation carries the content extracted from the result page"
    );
    const expectedAnswer = {
      answer: "The widget is nine dollars.",
      could_answer: true,
      confidence: 0.9,
    };
    answerTurn.respond(JSON.stringify(expectedAnswer));

    const result = await runPromise;
    conversation.securityProperties.commit();

    Assert.deepEqual(
      result,
      {
        ...expectedAnswer,
        searched_urls: [pageUrl],
        read_urls: [pageUrl],
        requiresSearchHandoff: false,
      },
      "The workflow returns the validated answer and code-tracked URLs"
    );
    Assert.equal(
      requestCounts[0],
      1,
      "The selected result page is fetched once"
    );
    Assert.deepEqual(
      [...conversation.seenUrls],
      [pageUrl],
      "The search result is recorded as a seen URL"
    );
    Assert.deepEqual(
      [...conversation.serpUrlsForAnonymousFetch],
      [pageUrl],
      "The search result is eligible for anonymous page extraction"
    );
    Assert.ok(
      conversation.securityProperties.privateData,
      "Running a web search marks the conversation as private"
    );
    Assert.ok(
      conversation.securityProperties.untrustedInput,
      "Search results are treated as untrusted input"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => pageServer.stop(resolve));
  }
});

add_task(function test_exa_result_url_token_round_trip() {
  const conversation = new ChatConversation({});
  const results = [
    {
      title: "One",
      url: "https://round-trip.example.com/alpha",
      snippet: "s1",
    },
    { title: "Two", url: "https://round-trip.example.com/beta", snippet: "s2" },
  ];
  const urls = results.map(result => result.url);
  const formatted = results
    .map(result => `${result.title} — ${result.url}\n${result.snippet}`)
    .join("\n\n");
  conversation.addSeenUrls(urls);
  conversation.addSerpUrlsForAnonymousFetch(urls);

  Assert.equal(
    conversation.serpUrlsForAnonymousFetch.size,
    urls.length,
    "The ledger holds all result URLs"
  );

  replaceUrlsWithTokens(conversation, [{ role: "tool", content: formatted }]);

  for (const url of urls) {
    const token = conversation.urlToToken.get(url);
    Assert.ok(token, `The result URL is tokenized: ${url}`);

    const toolParams = { url_list: [`§url_token: ${token}§`] };
    expandUrlTokensInToolParams(toolParams, conversation.tokenToUrl);
    Assert.deepEqual(
      toolParams.url_list,
      [url],
      "The token expands back to the exact ledger URL"
    );
  }
});

add_task(async function test_search_the_web_reads_result_pages_up_to_limit() {
  // Four results are returned, the model asks to read all of them, and the
  // workflow caps the reads at MAX_PAGES (3), fetching the real served pages.
  const bodies = [0, 1, 2, 3].map(
    index =>
      `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Page ${index}</title></head>` +
      `<body><article><p>Result page ${index} body content.</p></article></body></html>`
  );
  const { urls, requestCounts, server: pagesServer } = serveResultPages(bodies);
  const results = urls.map((url, index) => ({
    title: `Page ${index}`,
    url,
    snippet: `snippet ${index}`,
  }));
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "pages" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results });

    // First answer-gen turn: the model requests every result id.
    const readTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    readTurn.respond([
      {
        text: "",
        tokens: null,
        isPrompt: false,
        toolCalls: [
          {
            id: "call_read_all",
            function: {
              name: "get_page_content",
              arguments: JSON.stringify({
                result_ids: ["result_1", "result_2", "result_3", "result_4"],
              }),
            },
          },
        ],
      },
    ]);

    // The page budget is spent, so the loop ends and the next turn is the
    // structured answer.
    (
      await mockEngineManager.captureRequest({ purpose: PURPOSES.CHAT })
    ).respond(
      JSON.stringify({
        answer: "Answer from pages.",
        could_answer: true,
        confidence: 0.8,
      })
    );

    const result = await runPromise;

    Assert.equal(
      result.searched_urls.length,
      4,
      "All four search results are tracked as searched"
    );
    Assert.equal(
      result.read_urls.length,
      3,
      "The page-read loop is capped at MAX_PAGES (3)"
    );
    for (const readUrl of result.read_urls) {
      Assert.ok(
        urls.includes(readUrl),
        `A read URL is one of the served result pages: ${readUrl}`
      );
    }
    Assert.deepEqual(
      requestCounts,
      [1, 1, 1, 0],
      "Only the first three result pages are fetched"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => pagesServer.stop(resolve));
  }
});

add_task(async function test_search_the_web_spends_no_turn_on_refused_reads() {
  // Once the page budget is spent, offering get_page_content again can only
  // produce a request readPage refuses, so the flow must not spend a model
  // round trip on it. Four results are served and the model reads three in one
  // call, exhausting MAX_PAGES while unread results remain — the state where
  // the old code burned two further round trips (one to collect a read request
  // it then refused, one to write prose that the schema turn rewrote).
  //
  // The test answers exactly two turns. A regression that reintroduces either
  // round trip fails here: the extra request either leaves the flow waiting for
  // a response this test never gives (timeout), or shows up unhandled in
  // assertAllRequestsHandled().
  const bodies = [0, 1, 2, 3].map(
    index =>
      `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Page ${index}</title></head>` +
      `<body><article><p>Body of result page ${index}.</p></article></body></html>`
  );
  const { urls, server: pagesServer } = serveResultPages(bodies);
  const results = urls.map((url, index) => ({
    title: `Page ${index}`,
    url,
    snippet: `snippet ${index}`,
  }));
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "pages" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results });

    // Turn 1: reads are still possible, so the tool is offered.
    const readTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.deepEqual(
      readTurn.request.tools.map(tool => tool.function.name),
      [GET_PAGE_CONTENT],
      "The first turn offers the page-read tool"
    );
    readTurn.respond({
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_read_three",
          function: {
            name: GET_PAGE_CONTENT,
            arguments: JSON.stringify({
              result_ids: ["result_1", "result_2", "result_3"],
            }),
          },
        },
      ],
    });

    // Turn 2 is the forced-schema turn, not another read round.
    const answerTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.deepEqual(
      answerTurn.request.tools,
      [],
      "The turn after the budget is spent offers no tools"
    );
    Assert.equal(
      answerTurn.request.tool_choice,
      "none",
      "The turn after the budget is spent cannot call tools"
    );
    const answerArgs = JSON.stringify(answerTurn.request.args);
    for (const index of [0, 1, 2]) {
      Assert.ok(
        answerArgs.includes(`Body of result page ${index}.`),
        `The answer turn carries the extracted text of page ${index}`
      );
    }
    Assert.ok(
      !answerArgs.includes("Body of result page 3."),
      "The unread fourth page contributes no content"
    );
    answerTurn.respond(
      JSON.stringify({
        answer: "Answer from three pages.",
        could_answer: true,
        confidence: 0.7,
      })
    );

    const result = await runPromise;
    Assert.equal(
      result.answer,
      "Answer from three pages.",
      "The workflow answers in two model turns"
    );
    Assert.equal(
      result.read_urls.length,
      3,
      "All three reads happened in the single read round"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => pagesServer.stop(resolve));
  }
});

add_task(async function test_search_the_web_json_round_skips_the_schema_turn() {
  // A read round that asks for no page content is the final answer: the model
  // is told to either call get_page_content or emit the JSON object, so a round
  // whose body parses is returned as-is and the forced-schema turn — a whole
  // round trip that only regenerates the same answer — never runs.
  //
  // This test answers exactly one model turn. A regression that always issues
  // the schema turn fails here: the extra request either leaves the flow
  // waiting for a response this test never gives (timeout), or shows up
  // unhandled in assertAllRequestsHandled().
  const results = [
    { title: "Page", url: "https://example.com/page", snippet: "s" },
  ];
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "widgets" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results });

    const readTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.equal(
      readTurn.request.tool_choice,
      "auto",
      "The read round still lets the model call the page-read tool"
    );
    Assert.ok(
      JSON.stringify(readTurn.request.args).includes(
        "output only the final JSON object"
      ),
      "The read round tells the model it may answer with the final JSON object"
    );

    // Fenced, which is how models usually emit JSON in a prose turn.
    const expectedAnswer = {
      answer: "Widgets are nine dollars.",
      could_answer: true,
      confidence: 0.85,
    };
    readTurn.respond("```json\n" + JSON.stringify(expectedAnswer) + "\n```");

    const result = await runPromise;
    Assert.deepEqual(
      result,
      {
        ...expectedAnswer,
        searched_urls: ["https://example.com/page"],
        read_urls: [],
        requiresSearchHandoff: false,
      },
      "The answer emitted by the read round is returned without a schema turn"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_search_the_web_prose_round_still_answers() {
  // The "call the tool or emit JSON" contract is added client-side, so a
  // Remote Settings prompt revision that contradicts it — or a model that
  // simply ignores it — can still end a read round with prose. That must not
  // lose the answer: the forced-schema turn is the fallback and still runs.
  const results = [
    { title: "Page", url: "https://example.com/page", snippet: "s" },
  ];
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "widgets" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results });

    const prose = "From what I found, widgets are nine dollars right now.";
    (
      await mockEngineManager.captureRequest({ purpose: PURPOSES.CHAT })
    ).respond(prose);

    const answerTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.equal(
      answerTurn.request.tool_choice,
      "none",
      "An unparseable read round falls back to the forced-schema turn"
    );
    Assert.deepEqual(
      answerTurn.request.tools,
      [],
      "No tools are offered during the fallback schema turn"
    );
    Assert.ok(
      JSON.stringify(answerTurn.request.args).includes(prose),
      "The prose round stays in the transcript the schema turn answers from"
    );
    const expectedAnswer = {
      answer: "Widgets are nine dollars.",
      could_answer: true,
      confidence: 0.6,
    };
    answerTurn.respond(JSON.stringify(expectedAnswer));

    const result = await runPromise;
    Assert.deepEqual(
      result,
      {
        ...expectedAnswer,
        searched_urls: ["https://example.com/page"],
        read_urls: [],
        requiresSearchHandoff: false,
      },
      "The schema turn recovers the answer from an unparseable read round"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_search_the_web_reads_a_round_of_calls_at_once() {
  // A round may emit several get_page_content calls. Every one of them is read,
  // the reads overlap instead of queueing behind each other, the tool messages
  // come back in tool-call order, and MAX_PAGES still bounds the total.
  //
  // The served pages hold their responses open, so the wait below can only be
  // satisfied if the second tool call's read started while the first call's
  // reads were still in flight. Serializing the calls again deadlocks here.
  const bodies = [0, 1, 2, 3].map(
    index =>
      `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Page ${index}</title></head>` +
      `<body><article><p>Gated body of result page ${index}.</p></article></body></html>`
  );
  const {
    urls,
    requestCounts,
    pendingCount,
    releaseAll,
    server: pagesServer,
  } = serveGatedResultPages(bodies);
  const results = urls.map((url, index) => ({
    title: `Page ${index}`,
    url,
    snippet: `snippet ${index}`,
  }));
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "pages" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results });

    const readTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    readTurn.respond({
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_first_pair",
          function: {
            name: GET_PAGE_CONTENT,
            arguments: JSON.stringify({
              result_ids: ["result_1", "result_2"],
            }),
          },
        },
        {
          id: "call_second_pair",
          function: {
            name: GET_PAGE_CONTENT,
            arguments: JSON.stringify({
              result_ids: ["result_3", "result_4"],
            }),
          },
        },
      ],
    });

    // MAX_PAGES (3) is claimed in tool-call order: the first call takes two
    // pages and leaves one for the second, so three reads are in flight at
    // once and the fourth page is never requested.
    await TestUtils.waitForCondition(
      () => pendingCount() === 3,
      "Both tool calls' reads are in flight at the same time"
    );
    releaseAll();

    const answerTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    const toolMessages = answerTurn.request.args.filter(
      message => message.role === "tool"
    );
    Assert.deepEqual(
      toolMessages.map(message => message.tool_call_id),
      ["call_first_pair", "call_second_pair"],
      "The tool messages are appended in tool-call order"
    );
    Assert.ok(
      toolMessages[0].content.includes("Gated body of result page 0.") &&
        toolMessages[0].content.includes("Gated body of result page 1."),
      "The first tool call's message carries both of the pages it read"
    );
    Assert.ok(
      toolMessages[1].content.includes("Gated body of result page 2."),
      "The second tool call's message carries the page left in the budget"
    );
    Assert.ok(
      !JSON.stringify(answerTurn.request.args).includes(
        "Gated body of result page 3."
      ),
      "The fourth page is beyond MAX_PAGES and contributes no content"
    );
    answerTurn.respond(
      JSON.stringify({
        answer: "Answer from the batched pages.",
        could_answer: true,
        confidence: 0.7,
      })
    );

    const result = await runPromise;
    Assert.deepEqual(
      result.read_urls,
      [urls[0], urls[1], urls[2]],
      "MAX_PAGES bounds the round's reads and is claimed in tool-call order"
    );
    Assert.deepEqual(
      requestCounts,
      [1, 1, 1, 0],
      "Only the three pages within the page budget are fetched"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    releaseAll();
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => pagesServer.stop(resolve));
  }
});

add_task(async function test_search_the_web_invalid_answer_is_not_answered() {
  // A non-JSON model answer must fail schema validation and default to a
  // not-answered result so the assistant falls back rather than surfacing junk.
  const results = [
    { title: "Page", url: "https://example.com/page", snippet: "s" },
  ];
  await pushSearchPrefs();

  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "q" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results });
    (
      await mockEngineManager.captureRequest({ purpose: PURPOSES.CHAT })
    ).respond("");
    (
      await mockEngineManager.captureRequest({ purpose: PURPOSES.CHAT })
    ).respond("this is not valid json");

    const result = await runPromise;
    Assert.equal(
      result.could_answer,
      false,
      "A non-JSON answer is treated as not-answered"
    );
    Assert.equal(
      result.answer,
      "",
      "The answer defaults to empty on malformed output"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_search_the_web_retrieval_error_returns_failure() {
  // A non-2xx from the search endpoint must be caught and returned as a
  // not-answered result with an error, never thrown.
  await pushSearchPrefs();

  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "q" }, conversation);
    (await mockSearchManager.captureRequest()).respond("boom", {
      status: 500,
      statusText: "Internal Server Error",
    });
    const result = await runPromise;
    Assert.equal(
      result.could_answer,
      false,
      "A retrieval error yields a not-answered result"
    );
    Assert.deepEqual(
      result.searched_urls,
      [],
      "No URLs are searched when retrieval fails"
    );
    Assert.ok(
      result.error,
      "An error message is returned so the assistant can fall back"
    );
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockSearchManager.rejectAllRequests();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_search_the_web_no_results_returns_failure() {
  // An empty result set short-circuits before answer generation.
  await pushSearchPrefs();

  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const runPromise = runSearchTheWeb({ query: "q" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results: [] });
    const result = await runPromise;
    Assert.equal(
      result.could_answer,
      false,
      "No results yields a not-answered result"
    );
    Assert.deepEqual(result.searched_urls, [], "No URLs are searched");
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockSearchManager.rejectAllRequests();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_search_the_web_second_call_escalates_to_handoff() {
  // The first search_the_web call answers in chat and marks the turn as having
  // searched; a second call in the same turn escalates to the handoff (kind
  // HANDOFF) without running another retrieval. Empty results keep the first
  // call fast — the tool still ran, which is what marks the turn.
  await pushSearchPrefs();

  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  try {
    const firstPromise = runSearchTheWeb({ query: "weather" }, conversation);
    (await mockSearchManager.captureRequest()).respond({ results: [] });
    const first = await firstPromise;
    Assert.equal(
      first.requiresSearchHandoff,
      false,
      "The first call answers in chat (ANSWER), not a handoff"
    );
    Assert.equal(
      conversation._searchTheWebTurn,
      conversation.currentTurnIndex(),
      "The first call marks the current turn as having searched"
    );

    // No captureRequest() is set up for the second call: had it tried to
    // retrieve again, this await would hang. Its resolving is the proof that the
    // handoff short-circuits before any Exa search.
    const second = await runSearchTheWeb(
      { query: "weather again" },
      conversation
    );
    Assert.equal(
      second.requiresSearchHandoff,
      true,
      "A second call in the same turn escalates to the handoff"
    );

    mockSearchManager.assertAllRequestsHandled();
  } finally {
    mockSearchManager.rejectAllRequests();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_search_the_web_page_read_timeout_does_not_hang() {
  // A headless page load that never settles must not hang the answer flow:
  // readPage races the fetch against a resolving timeout, so a stuck read
  // yields a fallback and generateAnswer still produces an answer. The read
  // timeout pref is shrunk so the test doesn't wait the 15s default.
  await pushSearchPrefs();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.search.readTimeoutMs", 50]],
  });

  const sb = sinon.createSandbox();
  const mockEngineManager = new MockEngineManager();
  const mockSearchManager = new MockSearchManager();
  const conversation = new ChatConversation({
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });

  // Simulate a stuck headless load: getPageContent never settles.
  const hangStub = sb
    .stub(GetPageContent, "getPageContent")
    .callsFake(() => new Promise(() => {}));

  try {
    const runPromise = runSearchTheWeb({ query: "widgets" }, conversation);

    (await mockSearchManager.captureRequest()).respond({
      results: [
        {
          title: "Widget Store",
          url: "https://widgets.example/store",
          text: "A page with widget prices.",
        },
      ],
    });

    // First answer-generation turn: the model asks to read the result page.
    (
      await mockEngineManager.captureRequest({ purpose: PURPOSES.CHAT })
    ).respond({
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "read_1",
          function: {
            name: GET_PAGE_CONTENT,
            arguments: JSON.stringify({ result_ids: ["result_1"] }),
          },
        },
      ],
    });

    // The read hangs and times out (~50ms). The fallback text is fed back as
    // the tool result, so the final request's args must contain it — proof the
    // stuck read resolved instead of hanging the flow. A timed-out read still
    // counts as read, so no further read is possible and this is the
    // forced-schema turn.
    const answerTurn = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CHAT,
    });
    Assert.ok(
      JSON.stringify(answerTurn.request.args).includes("Timed out reading"),
      "A stuck page read resolves to the timeout fallback"
    );
    answerTurn.respond(
      JSON.stringify({
        answer: "Widgets vary in price.",
        could_answer: true,
        confidence: 0.6,
      })
    );

    const result = await runPromise;
    Assert.ok(
      result.could_answer,
      "The workflow still produces an answer despite the stuck read"
    );
    Assert.ok(
      hangStub.called,
      "getPageContent was invoked (and abandoned on timeout)"
    );
    mockEngineManager.assertAllRequestsHandled();
    mockSearchManager.assertAllRequestsHandled();
  } finally {
    sb.restore();
    mockEngineManager.rejectAllRequests();
    mockSearchManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    mockSearchManager.cleanupMocks();
    await SpecialPowers.popPrefEnv(); // read-timeout pref
    await SpecialPowers.popPrefEnv(); // search prefs
  }
});
