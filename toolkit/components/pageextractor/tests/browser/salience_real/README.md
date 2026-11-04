# Real-page salience corpus

This directory holds twelve unmodified gzip HTML snapshots from the WCXB
development split, with WCXB's reference text and required and unwanted
snippets. They came from the source checkout
`Murrough-Foley-web-content-extraction-benchmark-c039d5e`. `corpus.json`
records each case's original URL and the SHA-256 hashes of its snapshot and
source annotation. Capture dates stay null where WCXB doesn't give one.

Murrough Foley wrote WCXB and its annotations and licenses them under
CC-BY-4.0. See `WCXB-LICENSE`, <https://creativecommons.org/licenses/by/4.0/>,
and <https://github.com/Murrough-Foley/web-content-extraction-benchmark>.
The page content belongs to the publishers at the URLs in `corpus.json`, and
importing it does not relicense it as Mozilla source or CC0. The PoC adds its
own questions and copies WCXB's reference text and snippet labels unedited.

The local runner strips scripts, frames, embedded documents, base elements,
and HTTP-equivalent meta elements. It resolves anchor URLs against the source
URL and serves the page with a CSP that blocks scripts and external resources.
Inline CSS stays. The replay loses the site's rendered layout, fonts, images,
and hydration, so a missing piece of evidence can come from the replay as well
as the extractor. Don't read the results as live-site scores.

The twelve cases span seven page types. They come from the first fourteen
entries of the 200-page development pilot, minus the AliExpress and iFixit
cases, dropped after a look at their references. Treat them as an exploratory
convenience sample with no held-out split. The thirty-six questions cover
early and late evidence. The importer checks them against the references, but
nobody else has reviewed them. A matched evidence string doesn't show that a
model can bind a price or date to the right item.

To select more WCXB development IDs or change questions, edit
`tests/salience_real_cases.json` and regenerate from the checkout root:

```sh
python3 toolkit/components/pageextractor/tests/salience_import.py /path/to/wcxb
```

The importer copies the original compressed bytes and license, checks every
question's evidence against the source reference, and rebuilds `corpus.json`.
It needs no network access and no third-party Python packages. When you remove
cases, delete their `.html.gz` files from this directory too.
