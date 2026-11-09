#!/usr/bin/env python3
"""Publish an A-share account research daily report to a Lark/Feishu Docx.

Generalizes the DailyETF ``publish_report.py`` pattern (this module
duplicates the small ``run_lark`` subprocess pattern; it does not import or
modify anything under ``/home/jcshi/workspace/DailyETF``):

1. Validate the rendered XML locally (headings, forbidden terms, Markdown
   leak, hyperlink count) — fail closed before any API call.
2. Resolve the target folder from env/config — never hardcoded secrets.
3. If a ledger entry already exists for this ``trade_date``, overwrite that
   document; otherwise create a new one under the configured folder.
4. Fetch the document back and verify: title, all six section headings,
   no forbidden internal terms, hyperlink count matches the source list.
5. On success, append/replace the per-day receipt in a JSONL ledger
   (history-preserving; one line per trade date).
6. On any failure, write an incident record to the internal incident log,
   leave the ledger (and therefore the previously verified document)
   untouched, and exit non-zero.

The caller owns rendering (``feishu_render.render_xml``) and passes the
resulting XML file plus the report identity.  This module never recomputes
report facts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Allow running as ``python3 feishu_publish.py`` from any cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from feishu_render import (  # noqa: E402
    ALL_HEADINGS,
    RENDERER_VERSION,
    check_forbidden,
    check_markdown_leak,
    count_hyperlinks,
    strip_tags,
)

DEFAULT_CONFIG_NAME = "config.json"
LEDGER_DIR = Path("data/feishu")
LEDGER_NAME = "account_publish_ledger.jsonl"
INCIDENT_NAME = "account_publish_incidents.jsonl"
FOLDER_TOKEN_ENV = "FEISHU_ACCOUNT_FOLDER_TOKEN"


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def normalized_hash(xml_text: str) -> str:
    return hashlib.sha256(xml_text.replace("\r\n", "\n").encode()).hexdigest()


def run_lark(argv: list[str], cwd: Path) -> dict[str, Any]:
    """Run ``lark-cli`` and parse its JSON envelope (duplicated pattern)."""
    completed = subprocess.run(
        argv, cwd=cwd, capture_output=True, text=True, timeout=180
    )
    payload = completed.stdout if completed.returncode == 0 else completed.stderr
    try:
        result = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"lark-cli returned non-JSON output (exit={completed.returncode})"
        ) from exc
    if completed.returncode != 0 or not result.get("ok"):
        error = result.get("error") or {}
        raise RuntimeError(
            f"Lark publish failed: {error.get('type', 'unknown')}: "
            f"{error.get('message', 'no message')}"
        )
    return result


def resolve_folder_token(config: dict[str, Any], env: dict[str, str] | None = None) -> str:
    """Folder token from the environment wins; config file is the fallback."""
    environ = env if env is not None else dict(os.environ)
    token = str(environ.get(config.get("folder_token_env", FOLDER_TOKEN_ENV)) or "").strip()
    if token:
        return token
    token = str(config.get("folder_token") or "").strip()
    if token:
        return token
    raise ValueError(
        f"missing Feishu folder token: set ${config.get('folder_token_env', FOLDER_TOKEN_ENV)} "
        "or folder_token in the config file — refusing to publish"
    )


def validate_xml(xml_text: str, source_count: int) -> list[str]:
    """Local pre-publish checks. Returns problems; empty means safe to send."""
    problems: list[str] = []
    for heading in ALL_HEADINGS:
        if heading not in xml_text:
            problems.append(f"missing required heading: {heading}")
    visible = strip_tags(xml_text)
    forbidden = check_forbidden(visible)
    if forbidden:
        problems.append(f"forbidden internal terms in XML: {forbidden}")
    leaks = check_markdown_leak(visible)
    if leaks:
        problems.append(f"markdown leak in XML: {leaks}")
    if count_hyperlinks(xml_text) != source_count:
        problems.append(
            f"hyperlink count {count_hyperlinks(xml_text)} != source count {source_count}"
        )
    return problems


def load_ledger(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            entries.append(json.loads(line))
    return entries


def ledger_entry_for_date(entries: list[dict[str, Any]], trade_date: str) -> dict[str, Any] | None:
    for entry in entries:
        if str(entry.get("trade_date")) == str(trade_date):
            return entry
    return None


def write_ledger(path: Path, entries: list[dict[str, Any]]) -> None:
    """Append-or-replace by trade_date: exactly one line per trade date."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(
        json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n" for entry in entries
    )
    atomic_write_text(path, text)


def upsert_ledger(path: Path, entry: dict[str, Any]) -> None:
    entries = load_ledger(path)
    trade_date = str(entry["trade_date"])
    replaced = False
    for index, existing in enumerate(entries):
        if str(existing.get("trade_date")) == trade_date:
            entries[index] = entry
            replaced = True
            break
    if not replaced:
        entries.append(entry)
    write_ledger(path, entries)


