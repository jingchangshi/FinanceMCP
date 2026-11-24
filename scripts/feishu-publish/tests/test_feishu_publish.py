#!/usr/bin/env python3
"""Publisher tests: idempotency, read-back verification, fail-closed paths.

All lark-cli invocations go through a mocked runner — no real Feishu API
calls are made.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from feishu_render import render_xml  # noqa: E402
from feishu_publish import (  # noqa: E402
    LarkError,
    dry_run,
    load_ledger,
    publish,
    run_lark,
    validate_xml,
    verify_readback,
)

SAMPLE = HERE.parent / "samples" / "sections-20261106.example.json"
CONFIG = {
    "enabled": True,
    "identity": "bot",
    "format": "docx",
    "name_prefix": "A股账户研究日报",
    "folder_token_env": "FEISHU_ACCOUNT_FOLDER_TOKEN",
    "folder_token": "config-fallback-token-placeholder",
    "image_width_px": 780,
}
TITLE = "A 股账户研究日报｜2026 年 11 月 6 日收盘"
SOURCE_COUNT = 1


def render_sample_xml(tmp: Path) -> Path:
    sections = json.loads(SAMPLE.read_text(encoding="utf-8"))
    xml_path = tmp / "report.xml"
    xml_path.write_text(render_xml(sections), encoding="utf-8")
    return xml_path


class MockRunner:
    """Records argv lists and returns canned create/fetch payloads."""

    def __init__(self, fetch_content: str | None = None):
        self.calls: list[list[str]] = []
        self.fetch_content = fetch_content
        self.document_id = "doc-mocked-001"

    def __call__(self, argv, cwd):
        self.calls.append(list(argv))
        verb = argv[2] if len(argv) > 2 else ""
        if verb == "+create":
            return {
                "ok": True,
                "data": {
                    "document": {
                        "document_id": self.document_id,
                        "url": f"https://my.feishu.cn/docx/{self.document_id}",
                    }
                },
            }
        if verb == "+update":
            return {"ok": True, "data": {}}
        if verb == "+fetch":
            content = self.fetch_content
            if content is None:
                content = (HERE.parent / ".." / ".." / ".." / ".." / "tmp").exists() or None
            return {"ok": True, "data": {"document": {"content": content}}}
        raise AssertionError(f"unexpected lark-cli verb: {argv}")


class TestPublisher(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.xml_path = render_sample_xml(self.root)
        self.xml_text = self.xml_path.read_text(encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def _ledger(self):
        return load_ledger(self.root / "data/feishu/account_publish_ledger.jsonl")

    def test_create_then_publish_records_ledger(self):
        runner = MockRunner(fetch_content=self.xml_text)
        entry = publish(
            self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG,
            runner=runner,
        )
        verbs = [c[2] for c in runner.calls]
        self.assertEqual(verbs, ["+create", "+fetch"])
        self.assertIn("--parent-token", runner.calls[0])
        self.assertIn("config-fallback-token-placeholder", runner.calls[0])
        self.assertEqual(entry["document_id"], runner.document_id)
        self.assertEqual(entry["trade_date"], "20261106")
        self.assertEqual(entry["renderer_version"], "feishu-account-v1")
        self.assertEqual(entry["file_name"], "A股账户研究日报-20261106")
        ledger = self._ledger()
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["document_id"], runner.document_id)

    def test_same_day_rerun_updates_same_document(self):
        first = MockRunner(fetch_content=self.xml_text)
        publish(self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG, runner=first)
        second = MockRunner(fetch_content=self.xml_text)
        entry = publish(
            self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG,
            runner=second,
        )
        verbs = [c[2] for c in second.calls]
        self.assertEqual(verbs, ["+update", "+fetch"])
        self.assertIn(first.document_id, second.calls[0])
        self.assertEqual(entry["document_id"], first.document_id)
        self.assertEqual(len(self._ledger()), 1)  # still one line for the day

    def test_different_day_creates_new_document(self):
        first = MockRunner(fetch_content=self.xml_text)
        publish(self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG, runner=first)
        second = MockRunner(fetch_content=self.xml_text)
        entry = publish(
            self.root, self.xml_path, "20261109", TITLE, SOURCE_COUNT, CONFIG,
            runner=second,
        )
        self.assertEqual(second.calls[0][2], "+create")
        ledger = self._ledger()
        self.assertEqual(len(ledger), 2)
        self.assertEqual(
            {e["trade_date"] for e in ledger}, {"20261106", "20261109"}
        )

    def test_missing_heading_in_readback_fails_closed(self):
        bad_content = self.xml_text.replace("持仓判断", "持仓说明")
        runner = MockRunner(fetch_content=bad_content)
        with self.assertRaises(RuntimeError):
            publish(
                self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG,
                runner=runner,
            )
        # The created document is not silently orphaned: a pending ledger row
        # carries its id, and the incident records the verification failure.
        ledger = self._ledger()
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["status"], "pending")
        self.assertEqual(ledger[0]["document_id"], runner.document_id)
        incidents = (self.root / "data/feishu/account_publish_incidents.jsonl").read_text(
            encoding="utf-8"
        )
        self.assertIn("readback_failed", incidents)
        self.assertIn("missing section heading", incidents)

    def test_failed_readback_preserves_prior_verified_document(self):
        good = MockRunner(fetch_content=self.xml_text)
        publish(self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG, runner=good)
        bad = MockRunner(fetch_content=self.xml_text.replace("今日判断", "说明"))
        with self.assertRaises(RuntimeError):
            publish(
                self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG,
                runner=bad,
            )
        ledger = self._ledger()
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["document_id"], good.document_id)

    def test_forbidden_term_in_readback_fails_closed(self):
        poisoned = self.xml_text + "<p>状态 DEGRADED</p>"
        runner = MockRunner(fetch_content=poisoned)
        with self.assertRaises(RuntimeError):
            publish(
                self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG,
                runner=runner,
            )
        # Not a verified receipt, but the orphan document is discoverable.
        ledger = self._ledger()
        self.assertEqual([(e["status"], e["document_id"]) for e in ledger],
                         [("pending", runner.document_id)])

    def test_hyperlink_count_mismatch_fails_closed(self):
        # Caught either by local pre-publish validation (ValueError, before any
        # API call) or by read-back verification (RuntimeError) — both fail
        # closed and leave the ledger empty.
        with self.assertRaises((RuntimeError, ValueError)):
            publish(
                self.root, self.xml_path, "20261106", TITLE, 2, CONFIG,
                runner=MockRunner(fetch_content=self.xml_text),
            )
        self.assertEqual(self._ledger(), [])

    def test_missing_folder_token_fails_before_any_api_call(self):
        config = dict(CONFIG)
        config.pop("folder_token")
        runner = MockRunner(fetch_content=self.xml_text)
        with self.assertRaises(ValueError):
            publish(
                self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, config,
                runner=runner,
            )
        self.assertEqual(runner.calls, [])

    def test_disabled_config_fails_before_any_api_call(self):
        config = dict(CONFIG, enabled=False)
        runner = MockRunner(fetch_content=self.xml_text)
        with self.assertRaises(ValueError):
            publish(
                self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, config,
                runner=runner,
            )
        self.assertEqual(runner.calls, [])

    def test_dry_run_calls_no_api(self):
        report = dry_run(self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG)
        self.assertEqual(report["status"], "dry_run")
        self.assertEqual(report["action"], "create")
        self.assertEqual(report["problems"], [])
        self.assertEqual(report["hyperlink_count"], SOURCE_COUNT)

    def test_source_title_passes_publish_and_readback_checks(self):
        sections = json.loads(SAMPLE.read_text(encoding="utf-8"))
        sections["sections"]["数据说明与参考来源"]["sources"][0]["title"] = (
            "AV1 V20 McMCPerson rehash 市场报道：V1 V2 MCP hash"
        )
        xml = render_xml(sections)
        self.assertEqual(validate_xml(xml, SOURCE_COUNT), [])
        self.assertEqual(verify_readback(xml, TITLE, SOURCE_COUNT), [])
        self.xml_path.write_text(xml, encoding="utf-8")
        runner = MockRunner(fetch_content=xml)
        publish(self.root, self.xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG, runner=runner)
        self.assertEqual([call[2] for call in runner.calls], ["+create", "+fetch"])

    def test_short_terms_are_rejected_at_publish_boundaries(self):
        for term in ("V1", "V2", "MCP", "hash"):
            with self.subTest(term=term):
                poisoned = self.xml_text + f"<p>内部{term}字段</p>"
                self.assertTrue(any("forbidden" in p for p in validate_xml(poisoned, SOURCE_COUNT)))
                self.assertTrue(any("forbidden" in p for p in verify_readback(poisoned, TITLE, SOURCE_COUNT)))

    def test_short_term_in_non_source_link_is_rejected(self):
        poisoned = self.xml_text.replace(
            "<b>结论：</b>", '<b>结论：</b><a href="https://example.com">MCP</a>'
        )
        self.assertTrue(any("forbidden" in p for p in validate_xml(poisoned, SOURCE_COUNT + 1)))
        self.assertTrue(any("forbidden" in p for p in verify_readback(poisoned, TITLE, SOURCE_COUNT + 1)))

    def test_verify_readback_rejects_forbidden_term(self):
        problems = verify_readback("<p>ok NOT_READY</p>", TITLE, SOURCE_COUNT)
        self.assertTrue(any("forbidden" in p for p in problems))

    def test_create_permission_denied_falls_back_to_bot_root(self):
        xml_text = self.xml_text
        calls: list[list[str]] = []

        def fallback_runner(argv, cwd):
            calls.append(list(argv))
            verb = argv[2]
            if verb == "+create" and "--parent-token" in argv:
                raise RuntimeError(
                    "Lark publish failed: api: you do not have permission to create the document in the target parent location"
                )
            if verb == "+create":
                return {
                    "ok": True,
                    "data": {
                        "document": {
                            "document_id": "doc-root-001",
                            "url": "https://my.feishu.cn/docx/doc-root-001",
                        }
                    },
                }
            if verb == "+fetch":
                return {"ok": True, "data": {"document": {"content": xml_text}}}
            raise AssertionError(f"unexpected verb: {argv}")

        entry = publish(
            self.root,
            self.xml_path,
            "20261114",
            TITLE,
            SOURCE_COUNT,
            CONFIG,
            runner=fallback_runner,
        )
        self.assertEqual([c[2] for c in calls], ["+create", "+create", "+fetch"])
        self.assertNotIn("--parent-token", calls[1])
        self.assertEqual(entry["document_id"], "doc-root-001")
        self.assertEqual(entry["parent_fallback"], "bot_root_permission_denied")

    def test_hyphenated_ledger_date_matches_without_duplication(self):
        ledger_path = self.root / "data/feishu/account_publish_ledger.jsonl"
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.write_text(
            json.dumps(
                {
                    "trade_date": "2026-11-10",
                    "document_id": "doc-20261110",
                    "document_url": "https://my.feishu.cn/docx/doc-20261110",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        runner = MockRunner(fetch_content=self.xml_text)
        entry = publish(
            self.root,
            self.xml_path,
            "20261110",
            TITLE,
            SOURCE_COUNT,
            CONFIG,
            runner=runner,
        )
        self.assertEqual([c[2] for c in runner.calls], ["+update", "+fetch"])
        self.assertIn("doc-20261110", runner.calls[0])
        self.assertEqual(entry["document_id"], "doc-20261110")
        self.assertEqual(len(self._ledger()), 1)

    def test_existing_doc_syncs_title_when_overwrite_keeps_old_title(self):
        ledger_path = self.root / "data/feishu/account_publish_ledger.jsonl"
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.write_text(
            json.dumps(
                {
                    "trade_date": "20261113",
                    "document_id": "doc-20261113",
                    "document_url": "https://my.feishu.cn/docx/doc-20261113",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        stale_title_xml = self.xml_text.replace(f"<title>{TITLE}</title>", "<title>旧标题</title>")
        updated_xml = self.xml_text
        calls: list[list[str]] = []
        fetch_count = 0

        def title_sync_runner(argv, cwd):
            nonlocal fetch_count
            calls.append(list(argv))
            verb = argv[2]
            if verb == "+update":
                return {"ok": True, "data": {"document_id": "doc-20261113"}}
            if verb == "+fetch":
                fetch_count += 1
                content = stale_title_xml if fetch_count == 1 else updated_xml
                return {"ok": True, "data": {"document": {"content": content}}}
            if verb == "+update-title":
                self.assertIn("--title", argv)
                self.assertEqual(argv[argv.index("--title") + 1], TITLE)
                return {"ok": True, "data": {}}
            raise AssertionError(f"unexpected argv: {argv}")

        entry = publish(
            self.root,
            self.xml_path,
            "20261113",
            TITLE,
            SOURCE_COUNT,
            CONFIG,
            runner=title_sync_runner,
        )
        self.assertEqual(
            [c[2] for c in calls],
            ["+update", "+fetch", "+update-title", "+fetch"],
        )
        self.assertEqual(entry["document_id"], "doc-20261113")

    def test_run_lark_surfaces_data_warnings_when_error_object_missing(self):
        payload = json.dumps(
            {
                "ok": False,
                "data": {
                    "result": "failed",
                    "warnings": [
                        "degrade_code=4030004,msg=Document operation failed: No permission to operate on this document"
                    ],
                },
            }
        )
        fake = subprocess.CompletedProcess(
            args=["lark-cli"], returncode=1, stdout=payload, stderr=""
        )
        with patch("feishu_publish.subprocess.run", return_value=fake):
            with self.assertRaises(RuntimeError) as ctx:
                run_lark(["lark-cli", "docs", "+update"], self.root)
        self.assertIn("4030004", str(ctx.exception))
        self.assertIn("No permission", str(ctx.exception))

    def test_update_permission_denied_recreates_document_and_records_previous_id(self):
        ledger_path = self.root / "data/feishu/account_publish_ledger.jsonl"
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.write_text(
            json.dumps(
                {
                    "trade_date": "20261113",
                    "document_id": "doc-legacy-locked",
                    "document_url": "https://my.feishu.cn/docx/doc-legacy-locked",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        xml_text = self.xml_text
        calls: list[list[str]] = []

        def recreate_runner(argv, cwd):
            calls.append(list(argv))
            verb = argv[2]
            if verb == "+update":
                raise RuntimeError(
                    "Lark publish failed: unknown: degrade_code=4030004,msg=No permission to operate on this document: the current user lacks view or edit access"
                )
            if verb == "+create" and "--parent-token" in argv:
                raise RuntimeError(
                    "Lark publish failed: api: you do not have permission to create the document in the target parent location"
                )
            if verb == "+create":
                return {
                    "ok": True,
                    "data": {
                        "document": {
                            "document_id": "doc-new-20261113",
                            "url": "https://my.feishu.cn/docx/doc-new-20261113",
                        }
                    },
                }
            if verb == "+fetch":
                return {"ok": True, "data": {"document": {"content": xml_text}}}
            raise AssertionError(f"unexpected argv: {argv}")

        entry = publish(
            self.root,
            self.xml_path,
            "20261113",
            TITLE,
            SOURCE_COUNT,
            CONFIG,
            runner=recreate_runner,
        )
        self.assertEqual(
            [c[2] for c in calls],
            ["+update", "+create", "+create", "+fetch"],
        )
        self.assertEqual(entry["document_id"], "doc-new-20261113")
        self.assertEqual(entry["update_fallback"], "recreated_on_update_permission_error")
        self.assertEqual(entry["previous_document_id"], "doc-legacy-locked")
        self.assertEqual(entry["parent_fallback"], "bot_root_permission_denied")
        ledger = self._ledger()
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["document_id"], "doc-new-20261113")


if __name__ == "__main__":
    unittest.main()


class TestCreateUnconfirmed(unittest.TestCase):
    def test_timeout_on_create_is_left_for_manual_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            xml_path = render_sample_xml(root)

            class TimeoutRunner:
                def __init__(self):
                    self.calls = []

                def __call__(self, argv, cwd):
                    self.calls.append(list(argv))
                    raise LarkError("lark-cli timed out after 180s", retryable=True)

            runner = TimeoutRunner()
            with self.assertRaises(LarkError):
                publish(root, xml_path, "20261106", TITLE, SOURCE_COUNT, CONFIG, runner=runner)
            self.assertEqual(len(runner.calls), 1, "publish must not blindly re-create after an uncertain timeout")
            self.assertEqual(load_ledger(root / "data/feishu/account_publish_ledger.jsonl"), [])
            incidents = (root / "data/feishu/account_publish_incidents.jsonl").read_text(encoding="utf-8")
            self.assertIn("create_unconfirmed", incidents)
            self.assertIn("verify in feishu", incidents.lower())


class TestLarkRetry(unittest.TestCase):
    """Bounded exponential backoff: transient failures retry, 4xx rejects do not."""

    def _completed(self, returncode=0, stdout="", stderr=""):
        return subprocess.CompletedProcess([], returncode, stdout, stderr)

    def _run_with(self, responses, env=None, argv=None):
        """Runs lark-cli with `responses` (exceptions or CompletedProcess)."""
        settings = {"ASHARE_FEISHU_RETRY_ATTEMPTS": "3", "ASHARE_FEISHU_RETRY_BASE_SECONDS": "0.01"}
        if env:
            settings.update(env)
        with patch.dict(os.environ, settings), \
             patch("feishu_publish.subprocess.run", side_effect=responses) as run, \
             patch("feishu_publish.time.sleep") as sleep:
            result = None
            error = None
            try:
                result = run_lark(argv or ["lark-cli", "docs", "+fetch"], Path("."))
            except Exception as exc:  # noqa: BLE001
                error = exc
            return result, error, run, sleep

    def test_retries_5xx_envelope_three_times_then_succeeds(self):
        fail = self._completed(
            1, stderr='{"ok": false, "error": {"type": "internal_error", "code": 500, "message": "internal server error"}}'
        )
        ok = self._completed(0, stdout='{"ok": true, "data": {"document": {}}}')
        result, error, run, sleep = self._run_with([fail, fail, ok])
        self.assertIsNone(error)
        self.assertEqual(result["ok"], True)
        self.assertEqual(run.call_count, 3)
        self.assertEqual(sleep.call_count, 2, "two backoff sleeps between three attempts")

    def test_permission_4xx_is_not_retried(self):
        denied = self._completed(
            1, stderr='{"ok": false, "error": {"type": "permission", "code": 4030004, "message": "forbidden"}}'
        )
        result, error, run, sleep = self._run_with([denied])
        self.assertIsNone(result)
        self.assertIsInstance(error, LarkError)
        self.assertEqual(error.retryable, False)
        self.assertEqual(run.call_count, 1, "an explicit 4xx must fail immediately")
        self.assertEqual(sleep.call_count, 0)

    def test_timeout_is_retried_and_then_raises(self):
        timeouts = [subprocess.TimeoutExpired("lark-cli", 180) for _ in range(3)]
        result, error, run, sleep = self._run_with(timeouts)
        self.assertIsNone(result)
        self.assertIsInstance(error, LarkError)
        self.assertEqual(error.retryable, True)
        self.assertEqual(run.call_count, 3)
        self.assertEqual(sleep.call_count, 2, "sleeps only between attempts, not after the last")

    def test_429_is_retried(self):
        limited = self._completed(
            1, stderr='{"ok": false, "error": {"type": "rate_limit", "code": 429, "message": "too many requests"}}'
        )
        ok = self._completed(0, stdout='{"ok": true, "data": {}}')
        result, error, run, _ = self._run_with([limited, ok])
        self.assertIsNone(error)
        self.assertEqual(result["ok"], True)
        self.assertEqual(run.call_count, 2)

    def test_non_idempotent_create_is_not_retried(self):
        timeouts = [subprocess.TimeoutExpired("lark-cli", 180) for _ in range(3)]
        argv = ["lark-cli", "docs", "+create", "--doc-format", "xml", "--content", "@./r.xml", "--format", "json"]
        result, error, run, sleep = self._run_with(timeouts, argv=argv)
        self.assertIsNone(result)
        self.assertIsInstance(error, LarkError)
        self.assertEqual(error.retryable, True)
        self.assertEqual(run.call_count, 1, "create outcome is unknown; retrying can orphan a second document")
        self.assertEqual(sleep.call_count, 0)

    def test_keyed_notification_is_retried(self):
        fail = self._completed(1, stderr='{"ok": false, "error": {"type": "server_error", "code": 503, "message": "service unavailable"}}')
        ok = self._completed(0, stdout='{"ok": true, "data": {"message_id": "om_1"}}')
        argv = ["lark-cli", "im", "+messages-send", "--idempotency-key", "k-1", "--markdown", "x", "--format", "json"]
        result, error, run, _ = self._run_with([fail, ok], argv=argv)
        self.assertIsNone(error)
        self.assertEqual(result["ok"], True)
        self.assertEqual(run.call_count, 2)
