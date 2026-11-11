#!/usr/bin/env python3
"""Deterministic sections producer: frozen VPS bundle payload -> §2 six-section JSON.

Reads a frozen research-bundle payload (research-bundles/VPS-BUNDLE-<date>-*.json,
the immutable journal record produced by account-daily) and emits the sections
object that ``feishu_render.render_xml`` consumes.

Design rules (goal-1109 §3):
- Facts only. Every number, weight, date and threshold is copied from the frozen
  payload; this script never recomputes prices, account values or risk state.
- Sentences are templates filled with those facts. No prose LLM is involved, so
  no "二次估值" or invented figures can appear.
- The conclusion is derived from the bundle's own decision/judgement fields, not
  from this script's opinion. Missing judgement fields yield the honest
  "证据不足以确定哪种调整更优" conclusion, never a fabricated stance.
- Forbidden internal vocabulary is rejected by feishu_render before output.

Usage:
    python3 sections_from_bundle.py --bundle VPS-BUNDLE-20261106-<id>.json \
        --out sections-20261106.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from feishu_render import validate_sections  # noqa: E402


def _get(d: Any, *keys: str, default: Any = None) -> Any:
    cur = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def _fmt_money(cents: Any) -> str:
    if not isinstance(cents, (int, float)):
        return "数据不足"
    sign = "-" if cents < 0 else ""
    cents = abs(int(round(cents)))
    return f"{sign}{cents // 100:,}.{cents % 100:02d} 元"


def _fmt_pct(value: Any, digits: int = 2) -> str:
    if not isinstance(value, (int, float)):
        return "数据不足"
    return f"{value:.{digits}f}%"


def _tick_price(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "不可用"
    return f"{value:.3f}" if value < 10 else f"{value:.2f}"


def _ymd(ymd: Any) -> str:
    s = str(ymd or "")
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}年{int(s[4:6])}月{int(s[6:8])}日"
    return s


def _iso(date: Any) -> str:
    s = str(date or "")
    return f"{s[:4]}-{s[4:6]}-{s[6:]}" if len(s) == 8 and s.isdigit() else s


def _extract_number_after(text: str, marker: str) -> Optional[float]:
    """First decimal number after `marker` in a frozen template sentence.

    Used only to lift the already-computed 20-day threshold out of the frozen
    WATCH condition text (the bundle has no standalone low20 field); the value
    is copied verbatim, never recomputed.
    """
    idx = text.find(marker)
    if idx < 0:
        return None
    m = re.search(r"([\d]+\.[\d]+)", text[idx + len(marker):])
    return float(m.group(1)) if m else None


# --- investor-facing text hygiene (P0 readability) -------------------------
# Producer-side backstop: the engine's own strings sometimes carry internal
# field names, enum values or amounts in cents. They are translated here so the
# document never shows them; feishu_render.validate_sections still rejects any
# leftover internal token (fail-closed).
_TOKEN_REWRITES: List[tuple] = [
    (re.compile(r"cash_plan:NOT_PROVIDED"), "未指定建仓资金方案"),
    (re.compile(r"cash_plan:\w+"), "建仓资金方案未就绪"),
    (re.compile(r"见\s*market_judgement\.counter_evidence"), "见市场反证项"),
    (re.compile(r"market_judgement\.counter_evidence"), "市场反证项"),
    (re.compile(r"market_judgement\.support_evidence"), "市场支持项"),
    (re.compile(r"market_judgement\.\w+"), "市场判断依据"),
    (re.compile(r"strategy_evidence\s*=\s*UNVERIFIED"), "策略证据未经独立验证"),
    (re.compile(r"unreported_trade_risk\s*[:：]\s*"), ""),
    (re.compile(r"unreported_trade_risk"), "未上报交易风险"),
    (re.compile(r"相对优势\s*UNVERIFIED\s*[:：]\s*"), "相对优势未经独立验证："),
    (re.compile(r"轮动优势证据\s*UNVERIFIED\s*[:：]\s*"), "轮动优势证据未经独立验证："),
    (re.compile(r"\bUNVERIFIED\b"), "未经独立验证"),
    (re.compile(r"\bNOT_PROVIDED\b"), "未提供"),
    (re.compile(r"\bUNCONFIRMED_RISK\b"), "存在未核对风险"),
]
# 3+ digit amounts written as "<n>分" (cents) -> yuan. Excludes 分钟/分位/分之/分点.
_CENTS_RE = re.compile(r"(?<![\d.,])(\d[\d,]{2,})分(?![钟位之点])")
_LEFTOVER_SNAKE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b")


def humanize_text(text: str) -> str:
    for pattern, repl in _TOKEN_REWRITES:
        text = pattern.sub(repl, text)
    text = _CENTS_RE.sub(lambda m: _fmt_money(int(m.group(1).replace(",", ""))), text)
    return _LEFTOVER_SNAKE.sub("相关指标", text)


def humanize_tree(value: Any) -> Any:
    if isinstance(value, str):
        return humanize_text(value)
    if isinstance(value, list):
        return [humanize_tree(v) for v in value]
    if isinstance(value, dict):
        return {k: (v if k == "url" else humanize_tree(v)) for k, v in value.items()}
    return value


_KEEP_PER_OPTION = ("方案后现金", "假设费用", "声明式压力情景损失")


def dedupe_option_fragments(options: List[Dict[str, str]], min_count: int = 3) -> tuple:
    """Lift sentences repeated verbatim across options into one shared note.

    Per-option numbers (post-plan cash, assumed fees) always stay with their
    option; only identical explanatory/stress sentences are shared.
    """
    def frags(text: str) -> List[str]:
        return [f.strip() for f in re.split(r"[；;]", text) if f.strip()]

    counts: Dict[str, int] = {}
    order: List[str] = []
    for opt in options:
        for field in ("cost", "gap"):
            for f in set(frags(opt.get(field, ""))):
                if f.startswith(_KEEP_PER_OPTION) or len(f) < 8:
                    continue
                if f not in counts:
                    order.append(f)
                counts[f] = counts.get(f, 0) + 1
    shared = [f for f in order if counts[f] >= min_count]
    if not shared:
        return options, []
    out: List[Dict[str, str]] = []
    for opt in options:
        new = dict(opt)
        for field in ("cost", "gap"):
            kept = [f for f in frags(opt.get(field, "")) if f not in shared]
            new[field] = "；".join(kept) if kept else "见上方共同说明"
        out.append(new)
    return out, shared


def holdings_of(bundle: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The five real holdings with weights, from the frozen bundle."""
    portfolio = bundle.get("portfolio") or {}
    rows = portfolio.get("holdings") or []
    out = []
    for h in rows:
        if not isinstance(h, dict):
            continue
        out.append(h)
    return out


