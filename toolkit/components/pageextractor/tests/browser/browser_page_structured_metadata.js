/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * @import { PageExtractorParent } from "../../PageExtractorParent.sys.mjs"
 */

// SEO and social tags

add_task(async function test_meta_tags_keep_source_and_conflicts() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { url, getPageExtractor, cleanup } = await html`
    <meta name="viewport" content="width=device-width" />
    <meta name="csrf-token" content="secret-token" />
    <meta name="description" content="HTML description" />
    <meta name="Keywords" content="soup, winter" />
    <meta property="og:description" content="Open Graph description" />
    <meta property="og:image" content="https://example.com/first.jpg" />
    <meta property="og:image" content="https://example.com/second.jpg" />
    <meta property="article:published_time" content="2026-10-05" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta property="twitter:description" content="Twitter description" />
    <meta property="og:title" content="" />
    <meta property="og:site_name" name="twitter:site" content="@example" />
    <link rel="canonical" href="/canonical-page" />
    <link rel="stylesheet" href="/style.css" />
    <p>Soup.</p>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();

  Assert.deepEqual(
    structuredMetadata.metaTags,
    [
      { source: "html", name: "description", value: "HTML description" },
      { source: "html", name: "keywords", value: "soup, winter" },
      {
        source: "opengraph",
        name: "og:description",
        value: "Open Graph description",
      },
      {
        source: "opengraph",
        name: "og:image",
        value: "https://example.com/first.jpg",
      },
      {
        source: "opengraph",
        name: "og:image",
        value: "https://example.com/second.jpg",
      },
      {
        source: "opengraph",
        name: "article:published_time",
        value: "2026-10-05",
      },
      { source: "twitter", name: "twitter:card", value: "summary_large_image" },
      {
        source: "twitter",
        name: "twitter:description",
        value: "Twitter description",
      },
      { source: "opengraph", name: "og:site_name", value: "@example" },
      { source: "twitter", name: "twitter:site", value: "@example" },
    ],
    "SEO and social tags keep their source, order, repeats and conflicts, " +
      "while unrelated and empty tags are left out."
  );

  Assert.deepEqual(
    structuredMetadata.links,
    [{ rel: "canonical", href: new URL("/canonical-page", url).href }],
    "The canonical link is resolved against the document, other links are left out."
  );

  return cleanup();
});

add_task(async function test_no_metadata() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <p>A page with no metadata.</p>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();

  Assert.deepEqual(
    structuredMetadata,
    {
      metaTags: [],
      links: [],
      structuredData: { nodes: [], jsonLdBlocks: [] },
    },
    "A page without metadata produces empty collections."
  );

  return cleanup();
});

// JSON-LD

add_task(async function test_json_ld_graph_with_references() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { url, getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            "@id": "#org",
            "name": "Example Co"
          },
          {
            "@type": ["WebPage", "ItemPage"],
            "@id": "https://example.com/page",
            "publisher": { "@id": "#org" },
            "keywords": ["a", "b"],
            "mainEntity": {
              "@type": "VideoGame",
              "gamePlatform": ["PC", "Switch"],
              "author": { "@type": "Person", "name": "Ada" },
              "numberOfPlayers": { "minValue": 1, "maxValue": 4 }
            }
          }
        ]
      }
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();
  const orgId = new URL("#org", url).href;

  Assert.deepEqual(
    structuredMetadata.structuredData,
    {
      jsonLdBlocks: [{ context: "https://schema.org", status: "parsed" }],
      nodes: [
        {
          id: orgId,
          types: ["Organization"],
          properties: { name: ["Example Co"] },
          isTopLevel: true,
          syntax: "json-ld",
          blockIndex: 0,
        },
        {
          id: "https://example.com/page",
          types: ["WebPage", "ItemPage"],
          properties: {
            publisher: [{ "@id": orgId }],
            keywords: ["a", "b"],
            mainEntity: [{ "@id": "_:b0" }],
          },
          isTopLevel: true,
          syntax: "json-ld",
          blockIndex: 0,
        },
        {
          id: "_:b0",
          types: ["VideoGame"],
          properties: {
            gamePlatform: ["PC", "Switch"],
            author: [{ "@id": "_:b1" }],
            numberOfPlayers: [{ "@id": "_:b2" }],
          },
          isTopLevel: false,
          syntax: "json-ld",
          blockIndex: 0,
        },
        {
          id: "_:b1",
          types: ["Person"],
          properties: { name: ["Ada"] },
          isTopLevel: false,
          syntax: "json-ld",
          blockIndex: 0,
        },
        {
          id: "_:b2",
          types: [],
          properties: { minValue: [1], maxValue: [4] },
          isTopLevel: false,
          syntax: "json-ld",
          blockIndex: 0,
        },
      ],
    },
    "Nodes of any type are flattened with all their properties, and nested " +
      "objects and @id links become references."
  );

  return cleanup();
});

add_task(async function test_json_ld_conflicts_are_not_merged() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "@id": "https://example.com/p",
        "name": "First name"
      }
    </script>
    <script type="application/ld+json">
      [
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "@id": "https://example.com/p",
          "name": "Second name"
        }
      ]
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();

  Assert.deepEqual(
    structuredMetadata.structuredData.nodes.map(node => [
      node.id,
      node.properties.name,
      node.blockIndex,
    ]),
    [
      ["https://example.com/p", ["First name"], 0],
      ["https://example.com/p", ["Second name"], 1],
    ],
    "Two declarations of the same node stay separate, each with its script."
  );

  return cleanup();
});

add_task(async function test_json_ld_blank_nodes_are_scoped_per_script() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@type": "Recipe",
        "@id": "_:shared",
        "recipeYield": "4"
      }
    </script>
    <script type="application/ld+json">
      {
        "@type": "Review",
        "itemReviewed": { "@id": "_:shared" }
      }
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();
  const [recipe, review] = structuredMetadata.structuredData.nodes;

  is(recipe.id, "_:b0", "Labelled blank nodes are relabelled.");
  is(review.id, "_:b1", "Unlabelled nodes get the next blank node.");
  Assert.deepEqual(
    review.properties.itemReviewed,
    [{ "@id": "_:b2" }],
    "A blank node label only links nodes within one script."
  );

  return cleanup();
});

add_task(async function test_json_ld_values() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@type": "Recipe",
        "name": { "@value": "Soupe", "@language": "fr", "@direction": "ltr" },
        "alternateName": { "@value": { "not": "a literal" } },
        "datePublished": { "@value": "2026-10-05", "@type": "Date" },
        "recipeInstructions": {
          "@list": [
            "Chop",
            { "@type": "HowToStep", "text": "Boil" },
            ["Serve", "Eat"]
          ]
        },
        "recipeCategory": [["Soup"], { "@set": ["Dinner"] }],
        "nutrition": null,
        "isFamilyFriendly": true,
        "__proto__": "data"
      }
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();
  const [recipe, step] = structuredMetadata.structuredData.nodes;

  Assert.deepEqual(
    recipe.properties.name,
    [{ "@value": "Soupe", "@language": "fr", "@direction": "ltr" }],
    "Value objects keep their language and direction."
  );
  Assert.deepEqual(
    recipe.properties.datePublished,
    [{ "@value": "2026-10-05", "@type": "Date" }],
    "Value objects keep their type."
  );
  Assert.deepEqual(
    recipe.properties.recipeInstructions,
    [{ "@list": ["Chop", { "@id": step.id }, { "@list": ["Serve", "Eat"] }] }],
    "Ordered lists keep their order, link to their nodes, and nest."
  );
  Assert.deepEqual(step.types, ["HowToStep"], "List members become nodes.");
  Assert.deepEqual(
    recipe.properties.recipeCategory,
    ["Soup", "Dinner"],
    "Nested arrays and sets are flattened."
  );
  ok(
    !Object.hasOwn(recipe.properties, "nutrition"),
    "Null values are dropped."
  );
  ok(
    !Object.hasOwn(recipe.properties, "alternateName"),
    "Value objects without a literal value are dropped."
  );
  Assert.deepEqual(
    recipe.properties.isFamilyFriendly,
    [true],
    "Booleans are kept as booleans."
  );
  Assert.deepEqual(
    Object.getOwnPropertyDescriptor(recipe.properties, "__proto__")?.value,
    ["data"],
    "A __proto__ property is kept as data."
  );

  return cleanup();
});

add_task(async function test_json_ld_invalid_blocks_do_not_block_others() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      { this is not valid json }
    </script>
    <script type="application/ld+json">
      "just a string"
    </script>
    <script type="application/ld+json"></script>
    <script type="APPLICATION/LD+JSON">
      { "@context": "https://schema.org/", "@type": "Product" }
    </script>
    <p>one two three</p>
  `;

  const { structuredMetadata, structuredDataTypes, wordCount } =
    await getPageExtractor().getPageMetadata();

  Assert.deepEqual(
    structuredMetadata.structuredData.jsonLdBlocks,
    [
      { context: null, status: "invalid" },
      { context: null, status: "invalid" },
      { context: null, status: "invalid" },
      { context: "https://schema.org/", status: "parsed" },
    ],
    "Each block reports whether it could be read."
  );
  Assert.deepEqual(
    structuredMetadata.structuredData.nodes.map(node => node.types),
    [["Product"]],
    "Valid blocks are read after invalid ones."
  );
  ok(
    structuredMetadata.structuredData.jsonLdBlocks
      .slice(0, 3)
      .every(b => b.context === null),
    "Unreadable blocks have a null context."
  );
  Assert.deepEqual(
    structuredDataTypes,
    ["Product"],
    "The types come from the readable block."
  );
  is(wordCount, 3, "The rest of the metadata is unaffected.");

  return cleanup();
});

