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
import shutil
import subprocess
import sys
import tempfile
import time
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


def normalize_trade_date(trade_date: Any) -> str:
    return str(trade_date or "").replace("-", "").strip()


def resolve_lark_bin() -> str:
    """Resolve lark-cli binary path even under systemd minimal PATH."""
    env_bin = str(os.environ.get("LARK_CLI_BIN") or "").strip()
    if env_bin:
        return env_bin
    which_bin = shutil.which("lark-cli")
    if which_bin:
        return which_bin
    home_candidate = Path.home() / "Software" / "node" / "bin" / "lark-cli"
    if home_candidate.exists():
        return str(home_candidate)
    return "lark-cli"


class LarkError(RuntimeError):
    """lark-cli failure carrying an explicit retry/fallback classification.

    ``retryable`` is true only for transport timeouts, network errors and
    HTTP 5xx/429 responses. Permission and other explicit 4xx rejections are
    never retried and are the only failures allowed to fall through to the
    next notification target.
    """

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        status: int | None = None,
        error_type: str | None = None,
        error_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.error_type = error_type
        self.error_code = error_code


_PERMISSION_ERROR_TOKENS = (
    "permission",
    "forbidden",
    "lacks view or edit access",
    "4030004",
    "981004",
    "access denied",
    "not authorized",
    "no permission",
)
_TRANSIENT_ERROR_TOKENS = (
    "timeout",
    "timed out",
    "econnreset",
    "connection reset",
    "connection refused",
    "connection aborted",
    "network",
    "temporarily unavailable",
    "service unavailable",
    "internal error",
    "server error",
    "rate limit",
    "too many requests",
    "try again",
    "gateway timeout",
    "bad gateway",
)
# A plain-text failure (no JSON envelope) is only safe to fall back on when it
# names an explicit client-side rejection.
_CLIENT_REJECTION_TOKENS = (
    "invalid",
    "bad request",
    "not found",
    "malformed",
    "blocked",
    "denied",
)


def _text_is_retryable(text: str) -> bool:
    lowered = text.lower()
    if any(token in lowered for token in _PERMISSION_ERROR_TOKENS):
        return False
    if any(token in lowered for token in _TRANSIENT_ERROR_TOKENS):
        return True
    return bool(re.search(r"\b(?:429|5\d\d)\b", lowered))


def _status_from_error(error: dict[str, Any]) -> int | None:
    for key in ("status", "http_status", "status_code"):
        raw = error.get(key)
        if raw is None or raw == "":
            continue
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if 100 <= value < 600:
            return value
    return None


def is_non_retryable_client_error(exc: BaseException) -> bool:
    """True only for an explicit 4xx/permission rejection (safe to fall back)."""
    if isinstance(exc, LarkError):
        if exc.retryable:
            return False
        if exc.status is not None and 400 <= exc.status < 500 and exc.status != 429:
            return True
    text = " ".join(
        str(part or "")
        for part in (
            getattr(exc, "error_type", ""),
            getattr(exc, "error_code", ""),
            str(exc),
        )
    ).lower()
    if any(token in text for token in _PERMISSION_ERROR_TOKENS):
        return True
    if re.search(r"\b4\d\d\b", text):
        return True
    return any(token in text for token in _CLIENT_REJECTION_TOKENS)


def _retry_attempts() -> int:
    try:
        return max(1, int(os.environ.get("ASHARE_FEISHU_RETRY_ATTEMPTS", "3")))
    except ValueError:
        return 3


def _retry_base_seconds() -> float:
    try:
        return max(0.0, float(os.environ.get("ASHARE_FEISHU_RETRY_BASE_SECONDS", "0.5")))
    except ValueError:
        return 0.5


