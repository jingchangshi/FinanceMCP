#!/usr/bin/env python3
"""Render the frozen investor daily report (goal-1109 §2) as deterministic
Lark/Feishu Docx XML.

Input is a plain ``sections`` object (a JSON-able dict).  It carries
already-computed facts only: this module never recomputes prices, account
values, weights or risk state, and never calls any API.  Free text in the
input selects wording only.

Output is a single deterministic XML string of native Docx blocks
(``<title>``, ``<h1>``/``<h2>``, ``<p>``/``<b>``, ``<table>``,
``<ul>``/``<li>``, ``<a>`` hyperlinks, ``<blockquote>``) suitable for
``lark-cli docs +create/+update --doc-format xml``.  No Markdown or HTML is
emitted as visible text, and no internal audit vocabulary is allowed in the
visible body (the audit JSON travels separately, never into the document).
"""

from __future__ import annotations

import html
import re
from typing import Any, Dict, List

RENDERER_VERSION = "feishu-account-v1"

# The six numbered sections frozen by goal-1109 §2, in document order.
REQUIRED_SECTIONS: List[str] = [
    "今日判断",
    "账户与风险",
    "三项主要证据",
    "持仓判断",
    "是否存在更好的选择",
    "下一交易日关注",
]

# The closing disclosures section is also mandatory (sources + disclaimer).
SOURCES_SECTION = "数据说明与参考来源"
ALL_HEADINGS: List[str] = REQUIRED_SECTIONS + [SOURCES_SECTION]

# Internal vocabulary that must never appear in the investor-facing text.
# Matched as substrings against the *visible* text only (never hrefs).
FORBIDDEN_TERMS: List[str] = [
    "DEGRADED",
    "NOT_READY",
    "NO_ACTION",
    "research_eval",
    "MCP",
    "snapshot_get",
    "report_id",
    "hash",
    "V1",
    "V2",
    "HHI",
    "implementation_fingerprint",
    "REPORT_SHA256",
    "DATA_UNAVAILABLE",
]

# Markdown leakage signatures that indicate un-rendered source text.
_MARKDOWN_PATTERNS: List[re.Pattern] = [
    re.compile(r"^\s*#{1,6}\s", re.M),
    re.compile(r"\*\*[^*]+\*\*"),
    re.compile(r"(?<!\w)__[^_]+__(?!\w)"),
    re.compile(r"`[^`]+`"),
    re.compile(r"\[[^\]]+\]\(https?://"),
    re.compile(r"```"),
]


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _section_of(sections: Dict[str, Any], name: str) -> Dict[str, Any]:
    value = (sections.get("sections") or {}).get(name)
    return value if isinstance(value, dict) else {}


def check_forbidden(visible_text: str) -> List[str]:
    return [term for term in FORBIDDEN_TERMS if term in visible_text]


_INTERNAL_TOKEN = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z]{3,}(?:_[A-Z0-9]+)+\b|\bUNVERIFIED\b")


def check_internal_tokens(visible_text: str) -> List[str]:
    """snake_case field names and UPPER_SNAKE enum values never belong in the body."""
    return sorted(set(_INTERNAL_TOKEN.findall(visible_text)))


def check_markdown_leak(visible_text: str) -> List[str]:
    leaks = []
    for pattern in _MARKDOWN_PATTERNS:
        if pattern.search(visible_text):
            leaks.append(pattern.pattern)
    return leaks


def count_hyperlinks(xml: str) -> int:
    return len(re.findall(r"<a\s+href=", xml))


def strip_tags(xml: str) -> str:
    text = re.sub(r"<[^>]+>", "", xml)
    return html.unescape(text)