add_task(async function test_json_ld_node_limit() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const graph = JSON.stringify({
    "@graph": Array.from({ length: 1500 }, (_, i) => ({
      "@type": "ListItem",
      position: i,
    })),
  });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${graph}
    </script>
    <script type="application/ld+json">
      { "@type": "Product" }
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();

  is(
    structuredMetadata.structuredData.nodes.length,
    1000,
    "The number of nodes is capped."
  );
  Assert.deepEqual(
    structuredMetadata.structuredData.jsonLdBlocks.map(block => block.status),
    ["truncated", "truncated"],
    "Blocks cut short by the cap are reported."
  );

  return cleanup();
});

add_task(async function test_json_ld_depth_limit() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const depth = 5000;
  const nested =
    '{ "@type": "Thing", "hasPart": '.repeat(depth) +
    '{ "@type": "Thing" }' +
    "}".repeat(depth);
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${nested}
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();

  is(
    structuredMetadata.structuredData.jsonLdBlocks[0].status,
    "truncated",
    "Deeply nested data is cut short instead of failing."
  );
  Assert.less(
    structuredMetadata.structuredData.nodes.length,
    100,
    "Nodes past the depth limit are dropped."
  );

  return cleanup();
});

// Rules built on the parsed nodes

add_task(async function test_is_gated_follows_has_part_reference() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "NewsArticle", "hasPart": { "@id": "#paywall" } },
          {
            "@type": "WebPageElement",
            "@id": "#paywall",
            "isAccessibleForFree": "False"
          }
        ]
      }
    </script>
  `;

  const { isGated } = await getPageExtractor().getPageMetadata();

  ok(isGated, "A hasPart linked by @id is followed when checking gating.");

  return cleanup();
});

add_task(async function test_json_ld_schema_org_keyword_aliases() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "type": "Recipe",
        "id": "https://example.com/soup",
        "name": "Soup"
      }
    </script>
    <script type="application/ld+json">
      { "type": "Recipe", "name": "Not schema.org" }
    </script>
  `;

  const { structuredMetadata, structuredDataTypes } =
    await getPageExtractor().getPageMetadata();
  const [soup, other] = structuredMetadata.structuredData.nodes;

  Assert.deepEqual(
    [soup.id, soup.types, soup.properties],
    ["https://example.com/soup", ["Recipe"], { name: ["Soup"] }],
    "The schema.org context's id and type aliases are honored."
  );
  Assert.deepEqual(
    [other.types, Object.keys(other.properties)],
    [[], ["type", "name"]],
    "Without the schema.org context, type is an ordinary property."
  );
  Assert.deepEqual(
    structuredDataTypes,
    ["Recipe"],
    "Aliased types are reported."
  );

  return cleanup();
});