def _run_lark_once(cmd: list[str], cwd: Path) -> dict[str, Any]:
    completed = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=180
    )
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    result = None
    for payload in ((stderr, stdout) if completed.returncode != 0 else (stdout, stderr)):
        if not payload:
            continue
        try:
            result = json.loads(payload)
            break
        except json.JSONDecodeError:
            continue
    if result is None:
        # A 4xx from the gateway/CLI normally arrives as a JSON envelope; plain
        # text is ambiguous, so retry only when it names a transport/5xx cause.
        detail = (stderr or stdout or "no output")[:300]
        raise LarkError(
            f"lark-cli returned non-JSON output (exit={completed.returncode}): {detail}",
            retryable=_text_is_retryable(detail),
        )
    if completed.returncode != 0 or not result.get("ok"):
        error = result.get("error") or {}
        err_msg = str(error.get("message") or "").strip()
        if not err_msg:
            data_obj = result.get("data") or {}
            warnings = data_obj.get("warnings")
            if isinstance(warnings, list) and warnings:
                err_msg = "; ".join(str(item) for item in warnings if str(item).strip())
            elif data_obj.get("result"):
                err_msg = str(data_obj.get("result"))
        error_type = str(error.get("type") or "") or None
        error_code = str(error.get("code") or "") or None
        status = _status_from_error(error)
        classification_text = " ".join(
            part for part in (error_type or "", error_code or "", err_msg) if part
        )
        retryable = _text_is_retryable(classification_text) or (
            status is not None and (status == 429 or 500 <= status < 600)
        )
        # An explicit permission rejection always wins over a numeric 5xx hint.
        if any(token in classification_text.lower() for token in _PERMISSION_ERROR_TOKENS):
            retryable = False
        raise LarkError(
            f"Lark publish failed: {error.get('type') or 'unknown'}: "
            f"{err_msg or 'no message'}",
            retryable=retryable,
            status=status,
            error_type=error_type,
            error_code=error_code,
        )
    return result


