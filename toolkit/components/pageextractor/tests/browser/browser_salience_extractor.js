/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_salience_extractor_drops_imperceptible_text() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <style>
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
      .gradient {
        background: linear-gradient(red, blue);
        background-clip: text;
        color: transparent;
      }
    </style>
    <main>
      <p>Visible paragraph.</p>
      <p style="font-size: 0">Zero font size.</p>
      <p style="color: white; background: white">White on white.</p>
      <p style="color: #fefefe">Near white on the page.</p>
      <p class="sr-only">Screen reader only.</p>
      <div style="opacity: 0.05"><p>Faded ancestor.</p></div>
      <p style="text-indent: -9999px">Indented off the page.</p>
      <p style="position: absolute; left: -9999px">Positioned off the page.</p>
      <p style="visibility: hidden">Visibility hidden.</p>
      <p aria-hidden="true">Visible but aria hidden.</p>
      <p class="gradient">Gradient text.</p>
    </main>
  `;
  const actor = getPageExtractor();

  const hidden = [
    "White on white.",
    "Near white on the page.",
    "Screen reader only.",
    "Faded ancestor.",
    "Indented off the page.",
    "Positioned off the page.",
  ];

  const { text: domText } = await actor.getText();
  for (const line of hidden) {
    ok(
      domText.includes(line),
      `The DOMExtractor lets through text the user can't see: "${line}"`
    );
  }

  is(
    (await actor.getText({ useSalienceExtractor: true })).text,
    ["Visible paragraph.", "Visible but aria hidden.", "Gradient text."].join(
      "\n"
    ),
    "Only the text a sighted user can perceive is extracted."
  );

  return cleanup();
});

add_task(async function test_salience_extractor_reading_order() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <div>
      Before the block,
      <span>with an inline span.</span>
      <div>The nested block.</div>
      After the block.
    </div>
    <custom-element></custom-element>
    <script>
      customElements.define(
        "custom-element",
        class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "closed" }).innerHTML =
              "<p>Shadow DOM text.</p>";
          }
        }
      );
    </script>
  `;

  is(
    (await getPageExtractor().getText({ useSalienceExtractor: true })).text,
    [
      "Before the block, with an inline span.",
      "The nested block.",
      "After the block.",
      "Shadow DOM text.",
    ].join("\n"),
    "Blocks are extracted in the order they render, including shadow DOM."
  );

  return cleanup();
});

add_task(async function test_salience_extractor_headings_and_links() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <h1>Semantic heading</h1>
    <div role="heading" aria-level="3">ARIA heading</div>
    <div role="heading" aria-level="-1">Invalid heading level</div>
    <div role="heading" aria-level="1000000000">Large heading level</div>
    <div style="font-size: 40px">Visually large</div>
    <p>A paragraph with <a href="https://example.com/a">a link</a> in it.</p>
    <p>Another paragraph of regular text to set the median font size.</p>
  `;
  const actor = getPageExtractor();

  is(
    (await actor.getText({ useSalienceExtractor: true })).text,
    [
      "# Semantic heading",
      "### ARIA heading",
      "## Invalid heading level",
      "###### Large heading level",
      "## Visually large",
      "A paragraph with [a link](https://example.com/a) in it.",
      "Another paragraph of regular text to set the median font size.",
    ].join("\n"),
    "Headings and links are marked up as markdown."
  );

  is(
    (await actor.getText({ useSalienceExtractor: true, useSimpleText: true }))
      .text,
    [
      "Semantic heading",
      "ARIA heading",
      "Invalid heading level",
      "Large heading level",
      "Visually large",
      "A paragraph with a link in it.",
      "Another paragraph of regular text to set the median font size.",
    ].join("\n"),
    "Simple text has no markup."
  );

  return cleanup();
});

