#!/usr/bin/env python3
"""Deterministic Feishu IM notification sender for A-share V3 daily reports.

Reads an already-computed research bundle plus the published Docx receipt, builds
a concise Markdown summary (zero LLM calls, zero price recomputation, zero
internal enum leaks), and delivers it via ``lark-cli im +messages-send``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from feishu_publish import (  # noqa: E402
    DEFAULT_CONFIG_NAME,
    INCIDENT_NAME,
    LEDGER_DIR,
    ledger_entry_for_date,
    load_json,
    load_ledger,
    normalize_trade_date,
    run_lark,
    upsert_ledger,
    write_incident,
)
from feishu_render import check_forbidden  # noqa: E402
from sections_from_bundle import humanize_text  # noqa: E402

NOTIFY_LEDGER_NAME = "account_notify_ledger.jsonl"
NOTIFY_USER_ID_ENV = "FEISHU_NOTIFY_USER_ID"
NOTIFY_CHAT_ID_ENV = "FEISHU_NOTIFY_CHAT_ID"

_REGIME_ZH = {
    "BULL": "进攻档",
    "NEUTRAL": "结构档",
    "BEAR": "防守档",
}
_SIDE_ZH = {"SELL": "卖出", "BUY": "买入"}
_URL_RE = re.compile(r"https?://\S+")


def _fmt_yuan(cents: Any) -> str:
    if not isinstance(cents, (int, float)):
        return "数据不足"
    sign = "-" if cents < 0 else ""
    abs_cents = abs(int(round(cents)))
    return f"{sign}{abs_cents // 100:,}.{abs_cents % 100:02d} 元"


def _fmt_pct(value: Any, digits: int = 2) -> str:
    if not isinstance(value, (int, float)):
        return "—"
    return f"{value:.{digits}f}%"


def _fmt_price(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "—"
    return f"{value:.3f}" if value < 10 else f"{value:.2f}"


def _format_iso_date(trade_date: str) -> str:
    d = normalize_trade_date(trade_date)
    if len(d) == 8 and d.isdigit():
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return d or "未知日期"


def _action_priority_label(action: dict[str, Any]) -> str:
    raw = str(action.get("priority") or "").strip()
    if raw and re.fullmatch(r"P\d+", raw):
        return f"[{raw}] "
    return ""


def _format_action_line(action: dict[str, Any]) -> str:
    title = str(action.get("title") or "规则动作").strip()
    prefix = _action_priority_label(action)
    legs_txt: list[str] = []
    for leg in action.get("legs") or []:
        if not isinstance(leg, dict):
            continue
        side = _SIDE_ZH.get(str(leg.get("side") or "").upper(), str(leg.get("side") or "操作"))
        code = str(leg.get("ts_code") or "").strip()
        qty = leg.get("quantity") or 0
        qty_txt = f"{int(qty):,}" if isinstance(qty, (int, float)) else str(qty)
        px = (leg.get("price_milli") or 0) / 1000.0 if isinstance(leg.get("price_milli"), (int, float)) else None
        px_txt = f"（参考价 {_fmt_price(px)} 元）" if px is not None and px > 0 else ""
        unit = "股" if code.endswith((".SH", ".SZ", ".BJ")) and not code.startswith(("51", "56", "58", "53", "15", "16")) else "份"
        legs_txt.append(f"{side} {code} {qty_txt} {unit}{px_txt}")
    detail = "；".join(legs_txt) if legs_txt else humanize_text(str((action.get("reasons") or [""])[0] or "")).strip()
    if detail:
        return f"- **{prefix}{humanize_text(title)}**：{humanize_text(detail)}"
    return f"- **{prefix}{humanize_text(title)}**"


def build_notification_markdown(
    bundle: dict[str, Any],
    publish_entry: dict[str, Any],
    *,
    data_delayed: bool = False,
) -> tuple[str, str]:
    """Build concise Feishu IM Markdown summary + deterministic fingerprint."""
    payload = bundle.get("payload") if isinstance(bundle.get("payload"), dict) else bundle
    trade_date = normalize_trade_date(
        payload.get("as_of_trade_date") or publish_entry.get("trade_date") or ""
    )
    iso_date = _format_iso_date(trade_date)

    portfolio = payload.get("portfolio") or {}
    cockpit = portfolio.get("v3_cockpit") if isinstance(portfolio.get("v3_cockpit"), dict) else {}
    mr = cockpit.get("market_regime") or {}
    router = cockpit.get("router") or {}
    deconc = cockpit.get("deconcentration") or {}
    principal = cockpit.get("principal") or {}
    revalued = (portfolio.get("account_view") or {}).get("revalued_basis") or {}

    total_cents = revalued.get("total_assets_cents")
    if not isinstance(total_cents, (int, float)):
        total_cents = principal.get("current_nav_cents")
    securities_cents = revalued.get("securities_mv_cents")
    current_equity_pct = (
        (securities_cents / total_cents) * 100.0
        if isinstance(securities_cents, (int, float))
        and isinstance(total_cents, (int, float))
        and total_cents > 0
        else None
    )

    regime_zh = str(
        mr.get("regime_label_zh")
        or _REGIME_ZH.get(str(mr.get("regime") or ""), "")
        or (payload.get("market") or {}).get("regime_label")
        or "待判定"
    )
    style_zh = str(mr.get("style_label_zh") or "风格均衡")
    target_equity_pct = mr.get("target_equity_pct")
    if target_equity_pct is None and isinstance(router.get("effective_max_equity_bps"), (int, float)):
        target_equity_pct = router["effective_max_equity_bps"] / 100.0

    hwm_dd = router.get("hwm_drawdown_pct")
    lifeline_cents = router.get("lifeline_nav_cents")
    lifeline_buffer = router.get("lifeline_buffer_pct")
    preemptive_active = bool(router.get("deconcentration_preemptive_active"))
    cb_label = str(router.get("circuit_breaker_label_zh") or "正常运作")

    first_section = portfolio.get("first_section") or {}
    actions = [a for a in (first_section.get("actions") or []) if isinstance(a, dict)]
    is_actionable = bool(portfolio.get("actionable")) and bool(actions)
    next_date = _format_iso_date(str(portfolio.get("expected_next_trade_date") or ""))

    lines: list[str] = [f"**A 股攻防实战日报｜{iso_date} 收盘**"]
    if data_delayed:
        lines.append("")
        lines.append(
            "⚠️ **数据延迟提示**：截至 21:15 上游部分收盘数据未完全就绪，以下基于最新可用缓存生成，明早开盘前请复核。"
        )

    lines.append("")
    cap_txt = f"目标权益上限 {_fmt_pct(target_equity_pct, 0)}" if target_equity_pct is not None else "目标权益待定"
    cur_eq_txt = f"，当前权益占比 {_fmt_pct(current_equity_pct, 1)}" if current_equity_pct is not None else ""
    lines.append(f"- **市场档位**：{humanize_text(regime_zh)}（{humanize_text(style_zh)}，{cap_txt}{cur_eq_txt}）")

    buf_bits: list[str] = []
    if isinstance(hwm_dd, (int, float)):
        buf_bits.append(f"自高水位回撤 {_fmt_pct(hwm_dd)}")
    if isinstance(lifeline_cents, (int, float)):
        line_name = "12%前置 / 15%硬生命线" if preemptive_active else "15%熔断生命线"
        buf_bits.append(f"{line_name} {_fmt_yuan(lifeline_cents)}")
    if isinstance(lifeline_buffer, (int, float)):
        buf_bits.append(f"安全缓冲 {_fmt_pct(lifeline_buffer)}")
    safety_summary = "，".join(buf_bits) if buf_bits else humanize_text(cb_label)
    lines.append(f"- **账户总资产**：{_fmt_yuan(total_cents)}（{humanize_text(cb_label)}｜{safety_summary}）")

    tranches = [t for t in (deconc.get("tranches") or []) if isinstance(t, dict)]
    if tranches:
        exec_cnt = sum(1 for t in tranches if t.get("status") == "EXECUTED")
        trig_bits: list[str] = []
        if deconc.get("rebound_trigger_cny") is not None:
            trig_bits.append(f"反弹触发 {_fmt_price(deconc['rebound_trigger_cny'])} 元")
        if deconc.get("next_monthly_trigger_date"):
            trig_bits.append(f"下月窗口 {_format_iso_date(str(deconc['next_monthly_trigger_date']))}")
        if deconc.get("ma60_protect_cny") is not None:
            trig_bits.append(f"60日线防守 {_fmt_price(deconc['ma60_protect_cny'])} 元")
        trig_txt = f"（{'；'.join(trig_bits)}）" if trig_bits else ""
        lines.append(f"- **159558 换马进度**：{exec_cnt}/{len(tranches)} 批已执行{trig_txt}")

    lines.append("")
    lines.append(f"**下一交易日（{next_date}）操作建议**")
    if is_actionable:
        for act in actions[:4]:
            lines.append(_format_action_line(act))
    elif actions:
        lines.append("- 检测到参考调整方案，但账户或数据核验尚未就绪，请打开全文核对后再操作。")
    else:
        lines.append("- 明日无新增买卖指令，按计划持有观察。")

    doc_url = str(publish_entry.get("document_url") or "").strip()
    lines.append("")
    if doc_url:
        lines.append(f"📄 [点击查看完整飞书实战日报]({doc_url})")
    else:
        lines.append("📄 完整飞书实战日报已完成发布校验。")
    lines.append("")
    lines.append("研究记录，不构成自动交易指令。")

    markdown_text = humanize_text("\n".join(lines))
    visible_no_urls = _URL_RE.sub("", markdown_text)
    forbidden = check_forbidden(visible_no_urls)
    if forbidden:
        raise ValueError(f"forbidden internal terms in notification: {forbidden}")

    fingerprint_payload = {
        "trade_date": trade_date,
        "document_url": doc_url,
        "markdown": markdown_text,
    }
    notify_sha256 = hashlib.sha256(
        json.dumps(fingerprint_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return markdown_text, notify_sha256


def resolve_notify_targets(
    config: dict[str, Any], env: dict[str, str] | None = None
) -> list[tuple[str, str]]:
    """Resolve ordered IM delivery targets: direct user open_id first, group chat_id fallback."""
    environ = env if env is not None else dict(os.environ)
    targets: list[tuple[str, str]] = []
    user_env_key = str(config.get("notify_user_id_env") or NOTIFY_USER_ID_ENV)
    chat_env_key = str(config.get("notify_chat_id_env") or NOTIFY_CHAT_ID_ENV)

    user_id = str(environ.get(user_env_key) or config.get("notify_user_id") or "").strip()
    if user_id:
        targets.append(("--user-id", user_id))

    chat_id = str(
        environ.get(chat_env_key)
        or config.get("notify_chat_id")
        or config.get("notify_fallback_chat_id")
        or ""
    ).strip()
    if chat_id:
        targets.append(("--chat-id", chat_id))

    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for pair in targets:
        if pair not in seen:
            seen.add(pair)
            deduped.append(pair)
    if config.get("notify_enabled") and not deduped:
        raise ValueError(
            f"missing Feishu notification recipient: set ${user_env_key} / ${chat_env_key} "
            "or notify_user_id / notify_fallback_chat_id in config"
        )
    return deduped


def notify(
    root: Path,
    bundle: dict[str, Any],
    publish_entry: dict[str, Any],
    config: dict[str, Any],
    *,
    data_delayed: bool = False,
    force: bool = False,
    dry_run: bool = False,
    runner: Callable[[list[str], Path], dict[str, Any]] = run_lark,
) -> dict[str, Any]:
    """Send Feishu IM notification once per (trade_date, content fingerprint)."""
    root = root.resolve()
    payload = bundle.get("payload") if isinstance(bundle.get("payload"), dict) else bundle
    trade_date = normalize_trade_date(
        payload.get("as_of_trade_date") or publish_entry.get("trade_date") or ""
    )
    if not config.get("notify_enabled", False):
        return {"status": "disabled", "trade_date": trade_date}

    identity = str(config.get("identity", "bot"))
    targets = resolve_notify_targets(config)
    markdown_text, notify_sha256 = build_notification_markdown(
        bundle, publish_entry, data_delayed=data_delayed
    )
    ledger_path = root / LEDGER_DIR / NOTIFY_LEDGER_NAME
    existing = ledger_entry_for_date(load_ledger(ledger_path), trade_date)
    if not force and existing and existing.get("notify_sha256") == notify_sha256:
        return {
            "status": "skipped_already_notified",
            "trade_date": trade_date,
            "notify_sha256": notify_sha256,
            "document_url": publish_entry.get("document_url"),
            "message_id": existing.get("message_id"),
            "recipient_flag": existing.get("recipient_flag"),
            "recipient_id": existing.get("recipient_id"),
        }

    if dry_run:
        return {
            "status": "dry_run",
            "trade_date": trade_date,
            "notify_sha256": notify_sha256,
            "document_url": publish_entry.get("document_url"),
            "targets": [{"flag": flag, "id": tid} for flag, tid in targets],
            "markdown": markdown_text,
        }

    idempotency_key = f"ashare-{trade_date}-{notify_sha256[:16]}"
    errors: list[str] = []
    for flag_name, target_id in targets:
        try:
            res = runner(
                [
                    "lark-cli",
                    "im",
                    "+messages-send",
                    "--as",
                    identity,
                    flag_name,
                    target_id,
                    "--markdown",
                    markdown_text,
                    "--idempotency-key",
                    idempotency_key,
                    "--format",
                    "json",
                ],
                root,
            )
            data = res.get("data") or {}
            message_id = data.get("message_id") or (data.get("message") or {}).get("message_id")
            entry = {
                "trade_date": trade_date,
                "status": "sent",
                "notify_sha256": notify_sha256,
                "document_id": publish_entry.get("document_id"),
                "document_url": publish_entry.get("document_url"),
                "recipient_flag": flag_name,
                "recipient_id": target_id,
                "message_id": message_id,
                "data_delayed": bool(data_delayed),
                "sent_at": datetime.now(timezone.utc).isoformat(),
            }
            upsert_ledger(ledger_path, entry)
            return entry
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{flag_name}({target_id}): {exc}")
            print(
                f"feishu_notify warning: failed for {flag_name} {target_id}: {exc}",
                file=sys.stderr,
            )

    incident_path = root / LEDGER_DIR / INCIDENT_NAME
    write_incident(
        incident_path,
        {
            "status": "notify_failed",
            "trade_date": trade_date,
            "document_id": publish_entry.get("document_id"),
            "document_url": publish_entry.get("document_url"),
            "notify_sha256": notify_sha256,
            "errors": errors,
            "at": datetime.now(timezone.utc).isoformat(),
        },
    )
    raise RuntimeError(
        "Feishu IM notification failed for all targets: " + "; ".join(errors)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Send Feishu IM summary for a published V3 report.")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--trade-date", default="")
    parser.add_argument("--data-delayed", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    config_path = args.config or (Path(__file__).resolve().parent / DEFAULT_CONFIG_NAME)
    config = load_json(config_path)
    bundle = load_json(args.bundle.resolve())
    payload = bundle.get("payload") if isinstance(bundle.get("payload"), dict) else bundle
    trade_date = normalize_trade_date(
        args.trade_date or payload.get("as_of_trade_date") or ""
    )
    pub_ledger = load_ledger(root / LEDGER_DIR / "account_publish_ledger.jsonl")
    pub_entry = ledger_entry_for_date(pub_ledger, trade_date) or {
        "trade_date": trade_date,
        "document_id": None,
        "document_url": "",
    }
    result = notify(
        root,
        bundle,
        pub_entry,
        config,
        data_delayed=args.data_delayed,
        force=args.force,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
