#!/usr/bin/env python3
"""Producer tests: frozen bundle -> §5 options (goal-1109 A10/A19).

Covers the section-5 population in sections_from_bundle.build_sections:
- HOLD / REDUCE / ROTATE from decision_comparison are the only three
  investor-facing comparisons (DEFENSIVE / NO_ACTION stay in audit).
- ROTATE names one top-screened stock + one top non-held ETF qualitatively
  (no score figures, no ranked list, no pool dump).
- An unverified rotation advantage is labelled "不构成买入建议" (A10:
  never force rotation); a degraded ETF screen discloses its coverage gap.
- No decision_comparison at all -> options [] (renderer fallback), no crash.
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
    def test_three_compared_schemes_only(self):
        actions_names = [opt["name"] for opt in options_of(minimal_bundle())[1]]
        self.assertEqual(len(actions_names), 3)
        text = "".join(actions_names)
        self.assertIn("维持", text)
        self.assertIn("降低集中度", text)
        self.assertIn("轮动", text)
        self.assertNotIn("权益清零", text)
        self.assertNotIn("不操作", text)

    def test_unverified_rotation_is_never_a_recommendation(self):
        _, options = options_of(minimal_bundle())
        rotate = options[-1]
        self.assertIn("贵州茅台", rotate["upside"])
        self.assertIn("华宝现金添益货币ETF-A", rotate["upside"])
        self.assertIn("不构成买入建议", rotate["upside"])
        self.assertIn("不作推荐", rotate["gap"])
        self.assertIn("覆盖不全", rotate["gap"])
        # No scores, no ranks, no pool dump anywhere in the option text.
        blob = "".join(f"{o['name']}{o['upside']}{o['cost']}{o['gap']}" for o in options)
        self.assertNotIn("88.4", blob)
        self.assertNotIn("0.999", blob)
        self.assertNotIn("排名 1", blob)
        self.assertNotIn("今世缘", blob)

    def test_verified_rotation_drops_caution_label(self):
        bundle = minimal_bundle()
        bundle["portfolio"]["decision_comparison"]["options"][2]["alpha_track"] = {
            "evidence_verified": True,
            "status": "SUPPLIED",
        }
        options = options_of(bundle)[1]
        self.assertNotIn("不构成买入建议", options[-1]["upside"])

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
        self.assertEqual(len(options), 3)
        self.assertEqual(validate_sections(sections), [])
        self.assertEqual(check_forbidden(strip_tags(render_xml(sections))), [])


if __name__ == "__main__":
    unittest.main()