def write_incident(path: Path, incident: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(incident, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def verify_readback(remote_content: Any, title: str, source_count: int) -> list[str]:
    """Checks on the fetched Docx XML. Returns problems; empty means accepted."""
    problems: list[str] = []
    if not isinstance(remote_content, str):
        return ["no remote content returned by +fetch"]
    if title not in remote_content:
        problems.append(f"title mismatch: {title!r} not in fetched document")
    for heading in ALL_HEADINGS:
        if heading not in remote_content:
            problems.append(f"missing section heading in fetched document: {heading}")
    visible = strip_tags(remote_content)
    forbidden = check_forbidden(visible)
    if forbidden:
        problems.append(f"forbidden internal terms in fetched document: {forbidden}")
    if count_hyperlinks(remote_content) != source_count:
        problems.append(
            f"hyperlink count {count_hyperlinks(remote_content)} != source count {source_count}"
        )
    return problems


def _relative_to_root(root: Path, path: Path) -> str:
    return str(path.resolve().relative_to(root.resolve()))


def publish(
    root: Path,
    xml_path: Path,
    trade_date: str,
    title: str,
    source_count: int,
    config: dict[str, Any],
    runner: Callable[[list[str], Path], dict[str, Any]] = run_lark,
) -> dict[str, Any]:
    """Create-or-overwrite the day's Feishu Docx and record a per-day receipt.

    Fail-closed: local validation happens before any lark-cli call; a failed
    read-back raises and leaves the ledger (and prior verified document)
    untouched.
    """
    root = root.resolve()
    if not config.get("enabled"):
        raise ValueError("Feishu publishing is disabled in config")
    if config.get("format") != "docx":
        raise ValueError("Feishu publication requires format=docx")
    folder_token = resolve_folder_token(config)
    identity = str(config.get("identity", "bot"))

    xml_text = xml_path.read_text(encoding="utf-8")
    problems = validate_xml(xml_text, source_count)
    if problems:
        raise ValueError("XML validation failed before publish: " + "; ".join(problems))
    report_hash = normalized_hash(xml_text)
    file_name = f"{config.get('name_prefix', 'A股账户研究日报')}-{trade_date}"

    ledger_path = root / LEDGER_DIR / LEDGER_NAME
    entries = load_ledger(ledger_path)
    existing = ledger_entry_for_date(entries, trade_date)
    if existing:
        document_id = str(existing["document_id"])
        document_url = str(existing.get("document_url") or "") or None
    else:
        document_id = None
        document_url = None
    relative_xml = _relative_to_root(root, xml_path)

    if document_id:
        result = runner(
            [
                "lark-cli", "docs", "+update", "--as", identity,
                "--doc", str(document_id), "--command", "overwrite",
                "--doc-format", "xml", "--content", f"@./{relative_xml}",
                "--format", "json",
            ],
            root,
        )
    else:
        result = runner(
            [
                "lark-cli", "docs", "+create", "--as", identity,
                "--doc-format", "xml", "--content", f"@./{relative_xml}",
                "--parent-token", str(folder_token),
                "--format", "json",
            ],
            root,
        )
        document = (result.get("data") or {}).get("document") or {}
        document_id = document.get("document_id")
        document_url = document.get("url")
    if not document_id:
        raise RuntimeError("Lark publish did not return a document_id")

    fetched = runner(
        [
            "lark-cli", "docs", "+fetch", "--as", identity,
            "--doc", str(document_id), "--doc-format", "xml",
            "--detail", "simple", "--format", "json",
        ],
        root,
    )
    remote_document = (fetched.get("data") or {}).get("document") or {}
    problems = verify_readback(remote_document.get("content"), title, source_count)
    if problems:
        incident_path = root / LEDGER_DIR / INCIDENT_NAME
        write_incident(
            incident_path,
            {
                "status": "readback_failed",
                "trade_date": trade_date,
                "document_id": document_id,
                "document_url": document_url,
                "report_sha256": report_hash,
                "renderer_version": RENDERER_VERSION,
                "problems": problems,
                "at": datetime.now(timezone.utc).isoformat(),
            },
        )
        raise RuntimeError(
            "Lark Docx read-back verification failed: " + "; ".join(problems)
            + " (incident written to " + str(incident_path) + ")"
        )

    entry = {
        "trade_date": trade_date,
        "document_id": document_id,
        "document_url": document_url,
        "file_name": file_name,
        "report_sha256": report_hash,
        "published_at": datetime.now(timezone.utc).isoformat(),
        "renderer_version": RENDERER_VERSION,
        "identity": identity,
        "format": "docx",
    }
    upsert_ledger(ledger_path, entry)
    return entry


def dry_run(
    root: Path,
    xml_path: Path,
    trade_date: str,
    title: str,
    source_count: int,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Validate locally and report the planned calls without any API call."""
    root = root.resolve()
    xml_text = xml_path.read_text(encoding="utf-8")
    problems = validate_xml(xml_text, source_count)
    folder_token = ""
    try:
        folder_token = resolve_folder_token(config)
    except ValueError:
        folder_token = ""
    ledger_path = root / LEDGER_DIR / LEDGER_NAME
    existing = ledger_entry_for_date(load_ledger(ledger_path), trade_date)
    action = "update" if existing else "create"
    return {
        "status": "dry_run",
        "enabled": bool(config.get("enabled")),
        "format": config.get("format"),
        "identity": config.get("identity", "bot"),
        "name_prefix": config.get("name_prefix", "A股账户研究日报"),
        "has_folder_token": bool(folder_token),
        "trade_date": trade_date,
        "action": action,
        "document_id": str(existing["document_id"]) if existing else None,
        "report_sha256": normalized_hash(xml_text),
        "renderer_version": RENDERER_VERSION,
        "source_count": source_count,
        "hyperlink_count": count_hyperlinks(xml_text),
        "problems": problems,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish the account research daily report to Feishu Docx.")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--xml", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--trade-date", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--source-count", type=int, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    config_path = args.config or (Path(__file__).resolve().parent / DEFAULT_CONFIG_NAME)
    config = load_json(config_path)
    if args.dry_run:
        print(json.dumps(
            dry_run(root, args.xml.resolve(), args.trade_date, args.title,
                    args.source_count, config),
            ensure_ascii=False,
        ))
        return
    result = publish(
        root, args.xml.resolve(), args.trade_date, args.title,
        args.source_count, config,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
