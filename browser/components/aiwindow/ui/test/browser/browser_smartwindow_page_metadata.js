/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * @type {import("../../../../../../toolkit/components/ml/tests/MLTestUtils.sys.mjs")}
 */
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { GET_PAGE_CONTENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { MESSAGE_ROLE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs"
);

/**
 * @import { ChatConversation } from "../../modules/ChatConversation.sys.mjs"
 */

/**
 * @returns {{url: string, cleanup: () => Promise<void>}}
 */
const serveRecipePage = () => MLTestUtils.serveHTML().html`
  <meta name="description" content="A quick tomato soup." />
  <meta
    property="og:description"
    content="The best tomato soup you will ever make."
  />
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Tomato Soup",
      "author": { "@type": "Person", "name": "Ada" },
      "recipeIngredient": ["4 tomatoes", "1 onion"]
    }
  </script>
  <h1>Tomato Soup</h1>
  <p>Simmer the tomatoes and the onion for twenty minutes, then blend.</p>
`;

/**
 * Asks Smart Window about the recipe page, has the model read it with
 * get_page_content, and returns what the tool gave back to the model.
 *
 * @returns {Promise<string>}
 */
async function readRecipePageThroughSmartWindow() {
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();
  const page = serveRecipePage();
  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    await typeInSmartbar(sidebarBrowser, "What do I need for this soup?");
    await submitSmartbar(sidebarBrowser);

    /** @type {ChatConversation} */
    const conversation = await TestUtils.waitForCondition(
      () => AIWindow.getActiveConversation(win),
      "Conversation should be created when the first message is sent."
    );

    await mockEngineManager.respondTo({
      purpose: "chat",
      response: {
        text: "",
        tokens: null,
        isPrompt: false,
        toolCalls: [
          {
            id: "call_get_page_content_1",
            function: {
              name: GET_PAGE_CONTENT,
              arguments: JSON.stringify({ url_list: [page.url] }),
            },
          },
        ],
      },
    });

    const toolMessage = await TestUtils.waitForCondition(
      () =>
        conversation.messages.find(
          message =>
            message.role === MESSAGE_ROLE.TOOL &&
            message.content?.name === GET_PAGE_CONTENT
        ),
      "A tool result for get_page_content should be added to the conversation."
    );

    await mockEngineManager.respondTo({
      purpose: "chat",
      response: "Four tomatoes and an onion.",
    });
    await mockEngineManager.respondTo({
      purpose: "title-generation",
      response: "Tomato soup",
    });

    return toolMessage.content.body.join("\n");
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
    await page.cleanup();
  }
}

add_task(async function test_get_page_content_includes_page_metadata() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", true]],
  });

  const body = await readRecipePageThroughSmartWindow();

  Assert.stringContains(
    body,
    "Simmer the tomatoes and the onion",
    "The page content is still given to the model."
  );
  Assert.ok(
    body.endsWith(
      [
        "Metadata the page declares about itself, which may be incomplete or wrong:",
        "- Recipe (a kind of HowTo, CreativeWork)",
        "  name: Tomato Soup",
        '  author: Person "Ada"',
        "  recipeIngredient: 4 tomatoes; 1 onion",
        "- description (HTML): A quick tomato soup.",
        "- og:description (Open Graph): The best tomato soup you will ever make.",
      ].join("\n")
    ),
    `The model is told what the page declares, with each source labelled: ${body}`
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_get_page_content_without_page_metadata() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", false]],
  });

  const body = await readRecipePageThroughSmartWindow();

  Assert.stringContains(
    body,
    "Simmer the tomatoes and the onion",
    "The page content is given to the model."
  );
  Assert.ok(
    !body.includes("Metadata the page declares"),
    "Without the pref, the metadata is left out."
  );

  await SpecialPowers.popPrefEnv();
});
