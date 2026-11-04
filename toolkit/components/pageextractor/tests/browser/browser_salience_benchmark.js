/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head_salience.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_salience.js",
  this
);

add_task(async function benchmark_salience_extraction() {
  const corpusURL = getRootDirectory(gTestPath) + "salience_corpus.json";
  const corpus = await (await fetch(corpusURL)).json();

  for (const [caseIndex, page] of corpus.cases.entries()) {
    const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
    const { html: pageHTML, readySelector, ...reference } = page;
    const { tab, getPageExtractor, cleanup } = await html`${pageHTML}`;
    try {
      if (readySelector) {
        await SpecialPowers.spawn(
          tab.linkedBrowser,
          [readySelector],
          async selector => {
            await ContentTaskUtils.waitForCondition(() =>
              content.document.querySelector(selector)
            );
          }
        );
      }
      await benchmarkSaliencePage(
        corpus,
        reference,
        caseIndex,
        getPageExtractor()
      );
    } finally {
      await cleanup();
    }
  }
});
