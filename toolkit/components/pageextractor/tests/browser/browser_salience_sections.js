/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_nested_controls_and_content_lists() {
  const languages = '<li><a href="/language">Another language</a></li>'.repeat(
    40
  );
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <header>
        <h1>Product details</h1>
        <div>
          <button aria-haspopup="true">Languages</button>
          <ul>
            ${languages}
          </ul>
        </div>
      </header>
      <p>Battery life is eighteen hours.</p>
      <h2>Available products</h2>
      <ul>
        <li><a href="/lantern">Trail Lantern</a></li>
      </ul>
      <div role="toolbar"><button>Account settings</button></div>
    </main>
  `;
  const { text } = await getPageExtractor().getText({
    useSalienceExtractor: true,
    useSimpleText: true,
    sufficientLength: 80,
  });
  is(
    text,
    [
      "Product details",
      "Languages",
      "Battery life is eighteen hours.",
      "Available products",
      "Trail Lantern",
    ].join("\n"),
    "The header's popup language list and the toolbar rank as boilerplate, and the product list stays content."
  );

  return cleanup();
});

add_task(async function test_first_extraction_uses_computed_roles() {
  const controls = "<p>Custom toolbar control.</p>".repeat(40);
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <h1>Product</h1>
      <automatic-toolbar>${controls}</automatic-toolbar>
      <p>Battery life is eighteen hours.</p>
    </main>
    <script>
      customElements.define(
        "automatic-toolbar",
        class extends HTMLElement {
          constructor() {
            super();
            this.attachInternals().role = "toolbar";
          }
        }
      );
    </script>
  `;
  const { text } = await getPageExtractor().getText({
    useSalienceExtractor: true,
    sufficientLength: 30,
  });
  is(
    text,
    ["# Product", "Battery life is eighteen hours."].join("\n"),
    "The custom element's computed toolbar role keeps its text from crowding out content."
  );

  return cleanup();
});

add_task(async function test_primary_header_features_remain_content() {
  const prose = "<p>General information about the laptop.</p>".repeat(40);
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <header>
        <h1>Laptop</h1>
        <ul>
          <li>Battery: 18 hours</li>
        </ul>
      </header>
      <section>
        <h2>Overview</h2>
        ${prose}
      </section>
    </main>
  `;
  const { text } = await getPageExtractor().getText({
    useSalienceExtractor: true,
    sufficientLength: 100,
  });
  is(
    text,
    [
      "# Laptop",
      "Battery: 18 hours",
      "## Overview",
      "General information about the laptop.",
      "General information about the laptop.",
    ].join("\n"),
    "A header feature list without popup controls keeps content priority."
  );

  return cleanup();
});

add_task(async function test_aria_fallback_table_roles() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <h1>Specifications</h1>
      <div role="unknown table">
        <div role="unknown row">
          <div role="unknown columnheader">Feature</div>
          <div role="unknown columnheader">Value</div>
        </div>
        <div role="unknown row">
          <div role="unknown rowheader">Battery</div>
          <div role="unknown cell">18 hours</div>
        </div>
      </div>
    </main>
  `;
  const { text } = await getPageExtractor().getText({
    useSalienceExtractor: true,
    sufficientLength: 40,
    useSimpleText: true,
  });
  is(
    text,
    ["Specifications", "Feature | Value", "Battery | 18 hours"].join("\n"),
    "Fallback table roles group cells into rows and keep the column headers."
  );

  return cleanup();
});

add_task(async function test_later_sections_receive_space() {
  const introduction = "<p>Background material about the equipment.</p>".repeat(
    80
  );
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <h1>Field guide</h1>
      <section>
        <h2>Overview</h2>
        ${introduction}
      </section>
      <section>
        <h2>Safety</h2>
        <p>Call the ranger in an emergency.</p>
      </section>
    </main>
  `;
  const actor = getPageExtractor();
  const { text } = await actor.getText({
    useSalienceExtractor: true,
    sufficientLength: 160,
  });
  is(
    text,
    [
      "# Field guide",
      "## Overview",
      ...Array(3).fill("Background material about the equipment."),
      "## Safety",
      "Call the ranger in an emergency.",
    ].join("\n"),
    "A long opening section leaves room for a later section and its heading, in document order."
  );
  const full = await actor.getText({ useSalienceExtractor: true });
  is(
    full.text,
    [
      "# Field guide",
      "## Overview",
      ...Array(80).fill("Background material about the equipment."),
      "## Safety",
      "Call the ranger in an emergency.",
    ].join("\n"),
    "Full extraction imposes no section quotas."
  );

  return cleanup();
});

add_task(async function test_aria_table_and_label_context() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <p id="product">Trail Lantern</p>
      <section aria-labelledby="product">
        <div role="table">
          <div role="row">
            <div role="columnheader">Feature</div>
            <div role="columnheader">Value</div>
          </div>
          <div role="row">
            <div role="rowheader">Battery</div>
            <div role="cell">18 hours</div>
          </div>
        </div>
      </section>
      <p aria-hidden="true">Visible status.</p>
      <p hidden id="hidden-label">Hidden private text.</p>
      <section aria-labelledby="hidden-label"><p>Visible section.</p></section>
    </main>
  `;
  const actor = getPageExtractor();
  const { text } = await actor.getText({
    useSalienceExtractor: true,
    useSimpleText: true,
    sufficientLength: 40,
  });
  is(
    text,
    ["Trail Lantern", "Feature | Value", "Battery | 18 hours"].join("\n"),
    "A selected table keeps its region's visible label and its column headers."
  );
  const full = await actor.getText({ useSalienceExtractor: true });
  is(
    full.text,
    [
      "Trail Lantern",
      "Feature | Value",
      "Battery | 18 hours",
      "Visible status.",
      "Visible section.",
    ].join("\n"),
    "Visible aria-hidden text stays, and a label relationship doesn't reveal hidden text."
  );

  return cleanup();
});

add_task(async function test_viewport_budget_ignores_earlier_content() {
  const paragraphs = "<p>Earlier off-viewport content.</p>".repeat(80);
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, getPageExtractor, cleanup } = await html`
    <main>
      <div>${paragraphs}</div>
      <section id="target" style="height: 1000px">
        <p>Visible battery specification.</p>
      </section>
    </main>
  `;
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("target").scrollIntoView();
  });
  const { text } = await getPageExtractor().getText({
    useSalienceExtractor: true,
    justViewport: true,
    sufficientLength: 10,
  });
  is(
    text,
    "Visible battery specification.",
    "Off-viewport text can't use up the viewport's collection budget."
  );

  return cleanup();
});
