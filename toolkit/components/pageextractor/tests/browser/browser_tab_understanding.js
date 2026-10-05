/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PANEL_URL = "chrome://global/content/pageextractor/tabUnderstanding.html";

add_task(async function test_tabs_are_grouped_by_what_pages_declare() {
  const recipe = await MLTestUtils.serveHTMLInTab({ browser: gBrowser }).html`
    <title>Tomato Soup</title>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", "name": "Soup Site" },
          {
            "@type": ["Recipe"],
            "name": "Tomato Soup",
            "totalTime": "PT75M",
            "recipeYield": "4 servings",
            "recipeIngredient": ["4 tomatoes", "1 onion", "Salt"],
            "author": { "@type": "Person", "name": "Ada" },
            "aggregateRating": {
              "@type": "AggregateRating",
              "ratingValue": "4.8",
              "ratingCount": "1234"
            }
          }
        ]
      }
    </script>
  `;
  const article = await MLTestUtils.serveHTMLInTab({ browser: gBrowser }).html`
    <title>Local news</title>
    <meta property="og:type" content="article" />
    <meta name="description" content="Something happened in town." />
  `;

  const panelTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    PANEL_URL
  );
  const doc = panelTab.linkedBrowser.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.getElementById("status").textContent.startsWith("Read "),
    "The panel reads the open tabs."
  );

  const testTitles = ["Tomato Soup", "Local news"];
  const groups = [...doc.querySelectorAll(".group")]
    .map(group => [
      group.querySelector("h2").firstChild.textContent,
      [...group.querySelectorAll(".card-title")]
        .map(title => title.textContent)
        .filter(title => testTitles.includes(title)),
    ])
    .filter(([, titles]) => titles.length);
  Assert.deepEqual(
    groups,
    [
      ["Recipes", ["Tomato Soup"]],
      ["Articles", ["Local news"]],
    ],
    "Tabs are grouped by the kind of page they declare, ignoring scaffolding."
  );

  const [recipeCard, articleCard] = testTitles.map(title =>
    [...doc.querySelectorAll(".card")].find(
      card => card.querySelector(".card-title").textContent == title
    )
  );
  Assert.deepEqual(
    [...recipeCard.querySelectorAll(".facts > *")].map(
      cell => cell.textContent
    ),
    [
      "Total time",
      "1 hr 15 min",
      "Serves",
      "4 servings",
      "Ingredients",
      "3",
      "Rating",
      "★ 4.8 (1,234)",
      "By",
      "Ada",
    ],
    "Key facts come from the page's own data, following its references."
  );
  Assert.stringContains(
    recipeCard.querySelector(".meta").textContent,
    "declares Recipe, a kind of HowTo",
    "The card says what the page declared."
  );

  const ingredients = recipeCard.querySelector(".ingredients");
  ok(ingredients.hidden, "Ingredients start hidden.");
  [...recipeCard.querySelectorAll("button")]
    .find(button => button.textContent == "Show ingredients")
    .click();
  Assert.deepEqual(
    [...ingredients.querySelectorAll("li")].map(li => li.textContent),
    ["4 tomatoes", "1 onion", "Salt"],
    "The ingredient list can be shown without visiting the page."
  );
  ok(!ingredients.hidden, "Ingredients are shown.");

  Assert.stringContains(
    articleCard.querySelector(".meta").textContent,
    "Open Graph says Articles",
    "Without schema.org data, the Open Graph type is used."
  );
  is(
    articleCard.querySelector(".description").textContent,
    "Something happened in town.",
    "A page without key facts shows its description."
  );

  BrowserTestUtils.removeTab(panelTab);
  BrowserTestUtils.removeTab(recipe.tab);
  BrowserTestUtils.removeTab(article.tab);
  await recipe.cleanup();
  await article.cleanup();
});