def validate_sections(sections: Dict[str, Any]) -> List[str]:
    """Fail-closed validation of the structured input before rendering."""
    problems: List[str] = []
    for key in ("title", "subtitle", "account_status"):
        if not str(sections.get(key) or "").strip():
            problems.append(f"missing field: {key}")

    raw = sections.get("sections")
    if not isinstance(raw, dict):
        return problems + ["missing field: sections"]

    for name in ALL_HEADINGS:
        if name not in raw or not isinstance(raw[name], dict):
            problems.append(f"missing section: {name}")

    judgment = _section_of(sections, "今日判断")
    if not str(judgment.get("conclusion") or "").strip():
        problems.append("今日判断.conclusion is empty")
    if not str(judgment.get("max_risk") or "").strip():
        problems.append("今日判断.max_risk is empty")

    account = _section_of(sections, "账户与风险")
    metrics = account.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        problems.append("账户与风险.metrics must be a non-empty list of [label, value]")
    else:
        for row in metrics:
            if not (isinstance(row, list) and len(row) == 2):
                problems.append(f"账户与风险.metrics rows must have exactly 2 columns: {row!r}")
                break

    evidence = _section_of(sections, "三项主要证据")
    items = evidence.get("items")
    if not isinstance(items, list) or not items:
        problems.append("三项主要证据.items must be a non-empty list")
    else:
        for item in items:
            for key in ("label", "observation", "why", "missing"):
                if not str((item or {}).get(key) or "").strip():
                    problems.append(f"三项主要证据.items.{key} is empty")

    holdings = _section_of(sections, "持仓判断").get("holdings")
    if not isinstance(holdings, list) or not holdings:
        problems.append("持仓判断.holdings must be a non-empty list")
    else:
        for row in holdings:
            for key in ("symbol", "judgment", "basis"):
                if not str((row or {}).get(key) or "").strip():
                    problems.append(f"持仓判断.holdings.{key} is empty")

    conditions = _section_of(sections, "下一交易日关注").get("conditions")
    if not isinstance(conditions, list) or not conditions:
        problems.append("下一交易日关注.conditions must be a non-empty list")

    sources = _section_of(sections, SOURCES_SECTION).get("sources")
    if sources is None:
        problems.append(f"{SOURCES_SECTION}.sources is missing")
    elif not isinstance(sources, list):
        problems.append(f"{SOURCES_SECTION}.sources must be a list")
    else:
        for src in sources:
            for key in ("title", "publisher", "date", "url"):
                if not str((src or {}).get(key) or "").strip():
                    problems.append(f"{SOURCES_SECTION}.sources.{key} is empty")
            url = str((src or {}).get("url") or "")
            if url and not url.startswith("https://"):
                problems.append(f"{SOURCES_SECTION}.sources.url must be https: {url!r}")

    # Whole-input hygiene: no forbidden internal terms, no Markdown leak,
    # anywhere in the visible text (including titles and table cells).
    visible = _all_visible_text(sections)
    forbidden = check_forbidden(visible)
    if forbidden:
        problems.append(f"forbidden internal terms in visible text: {forbidden}")
    leftovers = check_internal_tokens(visible)
    if leftovers:
        problems.append(f"internal field/enum tokens in visible text: {leftovers}")
    leaks = check_markdown_leak(visible)
    if leaks:
        problems.append(f"markdown leak in visible text: {leaks}")
    return problems