def run_lark(argv: list[str], cwd: Path) -> dict[str, Any]:
    """Run ``lark-cli`` with bounded exponential backoff for transient failures.

    Only network/timeout failures and 5xx/429 responses are retried (3 attempts
    by default, 0.5s then 1s). Explicit 4xx/permission rejections fail on the
    first attempt so the caller can fall back without duplicating a delivery.
    """
    cmd = [resolve_lark_bin(), *argv[1:]] if argv and argv[0] == "lark-cli" else list(argv)
    attempts = _retry_attempts()
    last_error: LarkError | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _run_lark_once(cmd, cwd)
        except FileNotFoundError as exc:
            raise LarkError(f"lark-cli not found: {exc}", retryable=False) from exc
        except PermissionError as exc:
            raise LarkError(f"lark-cli cannot be executed: {exc}", retryable=False) from exc
        except LarkError as exc:
            if not exc.retryable or attempt >= attempts:
                raise
            last_error = exc
        except subprocess.TimeoutExpired as exc:
            wrapped = LarkError(
                f"lark-cli timed out after {exc.timeout}s", retryable=True
            )
            if attempt >= attempts:
                raise wrapped from exc
            last_error = wrapped
        except OSError as exc:
            wrapped = LarkError(f"lark-cli transport failure: {exc}", retryable=True)
            if attempt >= attempts:
                raise wrapped from exc
            last_error = wrapped
        delay = min(_retry_base_seconds() * (2 ** (attempt - 1)), 8.0)
        if delay > 0:
            time.sleep(delay)
    raise last_error or LarkError("lark-cli failed", retryable=False)


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
    target = normalize_trade_date(trade_date)
    for entry in reversed(entries):
        if normalize_trade_date(entry.get("trade_date")) == target:
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
    target = normalize_trade_date(entry["trade_date"])
    kept: list[dict[str, Any]] = []
    replaced = False
    for existing in entries:
        if normalize_trade_date(existing.get("trade_date")) == target:
            if not replaced:
                kept.append(entry)
                replaced = True
        else:
            kept.append(existing)
    if not replaced:
        kept.append(entry)
    write_ledger(path, kept)


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

    parent_fallback: str | None = None
    update_fallback: str | None = None
    previous_document_id: str | None = None
    recreated = False
    created_new = False
    if document_id:
        try:
            result = runner(
                [
                    "lark-cli", "docs", "+update", "--as", identity,
                    "--doc", str(document_id), "--command", "overwrite",
                    "--doc-format", "xml", "--content", f"@./{relative_xml}",
                    "--format", "json",
                ],
                root,
            )
        except RuntimeError as exc:
            msg = str(exc).lower()
            perm_tokens = (
                "permission",
                "lacks view or edit access",
                "4030004",
                "981004",
                "forbidden",
            )
            can_recreate = bool(
                config.get("fallback_to_create_on_update_permission_error", True)
            ) and any(tok in msg for tok in perm_tokens)
            if not can_recreate:
                raise
            previous_document_id = document_id
            update_fallback = "recreated_on_update_permission_error"
            recreated = True
            document_id = None
            document_url = None
    if not document_id:
        created_new = True
        try:
            result = runner(
                [
                    "lark-cli", "docs", "+create", "--as", identity,
                    "--doc-format", "xml", "--content", f"@./{relative_xml}",
                    "--parent-token", str(folder_token),
                    "--format", "json",
                ],
                root,
            )
        except RuntimeError as exc:
            msg = str(exc).lower()
            can_fallback = (
                identity == "bot"
                and bool(config.get("fallback_to_bot_root_on_permission_error", True))
                and ("permission" in msg or "parent location" in msg)
            )
            if not can_fallback:
                raise
            parent_fallback = "bot_root_permission_denied"
            result = runner(
                [
                    "lark-cli", "docs", "+create", "--as", identity,
                    "--doc-format", "xml", "--content", f"@./{relative_xml}",
                    "--format", "json",
                ],
                root,
            )
        document = (result.get("data") or {}).get("document") or {}
        document_id = document.get("document_id")
        document_url = document.get("url")
    if not document_id:
        raise RuntimeError("Lark publish did not return a document_id")
    if not document_url:
        document_url = f"https://my.feishu.cn/docx/{document_id}"

    if created_new:
        # The document exists remotely from this moment on. Record it *before*
        # the read-back: a read-back failure used to leave an orphan document
        # with no ledger entry at all. The verified receipt below replaces this
        # pending row on success; on failure the row (plus the incident log)
        # makes the orphan discoverable and the next run updates it in place.
        pending_entry = {
            "trade_date": trade_date,
            "document_id": document_id,
            "document_url": document_url,
            "file_name": file_name,
            "report_sha256": report_hash,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "renderer_version": RENDERER_VERSION,
            "identity": identity,
            "format": "docx",
            **({"parent_fallback": parent_fallback} if parent_fallback else {}),
            **(
                {
                    "update_fallback": update_fallback,
                    "previous_document_id": previous_document_id,
                }
                if update_fallback
                else {}
            ),
        }
        upsert_ledger(ledger_path, pending_entry)

    fetch_cmd = [
        "lark-cli", "docs", "+fetch", "--as", identity,
        "--doc", str(document_id), "--doc-format", "xml",
        "--detail", "simple", "--format", "json",
    ]
    fetched = runner(fetch_cmd, root)
    remote_document = (fetched.get("data") or {}).get("document") or {}
    problems = verify_readback(remote_document.get("content"), title, source_count)
    if existing and not recreated and any("title mismatch" in p for p in problems):
        runner(
            [
                "lark-cli", "drive", "+update-title", "--as", identity,
                "--token", str(document_id), "--type", "docx",
                "--title", title, "--format", "json",
            ],
            root,
        )
        fetched = runner(fetch_cmd, root)
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
        **({"parent_fallback": parent_fallback} if parent_fallback else {}),
        **(
            {
                "update_fallback": update_fallback,
                "previous_document_id": previous_document_id,
            }
            if update_fallback
            else {}
        ),
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
