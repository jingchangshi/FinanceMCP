#!/usr/bin/env python3
"""Tests for Feishu IM notification sender and publish_and_notify orchestrator."""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from feishu_notify import (  # noqa: E402
    build_notification_markdown,
    notify,
)
from send_delay_alert import build_delay_alert_markdown, send_delay_alert  # noqa: E402
from feishu_publish import LarkError  # noqa: E402
from feishu_render import check_forbidden, check_internal_tokens, render_xml  # noqa: E402
from publish_and_notify import run_publish_and_notify  # noqa: E402
from test_sections_producer import TestV3CockpitSections  # noqa: E402

_URL_RE = re.compile(r"https?://\S+")


def _base_config(**overrides):
    cfg = {
        "enabled": True,
        "identity": "bot",
        "format": "docx",
        "name_prefix": "A股攻防实战日报",
        "folder_token": "fld-test-001",
        "fallback_to_bot_root_on_permission_error": True,
        "notify_enabled": True,
        "notify_user_id": "ou_test_user_001",
        "notify_fallback_chat_id": "oc_test_chat_001",
    }
    cfg.update(overrides)
    return cfg


class _FakeLarkRunner:
    def __init__(self, *, fail_user_send: bool = False, fail_all_send: bool = False):
        self.calls: list[list[str]] = []
        self.fail_user_send = fail_user_send
        self.fail_all_send = fail_all_send
        self.last_xml = ""

    def __call__(self, argv: list[str], cwd: Path):
        self.calls.append(list(argv))
        domain = argv[1]
        verb = argv[2]
        if domain == "docs" and verb == "+create":
            content_arg = argv[argv.index("--content") + 1]
            self.last_xml = (cwd / content_arg.removeprefix("@./")).read_text(encoding="utf-8")
            return {
                "ok": True,
                "data": {
                    "document": {
                        "document_id": "doc-v3-20261113",
                        "url": "https://my.feishu.cn/docx/doc-v3-20261113",
                    }
                },
            }
        if domain == "docs" and verb == "+update":
            content_arg = argv[argv.index("--content") + 1]
            self.last_xml = (cwd / content_arg.removeprefix("@./")).read_text(encoding="utf-8")
            return {"ok": True, "data": {}}
        if domain == "docs" and verb == "+fetch":
            return {"ok": True, "data": {"document": {"content": self.last_xml}}}
        if domain == "im" and verb == "+messages-send":
            if self.fail_all_send:
                raise RuntimeError("Lark publish failed: permission: all denied")
            if self.fail_user_send and "--user-id" in argv:
                raise RuntimeError("Lark publish failed: im: user dm blocked")
            return {"ok": True, "data": {"message_id": f"om_mock_{len(self.calls)}"}}
        raise AssertionError(f"unexpected lark-cli call: {argv}")