add_task(async function test_json_ld_context_features() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      {
        "@context": [
          "https://schema.org",
          {
            "@base": "https://example.com/recipes/",
            "kind": "@type",
            "labels": "@nest"
          }
        ],
        "@id": "soup",
        "kind": "Recipe",
        "labels": { "name": "Soup" },
        "@reverse": { "hasPart": { "@id": "book" } },
        "@included": [{ "@id": "chef", "kind": "Person" }],
        "subjectOf": {
          "@id": "reviews",
          "@graph": [{ "kind": "Review", "reviewBody": "Good" }]
        }
      }
    </script>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();
  const base = "https://example.com/recipes/";

  Assert.deepEqual(
    structuredMetadata.structuredData.nodes,
    [
      {
        id: `${base}soup`,
        types: ["Recipe"],
        properties: {
          name: ["Soup"],
          subjectOf: [{ "@id": `${base}reviews` }],
        },
        isTopLevel: true,
        syntax: "json-ld",
        blockIndex: 0,
      },
      {
        id: "_:b0",
        types: ["Review"],
        properties: { reviewBody: ["Good"] },
        isTopLevel: false,
        syntax: "json-ld",
        blockIndex: 0,
      },
      {
        id: `${base}book`,
        types: [],
        properties: { hasPart: [{ "@id": `${base}soup` }] },
        isTopLevel: false,
        syntax: "json-ld",
        blockIndex: 0,
      },
      {
        id: `${base}chef`,
        types: ["Person"],
        properties: {},
        isTopLevel: true,
        syntax: "json-ld",
        blockIndex: 0,
      },
    ],
    "Inline aliases, @base, @nest, embedded graphs, @reverse and @included " +
      "are all read."
  );

  return cleanup();
});

