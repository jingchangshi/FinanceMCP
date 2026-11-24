#!/usr/bin/env python3
"""Render, publish to Feishu Docx, verify read-back, and send Feishu IM notification.

Deterministic end-to-end publisher for frozen or live V3 research bundles:
  bundle JSON -> sections_from_bundle.build_sections -> feishu_render.render_xml
    -> feishu_publish.publish -> feishu_notify.notify
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

sys.path.insert(0, str(Path(__file__).resolve().parent))

from feishu_notify import notify  # noqa: E402
from feishu_publish import (  # noqa: E402
    DEFAULT_CONFIG_NAME,
    LEDGER_DIR,
    atomic_write_text,
    dry_run as publish_dry_run,
    load_json,
    normalize_trade_date,
    publish,
    run_lark,
)
from feishu_render import render_xml, validate_sections  # noqa: E402
from sections_from_bundle import build_sections  # noqa: E402


def _shanghai_hhmm() -> str:
    if ZoneInfo is not None:
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
    else:  # pragma: no cover
        now = datetime.now(timezone(timedelta(hours=8)))
    return now.strftime("%H:%M")


def run_publish_and_notify(
    *,
    root: Path,
    bundle_path: Path,
    config: dict[str, Any],
    generated_at: str = "",
    data_delayed: bool = False,
    deadline_hm: str = "2115",
    force_notify: bool = False,
    skip_notify: bool = False,
    dry_run: bool = False,
    runner: Callable[[list[str], Path], dict[str, Any]] = run_lark,
) -> dict[str, Any]:
    root = root.resolve()
    raw = load_json(bundle_path.resolve())
    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else raw
    trade_date = normalize_trade_date(payload.get("as_of_trade_date"))
    if not trade_date:
        raise ValueError("bundle is missing as_of_trade_date")

    hhmm = generated_at.strip() or _shanghai_hhmm()
    sections = build_sections(payload, generated_at=hhmm)
    problems = validate_sections(sections)
    if problems:
        raise ValueError("sections validation failed: " + "; ".join(problems))
    xml_text = render_xml(sections)

    day_dir = root / LEDGER_DIR / trade_date
    sections_path = day_dir / "sections.json"
    xml_path = day_dir / "report.xml"
    atomic_write_text(
        sections_path, json.dumps(sections, ensure_ascii=False, indent=2) + "\n"
    )
    atomic_write_text(xml_path, xml_text)

    sources = (
        (sections.get("sections") or {})
        .get("数据说明与参考来源", {})
        .get("sources")
        or []
    )
    source_count = len(sources)
    title = str(sections["title"])

    if dry_run:
        pub_res = publish_dry_run(root, xml_path, trade_date, title, source_count, config)
        dry_pub_entry = {
            "trade_date": trade_date,
            "document_id": pub_res.get("document_id"),
            "document_url": (
                f"https://my.feishu.cn/docx/{pub_res['document_id']}"
                if pub_res.get("document_id")
                else "https://my.feishu.cn/docx/DRY_RUN"
            ),
        }
        notify_res = (
            {"status": "skipped", "trade_date": trade_date}
            if skip_notify
            else notify(
                root,
                raw,
                dry_pub_entry,
                config,
                data_delayed=data_delayed,
                deadline_hm=deadline_hm,
                force=force_notify,
                dry_run=True,
                runner=runner,
            )
        )
        return {
            "status": "dry_run",
            "trade_date": trade_date,
            "title": title,
            "sections_path": str(sections_path),
            "xml_path": str(xml_path),
            "publish": pub_res,
            "notify": notify_res,
        }

    pub_res = publish(
        root,
        xml_path,
        trade_date,
        title,
        source_count,
        config,
        runner=runner,
    )
    notify_res = (
        {"status": "skipped", "trade_date": trade_date}
        if skip_notify
        else notify(
            root,
            raw,
            pub_res,
            config,
            data_delayed=data_delayed,
            deadline_hm=deadline_hm,
            force=force_notify,
            dry_run=False,
            runner=runner,
        )
    )
    return {
        "status": "ok",
        "trade_date": trade_date,
        "title": title,
        "sections_path": str(sections_path),
        "xml_path": str(xml_path),
        "publish": pub_res,
        "notify": notify_res,
    }


def main() -> int:
    default_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Render sections/XML from V3 bundle, publish Feishu Docx, and notify user."
    )
    parser.add_argument("--root", type=Path, default=default_root)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--generated-at", default="")
    parser.add_argument("--data-delayed", action="store_true")
    parser.add_argument(
        "--deadline-hm",
        default=os.environ.get("ASHARE_READINESS_DEADLINE_HM", "2115"),
        help="HHMM readiness deadline rendered in the delayed-data banner.",
    )
    parser.add_argument("--force-notify", action="store_true")
    parser.add_argument("--skip-notify", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config_path = args.config or (Path(__file__).resolve().parent / DEFAULT_CONFIG_NAME)
    config = load_json(config_path)
    receipt = run_publish_and_notify(
        root=args.root,
        bundle_path=args.bundle,
        config=config,
        generated_at=args.generated_at,
        data_delayed=args.data_delayed,
        deadline_hm=args.deadline_hm,
        force_notify=args.force_notify,
        skip_notify=args.skip_notify,
        dry_run=args.dry_run,
    )
    print(json.dumps(receipt, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
