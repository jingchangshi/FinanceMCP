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


class HumanizeTests(unittest.TestCase):
    def test_cents_amount_becomes_yuan(self):
        from sections_from_bundle import humanize_text
        self.assertEqual(humanize_text("现有现金154447分"), "现有现金1,544.47 元")
        self.assertEqual(humanize_text("需 20 分钟，百分点 5分"), "需 20 分钟，百分点 5分")

    def test_internal_tokens_are_translated(self):
        from sections_from_bundle import humanize_text
        out = humanize_text("cash_plan:NOT_PROVIDED；unreported_trade_risk: 风险；见 market_judgement.counter_evidence；UNVERIFIED")
        for bad in ("cash_plan", "unreported", "market_judgement", "UNVERIFIED", "NOT_PROVIDED"):
            self.assertNotIn(bad, out)

    def test_leftover_snake_case_is_removed(self):
        from sections_from_bundle import humanize_text
        self.assertNotIn("some_internal_field", humanize_text("x some_internal_field y"))

    def test_dedupe_lifts_repeated_sentences_but_keeps_numbers(self):
        from sections_from_bundle import dedupe_option_fragments
        shared_text = "卖出或换仓可能放弃后续上涨，并产生费用。"
        opts = [{"name": str(i), "upside": "u", "cost": f"{shared_text}；方案后现金 {i} 元", "gap": "g"} for i in range(4)]
        out, shared = dedupe_option_fragments(opts)
        self.assertEqual(shared, [shared_text])
        for i, o in enumerate(out):
            self.assertNotIn(shared_text, o["cost"])
            self.assertIn(f"方案后现金 {i} 元", o["cost"])

    def test_window_drawdown_crossing_is_disclosed(self):
        bundle = minimal_bundle()
        bundle["portfolio_risk"] = {
            "drawdown": {"current_drawdown_pct": 9.17, "max_drawdown_pct": 20.25},
            "policy": {"tiers": [{"level": "L1", "drawdown_pct": 10}, {"level": "L3", "drawdown_pct": 20}]},
            "warning": {"triggered": False},
        }
        sections = build_sections(bundle)
        self.assertIn("曾触及 L3 档", sections["sections"]["账户与风险"]["narrative"])
        self.assertEqual(validate_sections(sections), [])


class InternalTokenGuardTests(unittest.TestCase):
    def test_validator_rejects_snake_case_in_body(self):
        from feishu_render import check_internal_tokens
        self.assertEqual(check_internal_tokens("正常文字 cash_plan 与 NOT_PROVIDED"), ["NOT_PROVIDED", "cash_plan"])
        self.assertEqual(check_internal_tokens("159558.SZ 收盘 0.812 元，L1 档"), [])


