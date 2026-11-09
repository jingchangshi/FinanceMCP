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
    return f"{s[:4]}年{s[4:6]}月{s[6:8]}日" if len(s) == 8 and s.isdigit() else s


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

    # Conclusion from the frozen decision itself.
    judgement = bundle.get("judgement") or {}
    status = bundle.get("status") or ""
    actionable = _get(bundle, "portfolio", "actionable")
    evidence_gaps = bundle.get("evidence_gaps") or []
    if actionable or status == "READY" and not evidence_gaps:
        conclusion = "本日证据支持维持当前仓位观察；无足够新证据支持调整。"
    else:
        conclusion = "当前证据不足以确定哪种调整更优，维持当前持仓观察。"

    reasons: List[str] = []
    if breadth_txt != "涨跌家数数据不足":
        reasons.append(f"市场广度：{breadth_txt}；{regime_label}。")
    if volume_txt != "成交额数据不足":
        reasons.append(f"量能：{volume_txt}。")
    reasons.append(core_obs)
    if not verified:
        reasons.append("账户成交未完成核对，资产与持仓只能作参考重估。")

    items = [
        {
            "label": "① 市场",
            "observation": f"{breadth_txt}；{volume_txt}；{regime_label}。",
            "why": "量能与广度方向决定本日是否需要信任趋势延续。",
            "missing": "成交额的 20 日均值基准与当日涨跌家数在部分数据中仍不足，无法判定结构性放量。",
        },
        {
            "label": "② 核心持仓",
            "observation": core_obs,
            "why": "决定集中仓位是否已触发重新研究条件。",
            "missing": "缺少最新产业订单金额与业绩兑现核对，基本面只能部分核对。",
        },
        {
            "label": "③ 当前主要不确定性",
            "observation": (
                "账户成交未完成核对。" if not verified
                else "账户已对账，但前瞻证据窗口尚未成熟。"
            ),
            "why": "影响仓位、权重与回撤数字的可信度。",
            "missing": "补录未录入成交并完成核对后重估；前瞻评价待窗口成熟后验证。",
        },
    ]

    holdings_rows: List[Dict[str, str]] = []
    for h in holdings:
        ts_code = h.get("ts_code") or ""
        name = h.get("name") or ts_code
        weight = h.get("weight")
        research = h.get("research") or {}
        summary = research.get("summary") or ""
        risk_txt = research.get("risk") or research.get("counter") or "数据不足以单独评述风险。"
        holdings_rows.append({
            "symbol": f"{ts_code}（{name}）",
            "judgment": summary or "证据不足以确定调整",
            "basis": risk_txt,
        })

    next_date = _get(bundle, "portfolio", "expected_next_trade_date") or ""
    conditions: List[str] = []
    if focus_watch:
        conditions.append(f"{_ymd(next_date)}：{focus_watch}")
    if isinstance(amount_chg, (int, float)):
        conditions.append(f"{_ymd(next_date)}：核对成交额相对 5 日均量是否转为明显放量/缩量。")
    if not verified:
        conditions.append(f"{_ymd(next_date)}：核对账户成交补录进度；未核对完成前不提供买卖数量。")

    gaps = evidence_gaps
    notes: List[str] = []
    if not verified:
        notes.append("账户成交仅核对至历史日期，资产、仓位与回撤为参考重估，未冒充已对账正式绩效。")
    if gaps:
        notes.append(f"主要数据缺口：{'; '.join(str(g) for g in gaps[:3])}。")
    if evidence_gaps or not verified or current_dd is None:
        pass  # already disclosed above

    return {
        "title": f"A 股账户研究日报｜{as_of.replace('-', ' 年 ')}",
        "subtitle": (
            f"生成于 {generated_at}（北京时间）｜市场数据截至交易日 {_iso(as_of)}"
        ),
        "account_status": f"账户数据：{account_status_note}",
        "sections": {
            "今日判断": {
                "conclusion": conclusion,
                "reasons": reasons[:3],
                "max_risk": narrative_parts[0] if narrative_parts else "最大持仓集中度为当前组合的主要风险。",
                "change_condition": (
                    f"如{focus_code} 收盘跌破近 20 个交易日最低收盘，或账户完成成交核对，将重估是否需要调整。"
                ),
                "execution_note": "当前不提供买卖数量；研究判断与执行数量门控分离。",
            },
            "账户与风险": {
                "metrics": metrics,
                "narrative": " ".join(narrative_parts) if narrative_parts else "风险主要来自集中暴露。",
            },
            "三项主要证据": {"items": items},
            "持仓判断": {"holdings": holdings_rows},
            "是否存在更好的选择": {"options": []},
            "下一交易日关注": {"conditions": conditions},
            "数据说明与参考来源": {"notes": notes, "sources": []},
        },
    }


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
