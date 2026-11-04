/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head_salience.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_salience.js",
  this
);

add_task(async function benchmark_real_salience_pages() {
  requestLongerTimeout(5);
  const root = getRootDirectory(gTestPath) + "salience_real/";
  const corpusDir = Services.prefs.getStringPref(
    "browser.pageextractor.salience.corpusDir",
    ""
  );
  const readSnapshot = async file =>
    corpusDir
      ? (await IOUtils.read(PathUtils.join(corpusDir, file))).buffer
      : (await fetch(root + file)).arrayBuffer();
  const corpus = corpusDir
    ? await IOUtils.readJSON(PathUtils.join(corpusDir, "corpus.json"))
    : await (await fetch(root + "corpus.json")).json();
  const { HttpServer } = ChromeUtils.importESModule(
    "resource://testing-common/httpd.sys.mjs"
  );
  const server = new HttpServer();
  let markup = "";
  server.registerPathHandler("/page.html", (_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      false
    );
    const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
      Ci.nsIStringInputStream
    );
    stream.setUTF8Data(markup);
    response.bodyOutputStream.writeFrom(stream, stream.available());
  });
  server.start(-1);
  try {
    for (const [caseIndex, page] of corpus.cases.entries()) {
      const compressed = await readSnapshot(page.htmlFile);
      const digest = await crypto.subtle.digest("SHA-256", compressed);
      is(
        Array.from(new Uint8Array(digest), byte =>
          byte.toString(16).padStart(2, "0")
        ).join(""),
        page.sha256,
        `${page.id}: The original snapshot matches its recorded hash.`
      );
      const stream = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      const snapshot = new DOMParser().parseFromString(
        await new Response(stream).text(),
        "text/html"
      );
      for (const node of snapshot.querySelectorAll(
        "script, iframe, object, embed, base, meta[http-equiv]"
      )) {
        node.remove();
      }
      for (const anchor of snapshot.querySelectorAll("a[href]")) {
        try {
          anchor.href = new URL(
            anchor.getAttribute("href"),
            page.sourceUrl
          ).href;
        } catch {
          // Preserve invalid links as they appeared in the snapshot.
        }
      }
      markup = "<!doctype html>" + snapshot.documentElement.outerHTML;
      const tab = await BrowserTestUtils.openNewForegroundTab(
        gBrowser,
        `http://127.0.0.1:${server.identity.primaryPort}/page.html?case=${page.id}`
      );
      try {
        const { title, ...viewport } = await SpecialPowers.spawn(
          tab.linkedBrowser,
          [],
          () => ({
            title: content.document.title,
            width: content.innerWidth,
            height: content.innerHeight,
          })
        );
        is(
          title,
          snapshot.title,
          `${page.id}: Replay preserves the page title.`
        );
        const actor =
          tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
            "PageExtractor"
          );
        await benchmarkSaliencePage(corpus, page, caseIndex, actor, viewport);
        const baselineModule = Services.prefs.getStringPref(
          "browser.pageextractor.salience.baselineModule",
          ""
        );
        if (baselineModule) {
          const paired = await SpecialPowers.spawn(
            tab.linkedBrowser,
            [baselineModule, page.sourceUrl],
            async (baselineURL, sourceUrl) => {
              const resource = Services.io
                .getProtocolHandler("resource")
                .QueryInterface(Ci.nsIResProtocolHandler);
              const uri = Services.io.newURI(baselineURL);
              let before;
              if (uri.scheme === "file") {
                resource.setSubstitution(
                  "salience-baseline",
                  Services.io.newURI(".", null, uri)
                );
                try {
                  before = ChromeUtils.importESModule(
                    "resource://salience-baseline/" +
                      uri.QueryInterface(Ci.nsIURL).fileName
                  ).extractSalientText;
                } finally {
                  resource.setSubstitution("salience-baseline", null);
                }
              } else {
                before =
                  ChromeUtils.importESModule(baselineURL).extractSalientText;
              }
              const after = ChromeUtils.importESModule(
                "moz-src:///toolkit/components/pageextractor/SalienceExtractor.sys.mjs"
              ).extractSalientText;
              const results = [];
              for (const sufficientLength of [1000, 10000, null]) {
                const options = {
                  useSimpleText: true,
                  sourceUrl,
                  ...(sufficientLength === null ? {} : { sufficientLength }),
                };
                const variants = [before, after];
                for (const extract of variants) {
                  await extract(
                    content.document,
                    content.document.body,
                    options
                  );
                }
                const times = [[], []];
                const texts = ["", ""];
                for (let repeat = 0; repeat < 9; repeat++) {
                  for (const index of repeat % 2 ? [1, 0] : [0, 1]) {
                    const start = ChromeUtils.now();
                    const result = await variants[index](
                      content.document,
                      content.document.body,
                      options
                    );
                    times[index].push(ChromeUtils.now() - start);
                    texts[index] = result.text;
                  }
                }
                results.push({
                  sufficientLength,
                  before: times[0],
                  after: times[1],
                  texts,
                });
              }
              return results;
            }
          );
          info(
            "SALIENCE_PAIRED_BENCHMARK " +
              JSON.stringify({
                id: page.id,
                baselineModule,
                results: paired,
              })
          );
        }
      } finally {
        BrowserTestUtils.removeTab(tab);
      }
    }
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});