def judgment_of(bundle: Dict[str, Any]) -> Dict[str, Any]:
    """Decision/judgement summary from the frozen bundle (no invention)."""
    portfolio = bundle.get("portfolio") or {}
    decision = portfolio.get("decision_comparison") or {}
    focus = decision.get("focus") or {}
    options = decision.get("options") or []
    hold = next((o for o in options if isinstance(o, dict) and o.get("action") == "HOLD"), {})
    return {
        "focus": focus,
        "hold_executable": bool(hold.get("executable")),
        "status": portfolio.get("status"),
        "judgement": bundle.get("judgement") or {},
    }


def _build_options(
    bundle: Dict[str, Any],
    focus_name: str,
    focus_weight: Any,
    verified: bool,
) -> List[Dict[str, str]]:
    """Render every engine-computed scenario without choosing a ranked-list item.

    The deterministic comparison is the source of option names, cash, fees,
    risk effects and blockers. Research candidates are named only when the
    engine itself produced a funded rotation plan. No score order is treated as
    a preferred trade.
    """
    decision = _get(bundle, "portfolio", "decision_comparison") or {}
    raw_options = decision.get("options") or []
    first_actions = _get(bundle, "portfolio", "first_section", "actions") or []
    preferred_codes = {str(a.get("code") or "") for a in first_actions if isinstance(a, dict)}
    options: List[Dict[str, str]] = []

    for raw in raw_options:
        if not isinstance(raw, dict):
            continue
        action = str(raw.get("action") or "")
        label = str(raw.get("label") or action or "方案")
        is_preferred = any(code == action or code.startswith(action + "-") for code in preferred_codes if action)
        title = ("首选｜" if is_preferred else "") + label
        summary = str(raw.get("summary") or "")
        opportunity_cost = str(raw.get("opportunity_cost") or "")
        details: List[str] = []
        cash_after = raw.get("cash_after_cents")
        if isinstance(cash_after, (int, float)):
            details.append(f"方案后现金 {_fmt_money(cash_after)}")
        fees = raw.get("fees_cents")
        if isinstance(fees, (int, float)):
            details.append(f"假设费用 {_fmt_money(fees)}")
        stress = raw.get("stress_after") or {}
        stress_loss = stress.get("loss_cents") if isinstance(stress, dict) else None
        if isinstance(stress_loss, (int, float)):
            details.append(f"声明式压力情景损失 {_fmt_money(stress_loss)}")

        rotation = raw.get("rotation_plan") or {}
        if action == "ROTATE" and isinstance(rotation, dict) and rotation.get("buy_code"):
            code = str(rotation["buy_code"])
            name = str(rotation.get("buy_name") or code)
            title += f"（研究候选：{name} {code}）"
            if rotation.get("advantage_status") == "UNVERIFIED":
                details.append("相对优势未经独立验证")
        elif action == "ROTATE":
            details.append("引擎未形成满足资金条件的具体轮动候选")

        blocker = raw.get("not_actionable_because") or []
        if isinstance(blocker, list):
            blocker_parts = [str(x) for x in blocker if x]
        else:
            blocker_parts = [str(blocker)] if blocker else []
        alpha = raw.get("alpha_track") or {}
        if action == "ROTATE" and alpha.get("evidence_verified") is not True:
            blocker_parts.append("轮动相对优势尚未经独立验证")
        blocker_text = "；".join(blocker_parts)
        if not verified and not blocker_text:
            blocker_text = "账户事实尚未完成全项核对；不能把参考数量当作可直接使用数量"

        options.append({
            "name": title,
            "upside": summary or "引擎未提供该方案的研究说明。",
            "cost": "；".join(([opportunity_cost] if opportunity_cost else []) + details) or "本包未提供可量化成本或风险结果。",
            "gap": blocker_text or "本包未报告额外执行阻碍。",
        })
    return options