add_task(async function test_microdata() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { url, getPageExtractor, cleanup } = await html`
    <div
      itemscope
      itemtype="https://schema.org/Product"
      itemid="/products/kettle"
      itemref="extra"
    >
      <span itemprop="name">Kettle</span>
      <img itemprop="image" src="/kettle.jpg" />
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="price" content="25.00" />
        <link itemprop="availability" href="https://schema.org/InStock" />
      </div>
      <time itemprop="releaseDate" datetime="2026-01-01">January</time>
    </div>
    <p id="extra" itemprop="description category">A kettle</p>
  `;

  const { structuredMetadata, structuredDataTypes } =
    await getPageExtractor().getPageMetadata();

  Assert.deepEqual(
    structuredMetadata.structuredData.nodes,
    [
      {
        id: new URL("/products/kettle", url).href,
        types: ["https://schema.org/Product"],
        properties: {
          name: ["Kettle"],
          image: [new URL("/kettle.jpg", url).href],
          offers: [{ "@id": "_:b0" }],
          releaseDate: ["2026-01-01"],
          description: ["A kettle"],
          category: ["A kettle"],
        },
        isTopLevel: true,
        syntax: "microdata",
        blockIndex: null,
      },
      {
        id: "_:b0",
        types: ["https://schema.org/Offer"],
        properties: {
          price: ["25.00"],
          availability: ["https://schema.org/InStock"],
        },
        isTopLevel: false,
        syntax: "microdata",
        blockIndex: null,
      },
    ],
    "Microdata items, nested items and itemref properties become nodes."
  );
  Assert.deepEqual(
    structuredDataTypes,
    [],
    "structuredDataTypes still only reports JSON-LD types."
  );

  return cleanup();
});

add_task(async function test_microdata_itemref_cycle() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <div itemscope>
      <div id="c" itemprop="first" itemscope itemref="d"></div>
    </div>
    <div id="d" itemprop="second" itemscope itemref="c"></div>
  `;

  const { structuredMetadata } = await getPageExtractor().getPageMetadata();

  Assert.deepEqual(
    structuredMetadata.structuredData.nodes.map(node => [
      node.id,
      node.properties,
    ]),
    [
      ["_:b0", { first: [{ "@id": "_:b1" }] }],
      ["_:b1", { second: [{ "@id": "_:b2" }] }],
      ["_:b2", { first: [{ "@id": "_:b1" }] }],
    ],
    "Items that refer to each other link back instead of looping."
  );

  return cleanup();
});
