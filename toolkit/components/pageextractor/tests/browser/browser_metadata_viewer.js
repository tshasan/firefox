/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const VIEWER_URL = "chrome://global/content/pageextractor/metadataViewer.html";

add_task(async function test_metadata_viewer_shows_the_previous_tab() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { cleanup } = await html`
    <meta name="description" content="A quick tomato soup." />
    <meta property="og:description" content="The best soup ever." />
    <meta property="og:title" content="Tomato Soup" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": "Tomato Soup",
        "author": { "@type": "Person", "name": "Ada" }
      }
    </script>
  `;

  const viewerTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    VIEWER_URL
  );
  const doc = viewerTab.linkedBrowser.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.getElementById("status").textContent.startsWith("Read "),
    "The viewer reads the tab that was selected before it."
  );

  Assert.deepEqual(
    [...doc.querySelectorAll("#summary li")].map(li => li.textContent),
    ["Recipe is a kind of HowTo › CreativeWork › Thing"],
    "The declared type is shown with its place in the schema.org hierarchy."
  );

  const rows = [...doc.querySelectorAll("#tags tr")].map(row => [
    row.querySelector("th").textContent,
    [...row.querySelectorAll("td > div")].map(div => div.textContent),
  ]);
  Assert.deepEqual(
    rows,
    [
      ["Title", ["Open Graph og:title Tomato Soup"]],
      [
        "Descriptionsources disagree",
        [
          "HTML description A quick tomato soup.",
          "Open Graph og:description The best soup ever.",
        ],
      ],
    ],
    "Tags stating the same thing are grouped, and disagreements flagged."
  );

  const authorLink = doc.querySelector("#nodes a");
  is(authorLink.textContent, '→ Person "Ada"', "References are named.");
  const target = doc.querySelector(authorLink.getAttribute("href"));
  is(
    target.querySelector(".declared-type").textContent,
    "Person",
    "A reference links to the card of the node it refers to."
  );

  BrowserTestUtils.removeTab(viewerTab);
  await cleanup();
});