class TestV3CockpitSections(unittest.TestCase):
    def _v3_bundle(self, *, actionable: bool = False):
        bundle = minimal_bundle()
        bundle["as_of_trade_date"] = "20261113"
        bundle["portfolio"]["expected_next_trade_date"] = "20261116"
        bundle["portfolio"]["gate"] = {
            "satisfied": True,
            "reported_events_through": "20261103",
            "last_user_reconciled_at": "2026-10-16T15:00:00+08:00",
            "unreported_trade_risk": True,
        }
        actions = []
        if actionable:
            actions = [{
                "priority": "P2",
                "code": "P2-DECONCENTRATE-159558",
                "kind": "REDUCE",
                "title": "执行 159558.SZ 四批换马（第1批）：卖出 11000 份",
                "reasons": ["收盘 0.885 元已达到自基准价反弹 +8% 目标（0.885 元），按计划减持 11000 份。"],
                "legs": [{
                    "side": "SELL",
                    "ts_code": "159558.SZ",
                    "name": "半导体设备ETF易方达",
                    "quantity": 11000,
                    "lot_size": 100,
                    "lots": 110,
                    "price_milli": 885,
                    "gross_cents": 973500,
                    "fees_cents": 500,
                    "net_cents": 973000,
                    "quote_trade_date": "20261113",
                    "executable": True,
                    "reason": "P2_REBOUND_8PCT",
                }],
                "fees_cents": 500,
            }]
        bundle["portfolio"]["actionable"] = bool(actions)
        bundle["portfolio"]["first_section"] = {"actions": actions, "observation_triggers": []}
        bundle["portfolio"]["v3_cockpit"] = {
            "schema": "v3-offensive-cockpit/1.0",
            "as_of_trade_date": "20261113",
            "principal": {
                "initial_principal_cents": 10000000,
                "current_nav_cents": 6860690,
                "to_principal_gap_cents": 3139310,
                "to_principal_return_needed_pct": 45.76,
                "loss_from_principal_pct": 31.39,
            },
            "market_regime": {
                "regime": "OFFENSIVE",
                "regime_label_zh": "进攻档（85%目标权益）",
                "raw_regime": "OFFENSIVE",
                "hysteresis_held": False,
                "crash_override": False,
                "style": "GROWTH_LEADING",
                "style_label_zh": "成长占优",
                "style_spread_20d_pp": 3.45,
                "target_equity_bps": 8500,
                "defensive_cash_bps": 1500,
                "target_equity_pct": 85,
                "defensive_cash_pct": 15,
                "pct_above_ma60": 0.62,
                "amount_vs_ma20": 1.15,
                "limit_down": 12,
                "hs300_above_ma60": True,
                "zz500_above_ma60": True,
                "cyb_above_ma60": True,
            },
            "router": {
                "effective_regime": "OFFENSIVE",
                "circuit_breaker_status": "NORMAL",
                "circuit_breaker_label_zh": "正常运作",
                "locked_until_trade_date": None,
                "hwm_nav_cents": 6860690,
                "hwm_date": "20261113",
                "hwm_drawdown_pct": 0.0,
                "lifeline_nav_cents": 5831587,
                "lifeline_buffer_cents": 1029103,
                "lifeline_buffer_pct": 15.0,
                "sub_strategies": {
                    "s_deconcentrate": "ACTIVE",
                    "s_base_super_etf": "ACTIVE",
                    "s_stock_swing": "LOCKED_PENDING_VALIDATION",
                },
                "sub_strategies_zh": {
                    "deconcentrate_label": "四批换马进行中",
                    "base_etf_label": "超级ETF配置运行中",
                    "stock_swing_label": "待第二阶段回测实验验证解锁",
                },
            },
            "deconcentration": {
                "plan_present": True,
                "ts_code": "159558.SZ",
                "plan_status": "ACTIVE",
                "initial_shares": 58900,
                "current_shares": 58900,
                "target_keep_bps": 1800,
                "target_keep_shares": 15000,
                "reference_price_cny": 0.819,
                "rebound_trigger_cny": 0.885,
                "ma60_cny": 0.84,
                "ma60_protect_cny": 0.827,
                "breakdown_ma60_2d": False,
                "next_monthly_trigger_date": "20261201",
                "recommended_sell_shares": 11000 if actionable else 0,
                "active_trigger_reason": "REBOUND_8PCT" if actionable else None,
                "tranches": [
                    {"tranche_no": 1, "planned_shares": 11000, "status": "TRIGGERED" if actionable else "PENDING"},
                    {"tranche_no": 2, "planned_shares": 11000, "status": "PENDING"},
                    {"tranche_no": 3, "planned_shares": 11000, "status": "PENDING"},
                    {"tranche_no": 4, "planned_shares": 10900, "status": "PENDING"},
                ],
                "status_summary_zh": "159558.SZ 四批换马已执行 0/4 批；下一观察条件：月度窗口 20261201 或反弹至 0.885 元。",
            },
            "reconciliation_reminder": {
                "lag_trade_days": 8,
                "needs_reminder": True,
                "message_zh": "提示：距离最近一次账本流水声明（20261103）已过 8 个交易日，若期间有手工成交请先补录再核对委托份数。",
            },
            "super_etf_candidates": [
                {
                    "ts_code": "159205.SZ",
                    "name": "科创创业50ETF",
                    "close_cny": 1.125,
                    "premium_pct": 0.12,
                    "fee_label_zh": "东财超级ETF（万分之0.5佣金，免5元低消）",
                    "style_match_zh": "契合当前成长占优风格",
                }
            ],
            "cross_border_monitor": [
                {
                    "ts_code": "513100.SH",
                    "name": "纳指ETF",
                    "unit_nav": 1.600,
                    "premium_pct": 3.12,
                    "buy_blocked": True,
                    "status_zh": "已拦截禁买（溢价 3.12% 高于 +2.5% 红线）",
                }
            ],
            "actions_summary": actions,
        }
        return bundle

    def test_v3_cockpit_actionable_and_hold_render_clean_xml(self):
        from feishu_render import check_forbidden, check_internal_tokens, check_markdown_leak, render_xml, strip_tags

        for actionable in (False, True):
            sections = build_sections(self._v3_bundle(actionable=actionable), generated_at="2026-11-13 18:00")
            self.assertEqual(validate_sections(sections), [], f"actionable={actionable}")
            xml = render_xml(sections)
            vis = strip_tags(xml)
            self.assertEqual(check_forbidden(vis), [])
            self.assertEqual(check_internal_tokens(vis), [])
            self.assertEqual(check_markdown_leak(vis), [])
            self.assertIn("100,000.00 元", vis)
            self.assertIn("159558.SZ", vis)
            self.assertIn("纳指ETF", vis)
            self.assertIn("已拦截禁买", vis)
            if actionable:
                self.assertIn("11000 份", vis)
                self.assertIn("已按规则生成可执行份数", sections["sections"]["今日判断"]["execution_note"])
            else:
                self.assertIn("已过 8 个交易日", sections["sections"]["账户与风险"]["narrative"])

    def test_v3_cockpit_phase3_stock_swing_and_preemptive_l2(self):
        from feishu_render import check_forbidden, check_internal_tokens, check_markdown_leak, render_xml, strip_tags

        bundle = self._v3_bundle(actionable=False)
        cockpit = bundle["portfolio"]["v3_cockpit"]
        cockpit["router"]["deconcentration_preemptive_active"] = True
        cockpit["router"]["l2_trigger_drawdown_bps"] = 1200
        cockpit["deconcentration"]["downside_protect_mode"] = "SUPPORT_FLOOR"
        cockpit["deconcentration"]["support_floor_cny"] = 0.78
        cockpit["deconcentration"]["downside_protect_cny"] = 0.78
        cockpit["router"]["sub_strategies"]["s_stock_swing"] = "ACTIVE"
        cockpit["router"]["sub_strategies_zh"]["stock_swing_label"] = "先锋主板强势股波段：强势股缩量回踩20日线买点已解锁运行"
        cockpit["stock_swing_candidates"] = [
            {
                "ts_code": "601001.SH",
                "name": "优质主板回踩",
                "industry": "电子化学品",
                "entry_ref_price_cny": 20.35,
                "max_chase_price_cny": 20.76,
                "hard_stop_price_cny": 19.33,
                "stop_loss_pct": -5.01,
                "reasons_zh": ["相对强度百分位达 92.5", "缩量回踩 20 日均线企稳收阳"],
            }
        ]
        sections = build_sections(bundle, generated_at="2026-11-15 16:30")
        self.assertEqual(validate_sections(sections), [])
        xml = render_xml(sections)
        vis = strip_tags(xml)
        self.assertEqual(check_forbidden(vis), [])
        self.assertEqual(check_internal_tokens(vis), [])
        self.assertEqual(check_markdown_leak(vis), [])
        self.assertIn("优质主板回踩", vis)
        self.assertIn("601001.SH", vis)
        self.assertIn("12% 前置熔断清零高波动权益", vis)
        self.assertIn("磨底箱体防守位 0.780 元", vis)
