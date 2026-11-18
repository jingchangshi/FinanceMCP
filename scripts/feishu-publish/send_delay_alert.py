#!/usr/bin/env python3
"""Send a concise Chinese Feishu IM delay notice when Tushare readiness polls repeatedly."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from feishu_notify import resolve_notify_targets  # noqa: E402
from feishu_publish import (  # noqa: E402
    DEFAULT_CONFIG_NAME,
    load_json,
    normalize_trade_date,
    run_lark,
)


def _format_iso_date(trade_date: str) -> str:
    d = normalize_trade_date(trade_date)
    if len(d) == 8 and d.isdigit():
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return d or "今日"


def _format_hm(hm: str) -> str:
    digits = "".join(ch for ch in str(hm or "") if ch.isdigit())
    if len(digits) == 4:
        return f"{digits[:2]}:{digits[2:]}"
    return str(hm or "21:15")


def _humanize_status(raw_status: str) -> str:
    text = str(raw_status or "").strip().lower()
    if text.startswith("exit_") or "err" in text or "fail" in text:
        return "上游行情接口暂未返回完整收盘数据，后台正每 10 分钟自动重试"
    return "上游收盘日线/指数/净值数据尚未发布就绪，后台每 10 分钟自动轮询"


def build_delay_alert_markdown(
    trade_date: str,
    *,
    status: str,
    attempt: int,
    deadline_hm: str,
) -> str:
    """Build clean user-facing Chinese markdown without internal enum leaks."""
    iso_date = _format_iso_date(trade_date)
    deadline_txt = _format_hm(deadline_hm)
    status_txt = _humanize_status(status)
    return "\n".join(
        [
            f"⏳ **A股 V3 日报等待上游行情通知（{iso_date}）**",
            f"- 19:30 盘后同步任务已正常启动（当前第 {attempt} 次检查）",
            f"- 当前状态：{status_txt}",
            f"- 数据就绪后将立即生成并推送完整 V3 日报；若至 {deadline_txt} 仍未就绪将发送兜底持仓报告。",
        ]
    )


def send_delay_alert(
    root: Path,
    config: dict[str, Any],
    *,
    trade_date: str,
    status: str,
    attempt: int,
    deadline_hm: str,
    dry_run: bool = False,
    runner: Callable[[list[str], Path], dict[str, Any]] = run_lark,
) -> dict[str, Any]:
    """Send the one-shot delay alert via Feishu IM; skip cleanly when disabled or untargeted."""
    norm_date = normalize_trade_date(trade_date)
    if not config.get("notify_enabled", False):
        return {"status": "disabled", "trade_date": norm_date}

    try:
        targets = resolve_notify_targets(config)
    except ValueError:
        return {"status": "skipped", "reason": "no_targets", "trade_date": norm_date}

    if not targets:
        return {"status": "skipped", "reason": "no_targets", "trade_date": norm_date}

    markdown_text = build_delay_alert_markdown(
        norm_date,
        status=status,
        attempt=attempt,
        deadline_hm=deadline_hm,
    )
    if dry_run:
        return {
            "status": "dry_run",
            "trade_date": norm_date,
            "targets": [{"flag": f, "id": tid} for f, tid in targets],
            "markdown": markdown_text,
        }

    identity = str(config.get("identity", "bot"))
    idempotency_key = f"ashare-delay-alert-{norm_date}"
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
            return {
                "status": "sent",
                "trade_date": norm_date,
                "recipient_flag": flag_name,
                "recipient_id": target_id,
                "message_id": message_id,
            }
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{flag_name}({target_id}): {exc}")
            print(
                f"send_delay_alert warning: failed for {flag_name} {target_id}: {exc}",
                file=sys.stderr,
            )

    raise RuntimeError("Feishu delay alert failed for all targets: " + "; ".join(errors))


def main() -> None:
    parser = argparse.ArgumentParser(description="Send Feishu IM delay alert for daily A-share pipeline.")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--trade-date", required=True)
    parser.add_argument("--status", default="waiting")
    parser.add_argument("--attempt", type=int, default=3)
    parser.add_argument("--deadline-hm", default="2115")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    config_path = args.config or (Path(__file__).resolve().parent / DEFAULT_CONFIG_NAME)
    config = load_json(config_path)
    result = send_delay_alert(
        root,
        config,
        trade_date=args.trade_date,
        status=args.status,
        attempt=args.attempt,
        deadline_hm=args.deadline_hm,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