def _all_visible_text(sections: Dict[str, Any]) -> str:
    """Flatten every human-visible string in the sections object."""
    parts: List[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "url":
                    continue  # href values are not visible text
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif value is not None:
            parts.append(str(value))

    for key, value in sections.items():
        if key == "url":
            continue
        walk(value)
    return "\n".join(parts)


def _table(headers: List[str], rows: List[List[str]], widths: List[int]) -> str:
    cols = "".join(f'<col width="{w}"/>' for w in widths)
    head = "".join(
        f'<th background-color="light-gray"><p><b>{_esc(c)}</b></p></th>'
        for c in headers
    )
    body = "".join(
        "<tr>" + "".join(f"<td><p>{_esc(c)}</p></td>" for c in row) + "</tr>"
        for row in rows
    )
    return (
        f"<table><colgroup>{cols}</colgroup><thead><tr>{head}</tr></thead>"
        f"<tbody>{body}</tbody></table>"
    )


def _heading(number: int, title: str) -> str:
    return f"<h1>{number}、{_esc(title)}</h1>"


def render_xml(sections: Dict[str, Any]) -> str:
    """Render the sections object to deterministic native-block XML.

    Raises ValueError listing every validation problem when the input is
    incomplete or contains forbidden/leaked text.  The caller (publisher)
    must treat this as fail-closed: no XML is emitted, nothing published.
    """
    problems = validate_sections(sections)
    if problems:
        raise ValueError("invalid sections object: " + "; ".join(problems))

    blocks: List[str] = [
        f"<title>{_esc(sections['title'])}</title>",
        f"<p>{_esc(sections['subtitle'])}</p>",
        f"<p>{_esc(sections['account_status'])}</p>",
    ]

    judgment = _section_of(sections, "今日判断")
    blocks.append(_heading(1, "今日判断"))
    blocks.append(f"<p><b>结论：</b>{_esc(judgment['conclusion'])}</p>")
    reasons = judgment.get("reasons") or []
    if reasons:
        blocks.append("<ul>" + "".join(f"<li>{_esc(r)}</li>" for r in reasons[:3]) + "</ul>")
    blocks.append(f"<p><b>最大风险：</b>{_esc(judgment['max_risk'])}</p>")
    if judgment.get("change_condition"):
        blocks.append(
            f"<p><b>什么情况会改变判断：</b>{_esc(judgment['change_condition'])}</p>"
        )
    if judgment.get("execution_note"):
        blocks.append(f"<p><b>执行说明：</b>{_esc(judgment['execution_note'])}</p>")

    account = _section_of(sections, "账户与风险")
    blocks.append(_heading(2, "账户与风险"))
    metric_rows = [[str(k), str(v)] for k, v in account["metrics"]]
    blocks.append(_table(["指标", "数值"], metric_rows, [150, 250]))
    if account.get("narrative"):
        blocks.append(f"<p>{_esc(account['narrative'])}</p>")

    evidence = _section_of(sections, "三项主要证据")
    blocks.append(_heading(3, "支撑今日结论的三项主要证据"))
    for item in evidence["items"]:
        blocks.append(f"<h2>{_esc(item['label'])}</h2>")
        blocks.append(f"<p><b>观察：</b>{_esc(item['observation'])}</p>")
        blocks.append(f"<p><b>为什么重要：</b>{_esc(item['why'])}</p>")
        blocks.append(f"<p><b>仍缺什么证据：</b>{_esc(item['missing'])}</p>")

    holdings = _section_of(sections, "持仓判断")["holdings"]
    blocks.append(_heading(4, "持仓判断"))
    holding_rows = [
        [str(h["symbol"]), str(h["judgment"]), str(h["basis"])] for h in holdings
    ]
    # Exactly three columns by construction (see §2 §四); wider layouts are
    # expressed as prose under the table, never as extra columns.
    blocks.append(
        _table(["标的与名称", "目前研究判断", "最重要依据/风险"], holding_rows, [150, 130, 250])
    )

    options = _section_of(sections, "是否存在更好的选择").get("options") or []
    blocks.append(_heading(5, "是否存在更好的选择"))
    if options:
        common = str(_section_of(sections, "是否存在更好的选择").get("common_note") or "").strip()
        if common:
            blocks.append(f"<p><b>各方案共同说明：</b>{_esc(common)}</p>")
        option_rows = [
            [str(opt["name"]), str(opt.get("upside") or ""), str(opt.get("cost") or ""), str(opt.get("gap") or "")]
            for opt in options
        ]
        blocks.append(_table(["方案", "作用", "代价与账户影响", "暂不可执行的原因"], option_rows, [90, 150, 160, 150]))
    else:
        blocks.append("<p>本日未发现有足够证据支持调整的替代方案，维持当前持仓观察。</p>")

    conditions = _section_of(sections, "下一交易日关注")["conditions"]
    blocks.append(_heading(6, "下一交易日关注"))
    blocks.append("<ul>" + "".join(f"<li>{_esc(c)}</li>" for c in conditions) + "</ul>")

    disclosed = _section_of(sections, SOURCES_SECTION)
    blocks.append(f"<h1>{_esc(SOURCES_SECTION)}</h1>")
    for note in disclosed.get("notes") or []:
        blocks.append(f"<p>{_esc(note)}</p>")
    sources = disclosed.get("sources") or []
    if sources:
        source_lines = []
        for src in sources:
            # Native text hyperlink: visible title, publisher + date in text;
            # never a bare long URL as visible content.
            source_lines.append(
                f'<li><a href="{_esc(src["url"])}">{_esc(src["title"])}</a>'
                f'（{_esc(src["publisher"])}，{_esc(src["date"])}）</li>'
            )
        blocks.append("<ul>" + "".join(source_lines) + "</ul>")
    blocks.append("<p>研究记录，不构成自动交易指令。</p>")
    return "".join(blocks)


__all__ = [
    "RENDERER_VERSION",
    "REQUIRED_SECTIONS",
    "SOURCES_SECTION",
    "ALL_HEADINGS",
    "FORBIDDEN_TERMS",
    "check_forbidden",
    "check_markdown_leak",
    "check_internal_tokens",
    "count_hyperlinks",
    "strip_tags",
    "validate_sections",
    "render_xml",
]
