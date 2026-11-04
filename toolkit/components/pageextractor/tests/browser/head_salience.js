/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function benchmarkSaliencePage(corpus, page, caseIndex, actor, viewport) {
  const modes = {
    dom: { removeBoilerplate: false },
    reader: { removeBoilerplate: true },
    salience: { useSalienceExtractor: true },
  };
  const sufficientLengths = corpus.sufficientLengths ?? [null, 1000];
  const outputs = [];
  for (const sufficientLength of sufficientLengths) {
    const names = Object.keys(modes);
    const order = names
      .slice(caseIndex % names.length)
      .concat(names.slice(0, caseIndex % names.length));
    for (const mode of order) {
      const options = {
        ...modes[mode],
        useSimpleText: true,
        ...(page.sourceUrl ? { sourceUrl: page.sourceUrl } : {}),
        ...(sufficientLength === null ? {} : { sufficientLength }),
      };
      const warmupStart = ChromeUtils.now();
      let error = null;
      const getText = () =>
        actor.getText(options).catch(e => {
          error = String(e);
          return { text: "" };
        });
      await getText();
      const warmupMs = ChromeUtils.now() - warmupStart;
      const times = [];
      let result;
      for (let repeat = 0; repeat < 3; repeat++) {
        const start = ChromeUtils.now();
        result = await getText();
        times.push(ChromeUtils.now() - start);
      }
      if (mode === "salience") {
        Assert.strictEqual(
          error,
          null,
          `${page.id}: Salience at ${sufficientLength} extracts without an error.`
        );
      }
      if (mode === "salience" && corpus.assertEvidence !== false) {
        const normalize = text => text.toLowerCase().replaceAll(/\s+/g, " ");
        const text = normalize(result.text);
        for (const { question, evidence } of page.qa) {
          ok(
            evidence.every(part => text.includes(normalize(part))),
            `${page.id}: Salience at ${sufficientLength} keeps evidence for "${question}".`
          );
        }
      }
      outputs.push({
        mode,
        sufficientLength,
        options,
        times,
        warmup_ms: warmupMs,
        text: result.text,
        error,
      });
    }
  }
  info(
    "SALIENCE_BENCHMARK " +
      JSON.stringify({
        schemaVersion: 2,
        corpus: corpus.id ?? "authored",
        condition: corpus.condition ?? "Authored rendered fixtures",
        dataset: corpus.dataset,
        datasetUrl: corpus.datasetUrl,
        sourceSnapshot: corpus.sourceSnapshot,
        caseCount: corpus.cases.length,
        sufficientLengths,
        reference: page,
        viewport,
        outputs,
        firefox: {
          version: Services.appinfo.version,
          buildID: Services.appinfo.appBuildID,
          platform: Services.appinfo.OS,
        },
      })
  );
}
