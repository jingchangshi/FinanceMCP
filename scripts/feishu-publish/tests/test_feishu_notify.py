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


if __name__ == "__main__":
    unittest.main()
