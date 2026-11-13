#!/usr/bin/env python3
"""Renderer tests: block structure, forbidden terms, Markdown leak, tables."""

import json
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from feishu_render import (  # noqa: E402
    ALL_HEADINGS,
    FORBIDDEN_TERMS,
    check_forbidden,
    check_markdown_leak,
    count_hyperlinks,
    render_xml,
    strip_tags,
    validate_sections,
)

SAMPLE = HERE.parent / "samples" / "sections-20261106.example.json"


def load_sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


class TestRenderStructure(unittest.TestCase):
    def test_native_blocks_and_title(self):
        xml = render_xml(load_sample())
        self.assertIn("<title>A 股账户研究日报", xml)
        self.assertEqual(xml.count("<h1>"), len(ALL_HEADINGS))
        self.assertIn("<b>结论：</b>", xml)
        self.assertIn("<table>", xml)
        self.assertIn("<ul>", xml)
        self.assertIn("<li>", xml)
        for heading in ALL_HEADINGS:
            self.assertIn(heading, xml)

    def test_hyperlinks_match_sources(self):
        sections = load_sample()
        xml = render_xml(sections)
        sources = sections["sections"]["数据说明与参考来源"]["sources"]
        self.assertEqual(count_hyperlinks(xml), len(sources))
        self.assertIn('<a href="https://', xml)
        # Publisher + date shown as visible text next to the link.
        self.assertIn("示例发布主体，2026-11-06", xml)

    def test_holdings_table_has_at_most_three_columns(self):
        xml = render_xml(load_sample())
        tables = xml.split("</table>")
        holdings_table = next(t for t in tables if "标的与名称" in t)
        header_cells = holdings_table.split("<thead>")[1].split("</thead>")[0]
        self.assertEqual(header_cells.count("<th "), 3)
        self.assertEqual(holdings_table.count("<col "), 3)
        for table in tables:  # every table stays within the 3-column budget
            self.assertLessEqual(table.count("<th "), 3)

    def test_text_is_escaped(self):
        sections = load_sample()
        sections["sections"]["今日判断"]["conclusion"] = "A & B <test>"
        xml = render_xml(sections)
        self.assertIn("A &amp; B &lt;test&gt;", xml)
        self.assertNotIn("A & B <test>", xml)

    def test_deterministic_output(self):
        self.assertEqual(render_xml(load_sample()), render_xml(load_sample()))


class TestHygiene(unittest.TestCase):
    def test_no_forbidden_terms_in_output(self):
        xml = render_xml(load_sample())
        self.assertEqual(check_forbidden(strip_tags(xml)), [])

    def test_each_forbidden_term_is_rejected(self):
        for term in FORBIDDEN_TERMS:
            sections = load_sample()
            sections["sections"]["今日判断"]["conclusion"] = f"结果 {term} 已生成"
            problems = validate_sections(sections)
            self.assertTrue(
                any("forbidden" in p for p in problems),
                f"term {term!r} not rejected: {problems}",
            )

    def test_source_titles_with_short_term_substrings_are_allowed(self):
        for title in ("AV1 视频标准", "V10 车型", "V20 产品", "McMCPerson 报告", "rehash 市场回顾"):
            with self.subTest(title=title):
                sections = load_sample()
                sections["sections"]["数据说明与参考来源"]["sources"][0]["title"] = title
                self.assertEqual(validate_sections(sections), [])
                self.assertIn(title, strip_tags(render_xml(sections)))

    def test_source_titles_may_contain_standalone_short_terms(self):
        for term in ("V1", "V2", "MCP", "hash"):
            with self.subTest(term=term):
                sections = load_sample()
                sections["sections"]["数据说明与参考来源"]["sources"][0]["title"] = f"研究报告：{term}"
                self.assertEqual(validate_sections(sections), [])
                xml = render_xml(sections)
                self.assertIn(f"研究报告：{term}", strip_tags(xml))
                self.assertEqual(check_forbidden(strip_tags(xml)), [])

    def test_source_fields_other_than_title_are_not_exempt(self):
        for field in ("publisher", "date"):
            sections = load_sample()
            sections["sections"]["数据说明与参考来源"]["sources"][0][field] = "内部MCP"
            self.assertTrue(any("forbidden" in p for p in validate_sections(sections)))

    def test_short_terms_remain_forbidden_at_boundaries(self):
        for term in ("V1", "V2", "MCP", "hash"):
            for text in (term, f"内部{term}字段", f"({term})", f"{term}_value"):
                with self.subTest(text=text):
                    self.assertIn(term, check_forbidden(text))
        self.assertEqual(check_forbidden("AV1 V10 V20 xMCP MCP2 rehash hash3"), [])

    def test_internal_field_tokens_are_still_rejected(self):
        for token in ("content_hash", "custom_field", "CUSTOM_ENUM"):
            with self.subTest(token=token):
                sections = load_sample()
                sections["sections"]["数据说明与参考来源"]["sources"][0]["title"] = token
                self.assertTrue(any("internal field/enum" in p for p in validate_sections(sections)))
                with self.assertRaises(ValueError):
                    render_xml(sections)

    def test_markdown_leak_is_rejected(self):
        for leaky in (
            "# 标题",
            "结论 **加粗**",
            "见 [链接](https://example.com)",
            "代码 `x=1`",
        ):
            sections = load_sample()
            sections["sections"]["账户与风险"]["narrative"] = leaky
            problems = validate_sections(sections)
            self.assertTrue(
                any("markdown" in p for p in problems),
                f"leak not rejected: {leaky!r} -> {problems}",
            )

    def test_check_markdown_leak_detects_patterns(self):
        self.assertTrue(check_markdown_leak("# heading"))
        self.assertTrue(check_markdown_leak("some **bold** text"))
        self.assertFalse(check_markdown_leak("正常中文文本，无结构标记。"))

    def test_missing_section_is_rejected(self):
        sections = load_sample()
        del sections["sections"]["持仓判断"]
        problems = validate_sections(sections)
        self.assertTrue(any("missing section" in p for p in problems))

    def test_missing_conclusion_is_rejected(self):
        sections = load_sample()
        sections["sections"]["今日判断"]["conclusion"] = ""
        problems = validate_sections(sections)
        self.assertTrue(any("conclusion is empty" in p for p in problems))

    def test_non_https_source_url_is_rejected(self):
        sections = load_sample()
        sections["sections"]["数据说明与参考来源"]["sources"][0]["url"] = (
            "http://example.com/x"
        )
        problems = validate_sections(sections)
        self.assertTrue(any("must be https" in p for p in problems))

    def test_render_xml_raises_on_invalid_input(self):
        sections = load_sample()
        sections["sections"]["今日判断"]["max_risk"] = "  "
        with self.assertRaises(ValueError):
            render_xml(sections)

    def test_clean_sample_validates(self):
        self.assertEqual(validate_sections(load_sample()), [])


if __name__ == "__main__":
    unittest.main()
