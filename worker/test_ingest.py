"""Pure chapter regression tests; no OCR or database dependencies."""
import unittest

from ingest import _build_drafts_from_starts, _split_into_chapters


class ChapterTests(unittest.TestCase):
    def test_merge_rebases_page_map_and_preserves_front_matter(self):
        quote = "Mitochondria produce ATP through oxidative phosphorylation for cell energy."
        lines = [
            {"text": "Front matter must remain readable.", "page": 1},
            {"text": "Chapter 1 Alpha", "page": 1},
            {"text": "Long chapter content. " * 25, "page": 1},
            {"text": "Chapter 2 Beta", "page": 2},
            {"text": quote, "page": 2},
            {"text": "Chapter 3 Gamma", "page": 3},
            {"text": "Another long chapter. " * 25, "page": 3},
        ]
        chapters = _split_into_chapters(lines)
        self.assertEqual(len(chapters), 2)
        first = chapters[0]
        self.assertIn("Front matter", first["content"])
        self.assertEqual(first["last_page"], 2)
        page_two = next(mark for mark in first["page_map"] if mark["page"] == 2)
        self.assertTrue(first["content"][page_two["char_start"]:].startswith("Chapter 2"))
        self.assertGreaterEqual(first["content"].index(quote), page_two["char_start"])

    def test_chapter_limit_retains_tail_pages(self):
        lines = [{"text": f"Unique page {i} " + "source " * 30, "page": i} for i in range(1, 126)]
        chapters = _build_drafts_from_starts(lines, [(f"Section {i}", i) for i in range(1, 126)])
        self.assertEqual(len(chapters), 120)
        self.assertEqual(chapters[-1]["last_page"], 125)
        self.assertIn("Unique page 125", chapters[-1]["content"])


if __name__ == "__main__":
    unittest.main()