add_task(async function test_salience_extractor_sufficient_length() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <nav>
      <a href="/home">Home</a> <a href="/news">News</a>
      <a href="/sports">Sports</a>
    </nav>
    <main>
      <h1>The article title</h1>
      <p>The first paragraph of the article.</p>
    </main>
    <footer>Copyright notice for the footer.</footer>
  `;
  const actor = getPageExtractor();

  const { text: allText } = await actor.getText({
    useSalienceExtractor: true,
    useSimpleText: true,
  });
  is(
    allText,
    [
      "Home News Sports",
      "The article title",
      "The first paragraph of the article.",
      "Copyright notice for the footer.",
    ].join("\n"),
    "All of the text is extracted without a sufficient length."
  );

  is(
    (
      await actor.getText({
        useSalienceExtractor: true,
        useSimpleText: true,
        sufficientLength: "The article title".length + 10,
      })
    ).text,
    ["The article title", "The first paragraph of the article."].join("\n"),
    "The main content is kept over the navigation and footer, in reading order."
  );

  return cleanup();
});

add_task(async function test_salience_extractor_reaches_late_main_content() {
  const introduction = "Unmarked introductory text.";
  const preamble = `<p>${introduction}</p>`.repeat(20);
  for (const region of ["main", "article", 'div role="main"']) {
    const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
    const regionHTML = `<${region}>
      <h1>Product specifications</h1>
      <p>Battery life: 18 hours.</p>
    </${region.split(" ")[0]}>`;
    const { getPageExtractor, cleanup } = await html`
      <div>
        ${preamble}
        <section>${regionHTML}</section>
      </div>
    `;
    try {
      const actor = getPageExtractor();
      is(
        (
          await actor.getText({
            useSalienceExtractor: true,
            useSimpleText: true,
            sufficientLength: 40,
          })
        ).text,
        "Product specifications\nBattery life: 18 hours.",
        `${region} content survives an unmarked preamble exceeding the collection limit.`
      );
      is(
        (
          await actor.getText({
            useSalienceExtractor: true,
            useSimpleText: true,
            sufficientLength: 60,
          })
        ).text,
        `${introduction}\nProduct specifications\nBattery life: 18 hours.`,
        "Unmarked text fills the remaining allowance in document order."
      );
      is(
        (
          await actor.getText({
            useSalienceExtractor: true,
            useSimpleText: true,
          })
        ).text,
        `${Array(20).fill(introduction).join("\n")}\nProduct specifications\nBattery life: 18 hours.`,
        "Without a target, all text stays in reading order."
      );
    } finally {
      await cleanup();
    }
  }
});

add_task(
  async function test_salience_extractor_keeps_text_the_user_can_reach() {
    const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
    const { getPageExtractor, cleanup } = await html`
      <p>The <code>clip-path</code> property.</p>
      <pre style="width: 50px; overflow: auto">
a long line that scrolls sideways</pre
      >
      <h2><span>Section</span><a href="https://example.com/edit">edit</a></h2>
      <p style="text-transform: uppercase">shown in capitals</p>
    `;

    is(
      (
        await getPageExtractor().getText({
          useSalienceExtractor: true,
          useSimpleText: true,
        })
      ).text,
      [
        "The clip-path property.",
        "a long line that scrolls sideways",
        "Sectionedit",
        "SHOWN IN CAPITALS",
      ].join("\n"),
      "Inline code and scrollable overflow are kept, and text is transformed."
    );

    return cleanup();
  }
);

add_task(async function test_salience_extractor_keeps_reachable_clipped_text() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <style>
      .carousel {
        width: 200px;
        overflow: hidden;
      }
      .track {
        display: flex;
        width: 600px;
      }
      .track p {
        width: 200px;
        margin: 0;
      }
    </style>
    <p>A visible introduction to the page.</p>
    <div class="carousel">
      <div class="track">
        <p>First slide.</p>
        <p>Second slide.</p>
        <p>Third slide.</p>
      </div>
    </div>
    <div style="max-height: 1.2em; overflow: hidden">
      <p style="margin: 0">The visible line of a truncated review.</p>
      <p style="margin: 0">The rest of the review behind read more.</p>
    </div>
    <div style="overflow: hidden; position: relative; height: 100px">
      <p style="position: absolute; left: -9999px">Before the start edge.</p>
    </div>
  `;
  const actor = getPageExtractor();

  is(
    (await actor.getText({ useSalienceExtractor: true, useSimpleText: true }))
      .text,
    [
      "A visible introduction to the page.",
      "First slide.",
      "Second slide.",
      "Third slide.",
      "The visible line of a truncated review.",
      "The rest of the review behind read more.",
    ].join("\n"),
    "Text that can be brought into view is kept, but not text before the start edge."
  );

  is(
    (
      await actor.getText({
        useSalienceExtractor: true,
        useSimpleText: true,
        sufficientLength: 60,
      })
    ).text,
    [
      "A visible introduction to the page.",
      "First slide.",
      "The visible line of a truncated review.",
    ].join("\n"),
    "Visible text is preferred over text that has to be brought into view."
  );

  return cleanup();
});