class TestFeishuNotify(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._helper = TestV3CockpitSections()

    def tearDown(self):
        self._tmp.cleanup()

    def test_markdown_summary_clean_for_actionable_hold_and_delayed(self):
        pub_entry = {
            "trade_date": "20261113",
            "document_id": "doc-1",
            "document_url": "https://my.feishu.cn/docx/doc-1",
        }
        for actionable in (True, False):
            bundle = self._helper._v3_bundle(actionable=actionable)
            md, digest = build_notification_markdown(bundle, pub_entry, data_delayed=True)
            self.assertEqual(len(digest), 64)
            vis = _URL_RE.sub("", md)
            self.assertEqual(check_forbidden(vis), [])
            self.assertEqual(check_internal_tokens(vis), [])
            self.assertIn("https://my.feishu.cn/docx/doc-1", md)
            self.assertIn("数据延迟提示", md)
            if actionable:
                self.assertIn("159558.SZ", md)
                self.assertIn("11,000", md)
            else:
                self.assertIn("明日无新增买卖指令", md)

        bundle_floor = self._helper._v3_bundle(actionable=False)
        deconc = bundle_floor["portfolio"]["v3_cockpit"]["deconcentration"]
        deconc["downside_protect_mode"] = "SUPPORT_FLOOR"
        deconc["support_floor_cny"] = 0.78
        deconc["downside_protect_cny"] = 0.78
        md_floor, _ = build_notification_markdown(bundle_floor, pub_entry, data_delayed=False)
        self.assertIn("箱体防守 0.780 元", md_floor)
        self.assertEqual(check_forbidden(_URL_RE.sub("", md_floor)), [])

    def test_idempotency_ledger_skips_same_day_duplicate_and_resends_on_change(self):
        cfg = _base_config()
        bundle = self._helper._v3_bundle(actionable=True)
        pub_entry = {
            "trade_date": "20261113",
            "document_id": "doc-1",
            "document_url": "https://my.feishu.cn/docx/doc-1",
        }
        runner = _FakeLarkRunner()
        first = notify(self.root, bundle, pub_entry, cfg, runner=runner)
        self.assertEqual(first["status"], "sent")
        self.assertEqual(first["recipient_flag"], "--user-id")
        self.assertEqual(len(runner.calls), 1)

        second = notify(self.root, bundle, pub_entry, cfg, runner=runner)
        self.assertEqual(second["status"], "skipped_already_notified")
        self.assertEqual(len(runner.calls), 1)

        bundle_hold = self._helper._v3_bundle(actionable=False)
        third = notify(self.root, bundle_hold, pub_entry, cfg, runner=runner)
        self.assertEqual(third["status"], "sent")
        self.assertEqual(len(runner.calls), 2)

    def test_user_dm_failure_falls_back_to_group_chat_and_all_fail_records_incident(self):
        cfg = _base_config()
        bundle = self._helper._v3_bundle(actionable=True)
        pub_entry = {
            "trade_date": "20261113",
            "document_id": "doc-1",
            "document_url": "https://my.feishu.cn/docx/doc-1",
        }
        runner = _FakeLarkRunner(fail_user_send=True)
        res = notify(self.root, bundle, pub_entry, cfg, runner=runner)
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["recipient_flag"], "--chat-id")
        self.assertEqual(res["recipient_id"], "oc_test_chat_001")
        self.assertEqual(len(runner.calls), 2)

        failing = _FakeLarkRunner(fail_all_send=True)
        with self.assertRaises(RuntimeError):
            notify(self.root, bundle, pub_entry, cfg, force=True, runner=failing)
        incidents = (
            self.root / "data/feishu/account_publish_incidents.jsonl"
        ).read_text(encoding="utf-8")
        self.assertIn("notify_failed", incidents)

    def test_publish_and_notify_orchestrator_end_to_end(self):
        bundle_path = self.root / "VPS-BUNDLE-20261113-test.json"
        bundle_path.write_text(
            json.dumps(
                {"record_id": "VPS-BUNDLE-20261113-test", "payload": self._helper._v3_bundle(actionable=True)},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        runner = _FakeLarkRunner()
        receipt = run_publish_and_notify(
            root=self.root,
            bundle_path=bundle_path,
            config=_base_config(),
            generated_at="17:25",
            runner=runner,
        )
        self.assertEqual(receipt["status"], "ok")
        self.assertEqual(receipt["trade_date"], "20261113")
        self.assertEqual(receipt["publish"]["document_id"], "doc-v3-20261113")
        self.assertEqual(receipt["notify"]["status"], "sent")
        self.assertTrue((self.root / "data/feishu/20261113/sections.json").is_file())
        self.assertTrue((self.root / "data/feishu/20261113/report.xml").is_file())
        self.assertEqual(
            [(c[1], c[2]) for c in runner.calls],
            [("docs", "+create"), ("docs", "+fetch"), ("im", "+messages-send")],
        )
        # Re-running with identical data updates doc cleanly without duplicate IM notification
        receipt2 = run_publish_and_notify(
            root=self.root,
            bundle_path=bundle_path,
            config=_base_config(),
            generated_at="17:26",
            runner=runner,
        )
        self.assertEqual(receipt2["notify"]["status"], "skipped_already_notified")
        self.assertEqual(
            [(c[1], c[2]) for c in runner.calls[3:]],
            [("docs", "+update"), ("docs", "+fetch")],
        )

    def test_delay_alert_markdown_is_clean_chinese_and_sends_with_idempotency_key(self):
        md = build_delay_alert_markdown("20261118", status="exit_1", attempt=3, deadline_hm="2115")
        self.assertEqual(check_forbidden(md), [])
        self.assertEqual(check_internal_tokens(md), [])
        self.assertIn("2026-11-18", md)
        self.assertIn("21:15", md)

        cfg = _base_config()
        runner = _FakeLarkRunner()
        res = send_delay_alert(
            self.root,
            cfg,
            trade_date="20261118",
            status="exit_1",
            attempt=3,
            deadline_hm="2115",
            runner=runner,
        )
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["recipient_flag"], "--user-id")
        self.assertEqual(len(runner.calls), 1)
        call = runner.calls[0]
        self.assertEqual(call[call.index("--idempotency-key") + 1], "ashare-delay-alert-20261118")

        disabled = send_delay_alert(
            self.root,
            _base_config(notify_enabled=False),
            trade_date="20261118",
            status="NOT_READY",
            attempt=3,
            deadline_hm="2115",
            runner=runner,
        )
        self.assertEqual(disabled["status"], "disabled")
        self.assertEqual(len(runner.calls), 1)


    def test_delayed_banner_renders_the_configured_deadline(self):
        pub_entry = {
            "trade_date": "20261113",
            "document_id": "doc-1",
            "document_url": "https://my.feishu.cn/docx/doc-1",
        }
        bundle = self._helper._v3_bundle(actionable=False)
        md, _ = build_notification_markdown(bundle, pub_entry, data_delayed=True, deadline_hm="2230")
        self.assertIn("截至 22:30", md)
        self.assertNotIn("21:15", md)
        md_default, _ = build_notification_markdown(bundle, pub_entry, data_delayed=True)
        self.assertIn("截至 21:15", md_default)

    def test_orchestrator_passes_the_deadline_to_the_im_banner(self):
        bundle_path = self.root / "VPS-BUNDLE-20261113-deadline.json"
        bundle_path.write_text(
            json.dumps(
                {"record_id": "VPS-BUNDLE-20261113-deadline", "payload": self._helper._v3_bundle(actionable=False)},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        runner = _FakeLarkRunner()
        receipt = run_publish_and_notify(
            root=self.root,
            bundle_path=bundle_path,
            config=_base_config(),
            generated_at="17:25",
            data_delayed=True,
            deadline_hm="2230",
            runner=runner,
        )
        self.assertEqual(receipt["status"], "ok")
        marks = [argv[argv.index("--markdown") + 1] for argv in runner.calls if "--markdown" in argv]
        self.assertTrue(marks)
        self.assertIn("截至 22:30", marks[0])

    def test_private_message_timeout_does_not_fall_back_to_group(self):
        """A timeout may mean the user already got the message; a group copy would duplicate it."""
        cfg = _base_config()
        bundle = self._helper._v3_bundle(actionable=True)
        pub_entry = {
            "trade_date": "20261113",
            "document_id": "doc-1",
            "document_url": "https://my.feishu.cn/docx/doc-1",
        }

        class TimeoutRunner:
            def __init__(self):
                self.calls = []

            def __call__(self, argv, cwd):
                self.calls.append(list(argv))
                raise LarkError("Lark publish failed: request timed out", retryable=True)

        runner = TimeoutRunner()
        with self.assertRaises(RuntimeError):
            notify(self.root, bundle, pub_entry, cfg, runner=runner)
        self.assertEqual(len(runner.calls), 1, "must not send the group fallback after a timeout")
        self.assertIn("--user-id", runner.calls[0])
        incidents = (
            self.root / "data/feishu/account_publish_incidents.jsonl"
        ).read_text(encoding="utf-8")
        self.assertIn("notify_failed", incidents)

    def test_explicit_4xx_permission_rejection_still_falls_back_to_group(self):
        cfg = _base_config()
        bundle = self._helper._v3_bundle(actionable=True)
        pub_entry = {
            "trade_date": "20261113",
            "document_id": "doc-1",
            "document_url": "https://my.feishu.cn/docx/doc-1",
        }

        class PermissionThenGroup:
            def __init__(self):
                self.calls = []

            def __call__(self, argv, cwd):
                self.calls.append(list(argv))
                if "--user-id" in argv:
                    raise LarkError("Lark publish failed: permission forbidden", retryable=False, status=403)
                return {"ok": True, "data": {"message_id": "om_group_ok"}}

        runner = PermissionThenGroup()
        res = notify(self.root, bundle, pub_entry, cfg, runner=runner)
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["recipient_flag"], "--chat-id")
        self.assertEqual(len(runner.calls), 2)


if __name__ == "__main__":
    unittest.main()
