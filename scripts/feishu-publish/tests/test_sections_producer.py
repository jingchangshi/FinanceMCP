#!/usr/bin/env python3
"""Producer regressions for evidence-driven conclusions and scenario rendering.

Covers the section builder's decision boundary:
- All engine-computed alternatives stay visible, including defensive and wait.
- A ranked stock/ETF candidate is never promoted without a funded engine plan.
- An unverified rotation remains explicitly unverified.
- Market reasons survive the holdings loop; no-action does not imply HOLD is best.
- Missing-data descriptions reflect the payload rather than stale fixed claims.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from feishu_render import check_forbidden, render_xml, strip_tags, validate_sections  # noqa: E402
from sections_from_bundle import build_sections  # noqa: E402


def minimal_bundle(**overrides):
    """A small frozen-bundle payload with the fields the producer reads."""
    bundle = {
        "as_of_trade_date": "20261106",
        "account_verification": {"summary_status": "DEGRADED"},
        "portfolio": {
            "account_view": {
                "revalued_basis": {
                    "total_assets_cents": 6899233,
                    "cash_cents": 141370,
                    "wealth_cents": 33,
                    "securities_mv_cents": 6757830,
                }
            },
            "gate": {"last_user_reconciled_at": "20261022T14:34:31Z"},
            "holdings": [
                {
                    "ts_code": "159558.SZ",
                    "name": "半导体设备ETF 易方达",
                    "weight": 0.6975,
                    "stance": "HOLD",
                    "reasons": ["当日收盘 0.817 元"],
                    "counter_evidence": ["集中度高"],
                    "research": {"quote": {"close_cny": 0.817}, "conditions": []},
                }
            ],
            "decision_comparison": {
                "focus": {"ts_code": "159558.SZ", "name": "半导体设备ETF 易方达", "weight": 0.6975},
                "options": [
                    {"action": "HOLD", "label": "继续持有，不交易", "executable": False},
                    {"action": "REDUCE", "label": "显式数量减仓研究", "executable": False},
                    {
                        "action": "ROTATE",
                        "label": "显式数量轮动研究",
                        "executable": False,
                        "alpha_track": {"evidence_verified": False, "status": "NOT_SUPPLIED"},
                    },
                    {"action": "DEFENSIVE", "label": "权益清零压力对照", "executable": False},
                    {"action": "NO_ACTION", "label": "没有充分证据时不操作", "executable": False},
                ],
            },
            "expected_next_trade_date": "20261109",
        },
        "portfolio_risk": {
            "drawdown": {
                "current_drawdown_pct": 8.95,
                "max_drawdown_pct": 20.25,
                "window": {"start": "20261016", "end": "20261106"},
            },
            "warning": {"triggered": False},
            "policy": {"tiers": [{"level": "L1", "drawdown_pct": 10}], "approved_on": "2026-10-22"},
        },
        "market": {
            "breadth": {"up": 758, "down": 4741, "amount_yi": 16716, "amount_chg_pct": -21.7},
            "regime_label": "弱势",
        },
        "watchlist": {
            "focused_candidates": [
                {"name": "贵州茅台", "industry": "白酒", "rank": 1, "score": 88.4, "status": "kept"},
                {"name": "今世缘", "industry": "白酒", "rank": 2, "score": 86.91, "status": "kept"},
            ]
        },
        "etf_candidates": {
            "data_coverage": {"status": "DEGRADED"},
            "candidates": [
                {"ts_code": "159558.SZ", "name": "半导体设备ETF 易方达", "held": True, "status": "READY"},
                {"ts_code": "511990.SH", "name": "华宝现金添益货币ETF-A", "held": False, "status": "DEGRADED", "score": 0.999},
            ],
        },
        "evidence_gaps": [{"module": "account_completeness", "reason": "unreported_trade_risk", "affected": ["executable_quantities"]}],
        "status": "READY",
        "judgement": {},
    }
    bundle.update(overrides)
    return bundle


def options_of(bundle):
    sections = build_sections(bundle, generated_at="2026-11-09 08:00")
    return sections, (sections["sections"]["是否存在更好的选择"]["options"] or [])


class TestSectionFiveOptions(unittest.TestCase):
    def test_all_engine_scenarios_are_visible(self):
        options = options_of(minimal_bundle())[1]
        self.assertEqual(len(options), 5)
        text = "".join(opt["name"] for opt in options)
        self.assertIn("继续持有", text)
        self.assertIn("减仓", text)
        self.assertIn("轮动", text)
        self.assertIn("权益清零", text)
        self.assertIn("不操作", text)

    def test_ranked_alternatives_are_not_guessed_as_rotation_targets(self):
        options = options_of(minimal_bundle())[1]
        rotate = next(opt for opt in options if "轮动" in opt["name"])
        self.assertIn("未形成满足资金条件", rotate["cost"])
        self.assertIn("尚未经独立验证", rotate["gap"])
        blob = "".join(f"{o['name']}{o['upside']}{o['cost']}{o['gap']}" for o in options)
        for ranked_candidate in ("贵州茅台", "今世缘", "华宝现金添益货币ETF-A"):
            self.assertNotIn(ranked_candidate, blob)
        self.assertNotIn("88.4", blob)
        self.assertNotIn("0.999", blob)

    def test_verified_rotation_drops_unverified_evidence_blocker(self):
        bundle = minimal_bundle()
        bundle["portfolio"]["decision_comparison"]["options"][2]["alpha_track"] = {
            "evidence_verified": True,
            "status": "SUPPLIED",
        }
        options = options_of(bundle)[1]
        rotate = next(opt for opt in options if "轮动" in opt["name"])
        self.assertNotIn("未经独立验证", rotate["gap"])

    def test_no_decision_comparison_falls_back_to_empty(self):
        bundle = minimal_bundle()
        bundle["portfolio"]["decision_comparison"] = {}
        options = options_of(bundle)[1]
        self.assertEqual(options, [])
        # Renderer fallback line still validates + renders.
        sections = build_sections(bundle, generated_at="2026-11-09 08:00")
        self.assertEqual(validate_sections(sections), [])
        xml = render_xml(sections)
        self.assertIn("本日未发现有足够证据支持调整的替代方案", xml)

    def test_full_sections_stay_valid_with_options(self):
        sections, options = options_of(minimal_bundle())
        self.assertEqual(len(options), 5)
        self.assertEqual(validate_sections(sections), [])
        self.assertEqual(check_forbidden(strip_tags(render_xml(sections))), [])

    def test_market_reasons_are_not_replaced_by_last_holding(self):
        bundle = minimal_bundle()
        bundle["portfolio"]["holdings"].append({
            "ts_code": "560390.SH", "name": "ETF-B", "weight": 0.1,
            "stance": "HOLD", "reasons": ["最后一只持仓的专属理由"],
            "counter_evidence": [], "research": {},
        })
        sections = build_sections(bundle)
        reasons = sections["sections"]["今日判断"]["reasons"]
        self.assertTrue(any(reason.startswith("市场广度") for reason in reasons))
        self.assertNotIn("最后一只持仓的专属理由", reasons)

    def test_no_trade_does_not_claim_holdings_are_best(self):
        bundle = minimal_bundle()
        bundle["research_stance"] = "HOLD_OBSERVE"
        bundle["portfolio"]["first_section"] = {
            "actions": [], "no_action_reason": "没有达到既有证据门槛的交易计划",
        }
        sections = build_sections(bundle)
        conclusion = sections["sections"]["今日判断"]["conclusion"]
        self.assertIn("首选为等待条件复核", conclusion)
        self.assertIn("不代表当前持仓已被证明最优", conclusion)
        self.assertNotIn("维持当前持仓观察", conclusion)

    def test_preferred_engine_plan_drives_the_conclusion(self):
        bundle = minimal_bundle()
        bundle["research_stance"] = "RELATIVE_ADVANTAGE"
        bundle["portfolio"]["first_section"] = {
            "actions": [{"code": "REDUCE-159558", "title": "降低集中暴露", "reasons": ["风险政策触发复核"]}],
        }
        sections = build_sections(bundle)
        conclusion = sections["sections"]["今日判断"]["conclusion"]
        self.assertIn("降低集中暴露", conclusion)
        self.assertIn("风险政策触发复核", conclusion)

    def test_missing_data_copy_reflects_payload(self):
        bundle = minimal_bundle()
        bundle["portfolio"]["gate"] = {"reported_events_through": "20261106", "last_user_reconciled_at": None}
        sections = build_sections(bundle)
        items = sections["sections"]["三项主要证据"]["items"]
        self.assertIn("前20个交易日成交额均值", items[0]["missing"])
        self.assertIn("不代表没有相关事件", items[1]["missing"])
        self.assertIn("用户声明与券商实际对账", items[2]["missing"])


if __name__ == "__main__":
    unittest.main()
