/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type GetTextOptions = Partial<{
  // The length of extracted text that is sufficient for the purpose.
  // When set, extraction will stop when the text meets or exceeds this length.
  // When unset, the lenghth of the extracted text is unbounded.
  sufficientLength: number;
  // Just include the viewport content.
  justViewport: boolean;
  // Skip canvases smaller than this dimension
  minCanvasSize: number;
  // Max canvases to collect
  maxCanvasCount: number;
  // Enable canvas capture
  includeCanvasSnapshots: boolean;
  // Max width/height for captured canvases
  maxCanvasDimension: number;
  // WebP quality 0-1
  canvasQuality: number;
  // Make two attempts to extract the text content. First prefer reader mode for the
  // content as it will remove boilerplate, but then fall back to the DOMExtractor.
  removeBoilerplate: boolean;
  // A test-only option for forcing this behavior.
  _forceRemoveBoilerplate: boolean;
  // The URL of the page being extracted. Used to apply custom extraction strategies for specific sites.
  sourceUrl: string;
  // Return plain prose instead of the default markdown-annotated text. Anchors
  // keep their text but lose their target, and whitespace within a block
  // collapses to single spaces. Paragraph breaks between blocks are preserved.
  useSimpleText: boolean;
}>;

export type CanvasSnapshot = {
  blob: Blob;
  width: number;
  height: number;
};

export type DOMExtractionResult = {
  text: string;
  links: string[];
  canvases: HTMLCanvasElement[];
  siteStrategy: string | null;
};

export type ExtractionResult = {
  text: string;
  links: string[];
  canvasSnapshots: CanvasSnapshot[];
};

export type ExtractionStrategy = Partial<{
  // Identifies the site-specific strategy ("google-search", "youtube"), or
  // null for the default one.
  name: string | null;
  // A CSS selector for elements to exclude from extraction.
  filterSelector: string;
  // Whether to format blocks that are inside anchors as markdown links.
  formatBlockAnchorsAsMarkdown: boolean;
  // A CSS selector for the blocks to format as markdown links. If not set, all blocks inside anchors will be formatted.
  formatBlockAnchorSelector: string;
}>;

export type PageMetadata = {
  // JSON-LD types as defined by https://schema.org/Thing
  // this is used to understand context about the content, where expected values could be things like:
  // ["Recipe", "NewsArticle"] or ["Book"] or ["Person", "Blog", "Article"]
  structuredDataTypes: string[];
  // word count of all the content on the page
  wordCount: number;
  // lang-tag of the page
  language: string;
  // whether the page is likely readable by reader mode
  isReaderable: boolean;
  // whether the page declares that its content is gated, e.g. behind a paywall
  // or a registration wall. Derived from the schema.org `isAccessibleForFree`
  // markup, so this is only ever true for pages that annotate themselves.
  isGated: boolean;
  // The SEO, social and schema.org metadata the page declares about itself.
  structuredMetadata: StructuredMetadata;
};

export type MetadataSource = "html" | "opengraph" | "twitter";

export type MetaTagEntry = {
  source: MetadataSource;
  // The lowercased name or property, e.g. "description" or "og:description".
  name: string;
  value: string;
};

export type LinkEntry = {
  rel: string;
  // Resolved against the document base URL.
  href: string;
};

// A JSON-LD value as found in a node property. Nodes are always replaced by an
// `@id` reference, and value objects keep their type and language.
export type JsonLdValue =
  | string
  | number
  | boolean
  | { "@id": string }
  | {
      "@value": string | number | boolean;
      "@type"?: string;
      "@language"?: string;
      "@direction"?: string;
    }
  | { "@list": JsonLdValue[] };

export type JsonLdNode = {
  // The `@id` resolved against the document base URL, or a "_:b<n>" blank node
  // identifier. Several nodes can share an id when a page declares the same
  // thing more than once.
  id: string;
  // The `@type` values as written, e.g. "Recipe" or "schema:Recipe".
  types: string[];
  // Every property as written, with its values in document order.
  properties: Record<string, JsonLdValue[]>;
  // Whether the node is a top-level object or `@graph` member, rather than
  // embedded in another node.
  isTopLevel: boolean;
  // The index of the JSON-LD script declaring the node.
  scriptIndex: number;
};

export type JsonLdBlock = {
  // The block's `@context`, as written.
  context: unknown;
  // "truncated" when nodes were dropped because of the size limits.
  status: "parsed" | "invalid" | "too-large" | "truncated";
};

export type StructuredMetadata = {
  // In document order, with repeated and conflicting values all kept.
  metaTags: MetaTagEntry[];
  links: LinkEntry[];
  jsonLd: {
    nodes: JsonLdNode[];
    // One per JSON-LD script, in document order.
    blocks: JsonLdBlock[];
  };
};

/**
 * Reader mode doesn't provide the types for the result. This a stub for making
 * the results easier to interpret.
 */
export interface ReaderModeDocument {
  title: string;
  byline: null | string;
  dir: "ltr" | "rtl";

  /**
   * The HTML content of the article
   */
  content: string;

  /**
   * The text content of the artice without whitespace collapsing.
   */
  textContent: string;

  /**
   * The text length of textContent.
   */
  length: number;

  /**
   * A shorter excerpt of the article.
   */
  excerpt: string;
  siteName: null | string;
  publishedTime: null | string;
  url: string;

  /**
   * The language tag, e.g. "en".
   */
  detectedLanguage: string;

  /**
   * Minutes at a slower reading pace.
   */
  readingTimeMinsSlow: number;

  /**
   * Minutes at a faster reading pace.
   */
  readingTimeMinsFast: number;
}