add_task(async function test_salience_extractor_regions_and_rows() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <div style="position: fixed; bottom: 0">We use cookies on this site.</div>
    <nav><a href="https://example.com/home">Home</a></nav>
    <table>
      <tr>
        <td>1.</td>
        <td><a href="https://example.com/story">A story title</a></td>
      </tr>
      <tr>
        <td></td>
        <td>100 points by someone</td>
      </tr>
    </table>
    <main>
      <a href="https://example.com/card"><div>A card that is one link</div></a>
      <p>The main content of the page.</p>
    </main>
  `;
  const actor = getPageExtractor();

  is(
    (await actor.getText({ useSalienceExtractor: true })).text,
    [
      "We use cookies on this site.",
      "Home",
      "1. | [A story title](https://example.com/story)",
      "100 points by someone",
      "A card that is one link",
      "The main content of the page.",
    ].join("\n"),
    "Table rows read as one line, and a block that is one link has no target."
  );

  is(
    (
      await actor.getText({
        useSalienceExtractor: true,
        useSimpleText: true,
        sufficientLength: 60,
      })
    ).text,
    [
      "1. | A story title",
      "A card that is one link",
      "The main content of the page.",
    ].join("\n"),
    "The main content comes first, then unmarked text, then boilerplate."
  );

  return cleanup();
});

add_task(async function test_salience_extractor_text_over_images() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <div style="position: relative; width: 400px; height: 200px">
      <canvas
        width="400"
        height="200"
        style="position: absolute; inset: 0; background: black"
      ></canvas>
      <h2 style="position: relative; color: white">A headline over an image</h2>
    </div>
    <p style="color: white">White text over nothing.</p>
    <ol>
      <li><h3>Only a headline</h3></li>
      <li><h3>Another headline</h3></li>
    </ol>
    <p style="font-size: 48px; margin: 0">1</p>
    <p>A regular paragraph to set the median font size of the page.</p>
  `;

  is(
    (
      await getPageExtractor().getText({
        useSalienceExtractor: true,
        sufficientLength: 1000,
      })
    ).text,
    [
      "## A headline over an image",
      "### Only a headline",
      "### Another headline",
      "1",
      "A regular paragraph to set the median font size of the page.",
    ].join("\n"),
    "Text over media and headline-only sections are kept, and numbers are not headings."
  );

  return cleanup();
});

add_task(async function test_salience_takes_precedence_over_reader() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <h1>Rendered content</h1>
      <p>A visible paragraph.</p>
    </main>
  `;
  const { text } = await getPageExtractor().getText({
    useSalienceExtractor: true,
    removeBoilerplate: true,
    _forceRemoveBoilerplate: true,
  });
  is(
    text,
    ["# Rendered content", "A visible paragraph."].join("\n"),
    "Salience reads the rendered document even when Reader is requested."
  );

  return cleanup();
});