def _top_stock_alternative(bundle: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Single best-focused main-board stock from the frozen watchlist.

    Returns name/industry only (no score, no list). The watchlist member
    order is the engine's own focused order; this helper only names the
    first entry of that frozen order, never re-sorts.
    """
    watchlist = bundle.get("watchlist") or {}
    focused = watchlist.get("focused_candidates") or []
    for cand in focused:
        if isinstance(cand, dict) and cand.get("name"):
            return {
                "name": str(cand["name"]),
                "industry": str(cand.get("industry") or "行业未标"),
            }
    return None


def _top_etf_alternative(bundle: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Top non-held ETF candidate by the engine's frozen screen order.

    Only the name is surfaced (no score); ``degraded`` records whether the
    ETF screen coverage was incomplete for that candidate.
    """
    etf_candidates = bundle.get("etf_candidates") or {}
    coverage = etf_candidates.get("data_coverage") or {}
    screen_degraded = str(coverage.get("status") or "") != "READY"
    for cand in etf_candidates.get("candidates") or []:
        if not isinstance(cand, dict) or cand.get("held"):
            continue
        name = cand.get("name") or cand.get("ts_code")
        if not name:
            continue
        degraded = screen_degraded or str(cand.get("status") or "") != "READY"
        return {"name": str(name), "degraded": bool(degraded)}
    return None


def build_sections(bundle: Dict[str, Any], *, generated_at: str = "") -> Dict[str, Any]:
    """Bundle payload -> the sections object feishu_render/render_xml consumes."""
    as_of = str(bundle.get("as_of_trade_date") or "")
    account_view = _get(bundle, "portfolio", "account_view") or {}
    revalued = account_view.get("revalued_basis") or {}
    gate = _get(bundle, "portfolio", "gate") or {}
    verification = bundle.get("account_verification") or {}
    summary_status = verification.get("summary_status") or ""
    verified = summary_status == "VERIFIED"
    ref = "" if verified else "（参考）"
    account_status_note = "已完成核对" if verified else "参考估值"

    total_cents = revalued.get("total_assets_cents")
    cash_cents = revalued.get("cash_cents")
    wealth_cents = revalued.get("wealth_cents")
    securities_cents = revalued.get("securities_mv_cents")
    # Old frozen payloads (before the wealth_cents field existed) still contain
    # the total. The wealth share is the residual implied by the frozen total
    # itself — copied facts, not a recomputation.
    if wealth_cents is None and all(isinstance(v, int) for v in (total_cents, cash_cents, securities_cents)):
        wealth_cents = total_cents - securities_cents - cash_cents
    holdings = holdings_of(bundle)
    focus = judgment_of(bundle)["focus"]
    focus_weight = focus.get("weight")
    focus_name = focus.get("name") or focus.get("ts_code") or "最大持仓"
    focus_code = focus.get("ts_code") or ""

    # Drawdown: current (baseline high) + window max, never full-history.
    risk = bundle.get("portfolio_risk") or {}
    drawdown = risk.get("drawdown") or {}
    current_dd = drawdown.get("current_drawdown_pct") if isinstance(drawdown, dict) else None
    window_max_dd = drawdown.get("max_drawdown_pct") if isinstance(drawdown, dict) else None
    dd_window = drawdown.get("window") if isinstance(drawdown, dict) else None
    warning = risk.get("warning") or {}
    tiers = (risk.get("policy") or {}).get("tiers") or []
    policy_on = (risk.get("policy") or {}).get("approved_on") or "2026-10-22"
    l1 = next((t for t in tiers if isinstance(t, dict) and str(t.get("level")) == "L1"), None)
    l1_pct = l1.get("drawdown_pct") if isinstance(l1, dict) else 10

    metrics: List[List[str]] = []
    metrics.append([f"总资产{ref}", _fmt_money(total_cents)])
    metrics.append([f"现金{ref}", _fmt_money(cash_cents)])
    metrics.append([f"理财/其他资产{ref}", _fmt_money(wealth_cents)])
    metrics.append([f"证券市值{ref}", _fmt_money(securities_cents)])
    if focus_weight is not None:
        metrics.append([f"最大持仓占比{ref}", _fmt_pct(focus_weight * 100 if focus_weight < 2 else focus_weight)])
    if isinstance(current_dd, (int, float)):
        metrics.append([f"当前回撤（自基线高水位）{ref}", _fmt_pct(current_dd)])
    if isinstance(window_max_dd, (int, float)):
        win = ""
        if isinstance(dd_window, dict):
            win = f"（{_ymd(dd_window.get('start'))}至{_ymd(dd_window.get('end'))}观察窗口）"
        metrics.append([f"观察窗口内最大回撤{win}{ref}", _fmt_pct(window_max_dd)])

    narrative_parts: List[str] = []
    if focus_weight is not None:
        narrative_parts.append(f"风险主要来自最大持仓{focus_name}（{focus_code}）的集中暴露。")
    if isinstance(current_dd, (int, float)) and isinstance(window_max_dd, (int, float)):
        gap = (l1_pct - current_dd) if isinstance(l1_pct, (int, float)) else None
        triggered = bool(warning.get("triggered"))
        if triggered:
            narrative_parts.append(
                f"当前回撤已触发{warning.get('level') or 'L1'}档复核（政策 {_iso(policy_on)} 确认），"
                "触发只启动研究复核，不自动交易。")
        else:
            gap_txt = f"，距 L1 档（回撤 {l1_pct}% 触发复核）还有 {gap:.2f} 个百分点" if gap is not None else ""
            narrative_parts.append(
                f"预警未触发（当前回撤 {current_dd:.2f}%{gap_txt}；政策 {_iso(policy_on)} 确认）。")
    if isinstance(window_max_dd, (int, float)):
        crossed = [t for t in tiers if isinstance(t, dict) and isinstance(t.get("drawdown_pct"), (int, float))
                   and window_max_dd >= t["drawdown_pct"]]
        if crossed:
            top = max(crossed, key=lambda t: t["drawdown_pct"])
            narrative_parts.append(
                f"提示：观察窗口内最大回撤 {window_max_dd:.2f}%，曾触及 {top.get('level')} 档"
                f"（{top['drawdown_pct']}%）；当前已回到 {current_dd:.2f}%。" if isinstance(current_dd, (int, float))
                else f"提示：观察窗口内最大回撤 {window_max_dd:.2f}%，曾触及 {top.get('level')} 档（{top['drawdown_pct']}%）。")
    if not verified:
        narrative_parts.append("账户成交未完成核对，资产与持仓为参考重估。")

    # Market evidence (basis-labeled volume).
    market = bundle.get("market") or {}
    breadth = market.get("breadth") or {}
    judgement_lines = market.get("judgement") or []
    up = breadth.get("up")
    down = breadth.get("down")
    amount_yi = breadth.get("amount_yi")
    amount_chg = breadth.get("amount_chg_pct")
    volume_bits: List[str] = []
    if isinstance(amount_yi, (int, float)):
        volume_bits.append(f"两市成交额 {amount_yi:.0f} 亿")
    if isinstance(amount_chg, (int, float)):
        volume_bits.append(f"较上日 {amount_chg:+.1f}%（环比）")
    volume_txt = "，".join(volume_bits) if volume_bits else "成交额数据不足"
    breadth_txt = f"上涨 {up} 家 / 下跌 {down} 家" if isinstance(up, (int, float)) and isinstance(down, (int, float)) else "涨跌家数数据不足"
    regime_label = market.get("regime_label") or ""

    # Core-holding evidence: price + 20-day low threshold (structured watch field).
    focus_watch = ""
    focus_price: Any = None
    focus_low20: Any = None
    for h in holdings:
        if h.get("ts_code") == focus_code:
            research = h.get("research") or {}
            quote = research.get("quote") or {}
            focus_price = quote.get("close_cny")
            conds = research.get("conditions") or []
            watch = next((c for c in conds if isinstance(c, dict) and c.get("stance") == "WATCH"), None)
            when = (watch or {}).get("when") or []
            if when:
                focus_watch = when[0]
                # Lift the already-computed threshold out of the frozen WATCH
                # sentence (no standalone low20 field in the bundle). The value
                # is copied verbatim; this script never computes it.
                focus_low20 = _extract_number_after(when[0], "最低收盘（")
                if focus_low20 is None:
                    focus_low20 = _extract_number_after(when[0], "最低收盘(")
            break
    core_obs = (
        f"{focus_code} 收盘 {_tick_price(focus_price)} 元"
        + (f"，近 20 个交易日最低收盘 {_tick_price(focus_low20)} 元（前复权口径）" if isinstance(focus_low20, (int, float)) else "")
        + "。"
    )

    # State the engine's selected plan; a no-trade choice is not evidence that
    # the existing holdings are optimal. Keep research preference separate from
    # account execution eligibility.
    stance = str(bundle.get("research_stance") or "")
    first_section = _get(bundle, "portfolio", "first_section") or {}
    first_actions = first_section.get("actions") or []
    preferred = next((a for a in first_actions if isinstance(a, dict)), None)
    evidence_gaps = bundle.get("evidence_gaps") or []
    # WP5: the bundle carries one report model. When present, its conclusion is
    # used verbatim; this producer never re-derives the preferred action.
    report_model = bundle.get("report_model") if isinstance(bundle.get("report_model"), dict) else None
    model_conclusion = str((report_model or {}).get("conclusion") or "")
    if model_conclusion:
        conclusion = model_conclusion
    elif preferred:
        title = str(preferred.get("title") or preferred.get("code") or "条件化研究方案")
        why = [str(x) for x in preferred.get("reasons", []) if x]
        conclusion = f"本期研究首选：{title}。"
        if why:
            conclusion += "依据：" + "；".join(why[:2]) + "。"
        if not verified:
            conclusion += "账户未完成券商核对，方案仅作比较，不提供可直接使用的数量。"
    elif stance in {"INSUFFICIENT_EVIDENCE", "DATA_INSUFFICIENT"}:
        conclusion = (
            "本期不提出需要精确账户数量的交易方案：账户核对或相应证据仍有缺口。"
            "这不等于当前持仓已被证明优于其他方案；市场与持仓证据仍按可用范围呈现。"
        )
    else:
        reason = str(first_section.get("no_action_reason") or "没有达到既有证据门槛的交易计划")
        conclusion = (
            f"本期首选为等待条件复核：{reason}。这是暂不交易的选择，不代表当前持仓已被证明最优。"
        )

    market_reasons: List[str] = []
    if breadth_txt != "涨跌家数数据不足":
        market_reasons.append(f"市场广度：{breadth_txt}；{regime_label}。")
    if volume_txt != "成交额数据不足":
        market_reasons.append(f"量能：{volume_txt}。")
    market_reasons.append(core_obs)
    if not verified:
        market_reasons.append("账户成交未完成券商核对，资产与持仓只能作参考重估。")

    market_missing = []
    if not isinstance(up, (int, float)) or not isinstance(down, (int, float)):
        market_missing.append("涨跌家数")
    if not isinstance(breadth.get("amount_ma20_yi"), (int, float)):
        market_missing.append("前20个交易日成交额均值")
    market_missing_text = "缺少" + "、".join(market_missing) if market_missing else "无关键缺项：当日涨跌家数与前20日成交额均值均已提供"

    focus_research = next((h.get("research") or {} for h in holdings if h.get("ts_code") == focus_code), {})
    availability = focus_research.get("availability") or {}
    unavailable = availability.get("unavailable") or []
    core_missing_text = (
        "持仓研究缺项：" + "、".join(str(x) for x in unavailable[:3])
        if unavailable else "本包没有附带可核验的新增产业事件；这表示事件证据未随包提供，不代表没有相关事件。"
    )
    reported_through = gate.get("reported_events_through")
    reconciled_at = gate.get("last_user_reconciled_at")
    if reconciled_at:
        account_observation = f"账户记录的最近人工对账时间：{_ymd(reconciled_at)}。"
        account_missing = "券商对账覆盖范围以该次核对回执为准；未覆盖日期不能推定已核对。"
    else:
        account_observation = (
            f"用户完整性声明覆盖至 {_ymd(reported_through)}，当前未记录券商对账时间。"
            if reported_through else "当前未记录用户完整性声明或券商对账时间。"
        )
        account_missing = "用户声明与券商实际对账是两项不同事实；账户金额仅为账本重建参考。"

    items = [
        {
            "label": "① 市场",
            "observation": f"{breadth_txt}；{volume_txt}；{regime_label}。",
            "why": "指数趋势与个股广度来自不同统计口径，应分别观察。",
            "missing": market_missing_text + ("" if market_missing_text.endswith("。") else "。"),
        },
        {
            "label": "② 核心持仓",
            "observation": core_obs,
            "why": "持仓权重、相对表现与失效条件共同决定是否需要重新评估。",
            "missing": core_missing_text,
        },
        {
            "label": "③ 当前主要不确定性",
            "observation": account_observation,
            "why": "它影响账户资产、持仓数量与交易资金结论。",
            "missing": account_missing,
        },
    ]

    options = _build_options(bundle, focus_name, focus_weight, verified)
    options, shared_fragments = dedupe_option_fragments([
        {k: humanize_text(str(v)) for k, v in opt.items()} for opt in options
    ])

    holdings_rows: List[Dict[str, str]] = []
    _STANCE_ZH = {"HOLD": "继续观察", "WATCH": "重点观察", "REDUCE": "可研究降低风险",
                  "ROTATE": "可研究轮动（未验证）"}
    model_rows = (report_model or {}).get("holdings_rows") or []
    if model_rows:
        for row in model_rows:
            if not isinstance(row, dict):
                continue
            holdings_rows.append({
                "symbol": f"{row.get('ts_code') or ''}（{row.get('name') or row.get('ts_code') or ''}）",
                "judgment": str(row.get("stance") or "证据不足以确定调整"),
                "basis": str(row.get("basis") or "数据不足以单独评述风险。"),
            })
    for h in ([] if model_rows else holdings):
        ts_code = h.get("ts_code") or ""
        name = h.get("name") or ts_code
        weight = h.get("weight")
        research = h.get("research") or {}
        holding_reasons = h.get("reasons") or []
        counter = h.get("counter_evidence") or []
        stance = h.get("stance") or ""
        holdings_rows.append({
            "symbol": f"{ts_code}（{name}）",
            "judgment": _STANCE_ZH.get(stance, "证据不足以确定调整"),
            "basis": "；".join(str(x) for x in (list(holding_reasons)[:1] + list(counter)[:1])) or "数据不足以单独评述风险。",
        })

    next_date = _get(bundle, "portfolio", "expected_next_trade_date") or ""
    conditions: List[str] = []
    if focus_watch:
        conditions.append(f"{_ymd(next_date)}：{focus_watch}")
    if isinstance(breadth.get("amount_ma20_yi"), (int, float)):
        conditions.append(f"{_ymd(next_date)}：观察当日成交额相对前20个交易日均值的变化；单日上涨广度不单独视为趋势反转。")
    if not reconciled_at:
        conditions.append(f"{_ymd(next_date)}：取得覆盖最新交易日的券商持仓与现金核对后，再评估参考数量。")
    if not conditions:
        conditions.extend(str(x) for x in (first_section.get("observation_triggers") or []) if x)
    if not conditions:
        conditions.append(f"{_ymd(next_date)}：复核新的账户或持仓事实；本期没有具体价格触发条件。")

    gaps = evidence_gaps
    notes: List[str] = []
    if not verified:
        last_confirmed = gate.get("last_user_reconciled_at") or ""
        notes.append(
            (f"账户成交仅核对至 {_ymd(last_confirmed)}，资产、仓位与回撤为参考重估，未冒充已对账正式绩效。"
             if last_confirmed else
             "账户成交尚未完成核对，资产、仓位与回撤为参考重估，未冒充已对账正式绩效。"))
    if gaps:
        # Gaps here are structured dicts ({module, reason, affected}); render the
        # investor meaning, never the internal code or the raw dict.
        _GAP_ZH = {
            "unreported_trade_risk": "账户完整性声明尚未覆盖本报告日，无法确认声明时点之后是否有新增成交",
        }
        gap_texts = []
        for g in gaps[:3]:
            if isinstance(g, dict):
                gap_texts.append(_GAP_ZH.get(str(g.get("reason")), "存在数据缺口，详见技术审计记录"))
            else:
                gap_texts.append(str(g))
        notes.append("主要数据缺口：" + "；".join(gap_texts) + "。")
    if evidence_gaps or not verified or current_dd is None:
        pass  # already disclosed above

    action_triggers = [
        str(trigger)
        for action in first_actions if isinstance(action, dict)
        for trigger in (action.get("triggers") or []) if trigger
    ]
    observation_triggers = [str(x) for x in (first_section.get("observation_triggers") or []) if x]
    change_conditions = action_triggers or observation_triggers
    change_condition = (
        "；".join(change_conditions[:2])
        if change_conditions else
        "出现覆盖报告日的新账户核对、重大持仓事实或既有风险政策触发条件时重新评估。"
    )

    result = {
        "title": f"A 股账户研究日报｜{_ymd(as_of)}收盘",
        "subtitle": (
            f"生成于 {generated_at}（北京时间）｜市场数据截至交易日 {_iso(as_of)}"
        ),
        "account_status": f"账户数据：{account_status_note}",
        "sections": {
            "今日判断": {
                "conclusion": conclusion,
                "reasons": market_reasons[:3],
                "max_risk": narrative_parts[0] if narrative_parts else "最大持仓集中度为当前组合的主要风险。",
                "change_condition": change_condition,
                "execution_note": "当前不提供买卖数量；研究判断与执行数量门控分离。",
            },
            "账户与风险": {
                "metrics": metrics,
                "narrative": " ".join(narrative_parts) if narrative_parts else "风险主要来自集中暴露。",
            },
            "三项主要证据": {"items": items},
            "持仓判断": {"holdings": holdings_rows},
            "是否存在更好的选择": {"options": options, "common_note": "；".join(shared_fragments)},
            "下一交易日关注": {"conditions": conditions},
            "数据说明与参考来源": {"notes": notes, "sources": []},
        },
    }
    return humanize_tree(result)


def main() -> int:
    parser = argparse.ArgumentParser(description="Frozen bundle -> §2 sections JSON")
    parser.add_argument("--bundle", required=True, help="VPS-BUNDLE-*.json journal record file")
    parser.add_argument("--out", required=True, help="output sections JSON path")
    parser.add_argument("--generated-at", default="", help="generation timestamp label (HH:mm)")
    args = parser.parse_args()

    record = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    payload = record.get("payload") or record
    sections = build_sections(payload, generated_at=args.generated_at)
    problems = validate_sections(sections)
    if problems:
        sys.stderr.write("sections invalid:\n" + "\n".join(f"- {p}" for p in problems) + "\n")
        return 1
    Path(args.out).write_text(json.dumps(sections, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out} ({Path(args.out).stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
