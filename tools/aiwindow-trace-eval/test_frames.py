# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import tempfile
import unittest
from pathlib import Path

from frames import read_rows, sample
from scoring import response_text, source_coverage, wiki_title

HEADER = "\tPrompt\tAnswer\twikipedia_link_1\twikipedia_link_2\treasoning_types\twiki_links\n"


def span(name, kind=None, output=None, **attrs):
    attributes = dict(attrs)
    if kind:
        attributes["openinference.span.kind"] = kind
    if output is not None:
        attributes["output.value"] = json.dumps(output)
    return {
        "name": name,
        "attributes": [
            {
                "key": key,
                "value": {"boolValue": value}
                if isinstance(value, bool)
                else {"stringValue": value},
            }
            for key, value in attributes.items()
        ],
    }


class FramesTests(unittest.TestCase):
    def test_reads_tsv_with_links_and_reasoning_types(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.tsv"
            path.write_text(
                HEADER
                + "0\tWho? \tJane\thttps://en.wikipedia.org/wiki/A\t"
                + "https://en.wikipedia.org/wiki/B\tNumerical reasoning | Temporal reasoning\t"
                + "['https://en.wikipedia.org/wiki/A', 'https://evil.example/x', "
                + "'https://en.wikipedia.org/wiki/A']\n"
            )
            [row] = read_rows(path)
        self.assertEqual(row["prompt"], "Who?")
        self.assertEqual(row["links"], ["https://en.wikipedia.org/wiki/A"])
        self.assertEqual(
            row["reasoningTypes"], ["Numerical reasoning", "Temporal reasoning"]
        )

    def test_sample_is_deterministic_and_covers_types(self):
        rows = [
            {"index": index, "reasoningTypes": [kind]}
            for index, kind in enumerate(["a"] * 6 + ["b"] * 2 + ["c"])
        ]
        first = sample(rows, 3, 0, [])
        self.assertEqual(first, sample(rows, 3, 0, []))
        self.assertEqual(
            sorted(row["reasoningTypes"][0] for row in first), ["a", "b", "c"]
        )

    def test_pinned_and_live_urls_name_the_same_article(self):
        self.assertEqual(
            wiki_title(
                "https://en.wikipedia.org/w/index.php?title=Charlotte_Bront%C3%AB&oldid=1"
            ),
            wiki_title("https://en.wikipedia.org/wiki/Charlotte Brontë"),
        )
        self.assertIsNone(wiki_title("https://example.com/wiki/A"))

    def test_source_coverage_counts_only_successful_reads(self):
        gold = [
            {"url": "https://en.wikipedia.org/w/index.php?title=A&oldid=1"},
            {"url": "https://en.wikipedia.org/w/index.php?title=B&oldid=2"},
        ]
        trace = [
            span(
                "get_page_content",
                "TOOL",
                **{"gen_ai.tool.name": "get_page_content"},
                **{"smartwindow.tool.executed": True},
            ),
            span(
                "get_page_content.read",
                "CHAIN",
                {"url": "https://en.wikipedia.org/wiki/A", "ok": True, "content": "x"},
            ),
            span(
                "get_page_content.read",
                "CHAIN",
                {"url": "https://en.wikipedia.org/wiki/B", "ok": False, "content": ""},
            ),
        ]
        score = source_coverage(gold, trace)
        self.assertEqual(score["score"], 0.5)
        self.assertIn('"get_page_content": 1', score["explanation"])

    def test_response_text_reads_message_body(self):
        root = span("smartwindow.turn", output={"type": "text", "body": "Jane"})
        self.assertEqual(response_text(root), "Jane")
        self.assertEqual(response_text(span("smartwindow.turn")), "")


if __name__ == "__main__":
    unittest.main()
