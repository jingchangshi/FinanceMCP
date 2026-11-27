import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const FIXTURE_PATH = '/home/jcshi/workspace/AShareInvestor/docs/v3-offensive-system/conformance/parity_fixtures_v340.json';
const RELEASE_V340_PATH = '/home/jcshi/workspace/AShareInvestor/docs/v3-offensive-system/fee-profiles/v3_offensive_policy_release_v3.4.0.json';
const EXPECTED_V340_HASH = 'de6879a2ea178453a7772bd51dbf0e4418380ff7d4f8f4bfd4d4904c9f128ebb';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v340-parity-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { ETF_CANDIDATE_DECLARATIONS } = await import('../build/ashare/etfDeclarations.js');
const { evaluateB1EnvelopeStep, B1_STATE_LABELS_ZH } = await import('../build/ashare/fundamentalRegime.js');
const { evaluateQualityCoreV2 } = await import('../build/ashare/qualityCore.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');

function canonicalJson(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
function computeReleaseHash(release) {
  const { content_hash: _drop, ...payload } = release;
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
const { loadApprovedV3Policy, validateV340Parameters, findForbiddenB2Keys } = await import('../build/portfolio/v3Policy.js');
const { evaluateStrategyRouter, persistRiskAnchor } = await import('../build/portfolio/strategyRouter.js');
const { runActionEngine } = await import('../build/portfolio/actionEngine.js');
const { isEtfCode } = await import('../build/portfolio/ledger.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const DECL_BY_CODE = new Map(ETF_CANDIDATE_DECLARATIONS.map(d => [d.ts_code, d]));
const BOND_SET = new Set(['159649.SZ', '511260.SH', '511010.SH']);

function makeRegime(asOf, regime = 'DEFENSIVE', style = 'BALANCED', opts = {}) {
  const map = {
    OFFENSIVE: { bps: 8500, label: '全面进攻档（目标总仓位 85%）' },
    STRUCTURAL: { bps: 6000, label: '震荡结构档（目标总仓位 60%）' },
    RECOVERY: { bps: 4000, label: '冰点复苏试探档（目标总仓位 40%）' },
    ICE_10: { bps: 3500, label: '冰点阻尼防守档（目标总仓位 35%）' },
    DEFENSIVE: { bps: 2500, label: '空头防守档（目标总仓位 25%）' },
  };
  const pctAboveMa60 = opts.pctAboveMa60 ?? 0.3;
  const iceDays = Number(opts.ice10RemainingDays ?? 0);
  return {
    schema: 'ashare-market-regime/1.0',
    as_of_trade_date: asOf,
    available: true,
    regime,
    raw_regime: regime,
    target_equity_bps: map[regime].bps,
    target_equity_pct: map[regime].bps / 100,
    hysteresis_held: false,
    crash_override: false,
    style,
    style_spread_20d_pct: style === 'GROWTH_LEADING' ? 4.0 : style === 'VALUE_LEADING' ? -4.0 : 0.0,
    value_anchor: { ts_code: '000300.SH', close: 3800, ma20: 3750, ma20_prev5: 3720, ma60: 3700, pct_chg: 0.2, ret20_pct: 1.5, state: 'RANGE', bars_available: 120 },
    growth_anchor: {
      csi500: { ts_code: '000905.SH', close: 5500, ma20: 5450, ma20_prev5: 5400, ma60: 5350, pct_chg: 0.3, ret20_pct: 2.0, state: 'RANGE', bars_available: 120 },
      chinext: { ts_code: '399006.SZ', close: 2100, ma20: 2080, ma20_prev5: 2050, ma60: 2000, pct_chg: 0.3, ret20_pct: 2.0, state: 'RANGE', bars_available: 120 },
      synthesized_state: 'RANGE',
      ret20_pct: 2.0,
      pct_chg: 0.3,
    },
    breadth: { pct_above_ma60: pctAboveMa60, pct_above_ma60_pct: pctAboveMa60 * 100, amount_yi: 8000, amount_ma20_yi: 7500, amount_vs_ma20: 1.07, up: 2500, down: 2300, limit_down: 5 },
    ice10_active: regime === 'DEFENSIVE' && iceDays > 0,
    ice10_remaining_days: iceDays,
    history: [],
    regime_label_zh: map[regime].label,
    style_label_zh: style === 'GROWTH_LEADING' ? '成长风格占优' : style === 'VALUE_LEADING' ? '价值红利占优' : '大小盘均衡',
    summary_zh: '',
    notes: [],
  };
}

function makeFundamentalRegime(asOf, fInput) {
  const prevState = fInput?.prev_b1_state ?? 'NEUTRAL';
  const erpPct = fInput?.erp_pct_756 ?? null;
  const bpPct = fInput?.bp_pct_756 ?? null;
  const b1State = evaluateB1EnvelopeStep(erpPct, bpPct, prevState);
  return {
    available: erpPct !== null && bpPct !== null,
    as_of_trade_date: asOf,
    b1_state: b1State,
    b1_state_label_zh: B1_STATE_LABELS_ZH[b1State],
    erp_pct_756: erpPct,
    bp_pct_756: bpPct,
    ep_median_bps: 700,
    bp_median_bps: 6500,
    erp_bps: 450,
    dv_lowvol_bps: 450,
    edi_bps: 800,
    cgb_1y_bps: 150,
    cgb_10y_bps: 220,
    term_spread_bps: 70,
    stale_fallback_days: 0,
    warning: null,
    summary_zh: B1_STATE_LABELS_ZH[b1State],
  };
}

function buildCandidateRow(code, info, asOf) {
  const decl = DECL_BY_CODE.get(code);
  const category = BOND_SET.has(code) ? 'bond' : (decl?.category ?? 'broad_based');
  const priceMilli = Math.round(Number(info.price) * 1000);
  const buyBlocked = Boolean(info.buy_blocked);
  return {
    rank: 1,
    ts_code: code,
    category,
    category_label: category,
    name: decl?.name ?? code,
    name_source: 'declaration',
    held: false,
    included: true,
    eligibility: 'eligible',
    status: 'OK',
    status_reasons: [],
    as_of_trade_date: asOf,
    filters: {
      premium_discount: {
        state: buyBlocked ? 'block' : 'pass',
        detail: '',
        value_pct: 0.1,
        premium_bps: 10,
        unit_nav: Number(info.price),
        nav_date: asOf,
        lag_trade_days: 0,
        nav_stale: false,
        buy_blocked: buyBlocked,
      },
    },
    data: {
      bars_used: 60,
      latest_bar_date: asOf,
      latest_close_milli: priceMilli,
      price_basis: 'qfq_adjusted',
      adj_base: null,
      adj_missing_bars: 0,
      share: { fd_share_wan: 100_000, trade_date: asOf },
      size_wan_cny: 10_000_000,
      unit_nav: Number(info.price),
      nav_date: asOf,
      premium_bps: 10,
      nav_stale: false,
      buy_blocked: buyBlocked,
      coverage: {
        fund_basic: true, fund_daily: true, fund_adj: true, fund_share: true, fund_nav: true, latest_trade_date: asOf,
      },
    },
    exclusions: [],
    score: 0.5,
    score_components: {},
    source: 'server_cache',
    research: {},
  };
}

test('v3.4.0 signed release JSON passes strict schema validation and rejects any B2 / style_tilt keys', t => {
  if (!existsSync(RELEASE_V340_PATH)) {
    t.skip(`Release v3.4.0 JSON missing at ${RELEASE_V340_PATH}`);
    return;
  }
  const release = JSON.parse(readFileSync(RELEASE_V340_PATH, 'utf8'));
  assert.equal(release.content_hash, EXPECTED_V340_HASH);
  assert.deepEqual(validateV340Parameters(release.parameters), []);
  assert.deepEqual(findForbiddenB2Keys(release.parameters), []);

  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = RELEASE_V340_PATH;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = release.content_hash;

  const policy = loadApprovedV3Policy({ asOf: '20261130' });
  assert.equal(policy.version, 'v3.4.0');
  assert.equal(policy.content_hash, EXPECTED_V340_HASH);
  assert.deepEqual(policy.override_diagnostics, []);
  assert.equal(policy.runtime_can_open, true);
  assert.equal(policy.lowvol_core_mode, 'CORE_40');
  assert.equal(policy.gold_core_etf, '518880.SH');
  assert.equal(policy.gold_core_share_bps, 1000);
  assert.equal(policy.gold_core_drift_band_bps, 400);
  assert.equal(policy.align_trigger_mode, 'REGIME_ONLY');
  assert.equal(policy.quality_core_version, 'v2');
  assert.equal(policy.stock_bp1_reverify_nav_cny, 95000);
  assert.equal(policy.fvo_enabled, true);
  assert.equal(policy.fvo_scalar_only, true);

  // Inject forbidden B2 / style_tilt / legacy M2 early-release keys -> must reject & block buys
  for (const badKey of ['implied_expectation_tilt', 'b2_macro_tilt', 'style_tilt', 'l2_lock_allow_m2_early_release']) {
    const mutated = structuredClone(release);
    mutated.parameters[badKey] = 'true';
    mutated.content_hash = computeReleaseHash(mutated);
    const badPath = join(dir, `bad-${badKey}.json`);
    writeFileSync(badPath, JSON.stringify(mutated));
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = badPath;
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = mutated.content_hash;
    const rejected = loadApprovedV3Policy({ asOf: '20261130' });
    assert.equal(rejected.runtime_can_open, false, `must block buys when ${badKey} present`);
    assert.ok(rejected.override_diagnostics.some(d => d.includes(badKey) || d.includes('forbidden_b2') || d.includes('unsupported_param')));
  }
});

test('all 12 parity_fixtures_v340.json scenarios match FinanceMCP runActionEngine (S01..S12)', t => {
  if (!existsSync(FIXTURE_PATH) || !existsSync(RELEASE_V340_PATH)) {
    t.skip('Cross-repo v3.4.0 parity fixtures or release JSON not present');
    return;
  }
  const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const release = JSON.parse(readFileSync(RELEASE_V340_PATH, 'utf8'));
  assert.equal(fixtures.policy_content_hash, release.content_hash);
  assert.equal(fixtures.scenarios.length, 12);

  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = RELEASE_V340_PATH;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = release.content_hash;

  const baseDays = weekdays('20261102', 30);
  const marketDb = openAshareDb(join(dir, 'v340-parity-market.sqlite'));
  upsertRows(marketDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], baseDays.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: baseDays[i - 1] ?? null,
  })));

  const tolBps = Number(fixtures.tolerances?.target_weight_bps ?? 50);
  let seq = 0;

  for (const sc of fixtures.scenarios) {
    seq += 1;
    const pdb = openPortfolioDb(join(dir, `v340-parity-${seq}.sqlite`), { marketPath: join(dir, `v340-parity-m-${seq}.sqlite`) });
    const policy = loadApprovedV3Policy({ asOf: sc.as_of });
    const dd = sc.drawdown;

    if (dd.circuit_breaker_status !== 'NORMAL' && (dd.work_peak_nav_cny > sc.investable_nav_cny || dd.true_peak_nav_cny > sc.investable_nav_cny)) {
      const peakCents = Math.round(Math.max(dd.work_peak_nav_cny, dd.true_peak_nav_cny) * 100);
      const priorDay = '20261127';
      const rPeak = evaluateStrategyRouter({
        portfolioDb: pdb, marketDb, accountId: 'real-main', asOf: priorDay, policy,
        marketRegime: makeRegime(priorDay, sc.regime, sc.style),
        currentNavCents: peakCents,
        displayNavCents: peakCents,
      });
      persistRiskAnchor(pdb, rPeak);
    }

    const holdings = sc.positions.map(p => ({
      ts_code: p.code,
      name: DECL_BY_CODE.get(p.code)?.name ?? p.code,
      quantity: p.qty,
      sellable_quantity: p.sellable,
      weight: (p.qty * p.price) / sc.investable_nav_cny,
      market_value_cents: Math.round(p.qty * p.price * 100),
      price_milli: Math.round(p.price * 1000),
      latest_bar_date: sc.as_of,
      bar_quality: sc.quote_ready ? 'READY' : 'NOT_READY',
      ref_cost_milli: Math.round((p.avg_cost ?? p.price) * 1000),
    }));

    const candidates = {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: Object.entries(sc.market)
        .filter(([, info]) => info.asset_type !== 'STOCK')
        .map(([code, info]) => buildCandidateRow(code, info, sc.as_of)),
    };

    const fundamentalRegime = makeFundamentalRegime(sc.as_of, sc.fundamental);
    const qualifiedStockCands = [];
    const rejectedReasons = {};
    for (const scCand of sc.stock_candidates ?? []) {
      const f = scCand.fundamental;
      const ev = evaluateQualityCoreV2({
        end_date: f.end_date,
        ann_date: f.ann_date,
        roe_dt: f.roe_dt,
        eps: f.basic_eps,
        ocf_to_profit: f.ocf_to_profit,
        bps: f.bps,
      }, sc.as_of);
      if (ev.passed) {
        qualifiedStockCands.push({
          ts_code: scCand.code,
          name: scCand.code,
          industry: '银行',
          board: 'MAIN',
          trade_date: sc.as_of,
          entry_ref_price_milli: Math.round(scCand.ref_close * 1000),
          entry_ref_price_cny: scCand.ref_close,
          max_chase_price_cny: Math.round(scCand.ref_close * 1.02 * 100) / 100,
          hard_stop_price_milli: Math.round(scCand.hard_stop * 1000),
          hard_stop_price_cny: scCand.hard_stop,
          stop_loss_pct: -Math.round((1 - scCand.hard_stop / scCand.ref_close) * 10000) / 100,
          ma20_cny: scCand.ref_close * 0.99,
          rps120: 88,
          amount20_yi: 12,
          circ_mv_yi: 300,
          roe_annualized_pct: ev.roe_dt_annualized ?? 10,
          roe_dt_annualized_pct: ev.roe_dt_annualized,
          eps: f.basic_eps,
          bps: f.bps,
          ocf_to_profit_pct: f.ocf_to_profit,
          setup_label_zh: '强势股缩量回踩20日线买点',
          reasons_zh: ['QualityCore v2 校验通过'],
        });
      } else {
        rejectedReasons[scCand.code] = ev.failed_reasons[0];
      }
    }

    const exp = sc.expected;
    const fvoOverride = sc.fvo
      ? {
          overlay_id: sc.fvo.overlay_id,
          created_date: '20261110',
          expires_trade_date: sc.fvo.expires_trade_date,
          equity_delta_bps: sc.fvo.equity_delta_bps,
          status: sc.fvo.status,
          thesis_summary: sc.id,
          invalidation_rule_json: '{"rule":"fixture"}',
        }
      : null;

    // REGIME_ONLY mode ignores pure style changes; changes only on effective_regime or effective_budget change
    const regimeOrBudgetChanged = (exp.effective_regime !== sc.prev_effective_regime)
      || (exp.router_effective_cap_bps !== sc.prev_eff_budget_bps);

    const out = runActionEngine({
      portfolioDb: pdb,
      marketDb,
      accountId: 'real-main',
      asOf: sc.as_of,
      policy,
      holdings,
      cashCents: Math.round(sc.cash_cny * 100),
      totalAssetsCents: Math.round(sc.investable_nav_cny * 100),
      marketRegime: makeRegime(sc.as_of, sc.regime, sc.style, {
        pctAboveMa60: sc.pct_above_ma60,
        ice10RemainingDays: sc.ice10_remaining_days,
      }),
      fundamentalRegime,
      fvoOverride,
      fvoAttribution60dBps: sc.fvo?.attribution_60d_bps ?? null,
      bp1Reverified: sc.bp1_reverified ?? true,
      regimeOrStyleChanged: regimeOrBudgetChanged,
      stockSwingScreen: {
        schema: 'ashare-stock-swing-screen/1.0',
        as_of_trade_date: sc.as_of,
        policy_version: policy.version,
        policy_content_hash: policy.content_hash,
        bp1_pullback_enabled: true,
        bp2_breakout_enabled: false,
        bp2_status: 'DROPPED_NEGATIVE_OOS',
        scanned_stocks: (sc.stock_candidates ?? []).length,
        qualified_count: qualifiedStockCands.length,
        candidates: qualifiedStockCands,
      },
      candidates,
    });

    // 1) B1, effective_regime, FVO, align_due, BP1 & QualityCore v2
    assert.equal(out.fundamental_regime.b1_state, exp.b1_state, `${sc.id}: b1_state`);
    assert.equal(out.router.effective_regime, exp.effective_regime, `${sc.id}: effective_regime`);
    assert.equal(out.router.fvo.effective_delta_bps, exp.fvo_applied_delta_bps, `${sc.id}: fvo_applied_delta_bps`);
    assert.equal(out.router.fvo.zeroed_reason, exp.fvo_zero_reason, `${sc.id}: fvo_zero_reason`);
    assert.equal(out.align_summary?.align_due, exp.align_due, `${sc.id}: align_due`);
    assert.equal(out.router.sub_strategies.s_stock_swing === 'ACTIVE', exp.bp1_permitted, `${sc.id}: bp1_permitted`);
    assert.deepEqual(qualifiedStockCands.map(c => c.ts_code), exp.qualified_bp1_codes, `${sc.id}: qualified_bp1_codes`);
    assert.deepEqual(rejectedReasons, exp.rejected_bp1_reasons, `${sc.id}: rejected_bp1_reasons`);
    assert.equal(out.align_summary?.target_equity_cap_bps, exp.router_effective_cap_bps, `${sc.id}: router_effective_cap_bps`);

    // 2) Target equity weights (per #58: S04 L2_LOCKED skips target map; S11 target_slots holds full nominal while actual buys glide-scale)
    if (!sc.drawdown.locked && sc.id !== 'S11_66500_BP1_DORMANT_159558_LEGACY_GLIDE') {
      const actualTargets = {};
      for (const slot of out.align_summary?.target_slots ?? []) {
        if (BOND_SET.has(slot.ts_code) || slot.target_bps <= 0) continue;
        actualTargets[slot.ts_code] = slot.target_bps;
      }
      assert.deepEqual(
        Object.keys(actualTargets).sort(),
        Object.keys(exp.target_weights_bps).sort(),
        `${sc.id}: target symbols`,
      );
      for (const [code, expBps] of Object.entries(exp.target_weights_bps)) {
        assert.ok(
          Math.abs(actualTargets[code] - expBps) <= tolBps,
          `${sc.id} ${code}: target_bps ${actualTargets[code]} vs ${expBps}`,
        );
      }
    }

    // 3) Actions by code & exact share quantities for all risk-equity orders
    const actualLegsByCode = new Map();
    for (const act of out.actions) {
      for (const leg of act.legs) {
        assert.ok(!actualLegsByCode.has(leg.ts_code), `${sc.id}: duplicate action leg for ${leg.ts_code}`);
        actualLegsByCode.set(leg.ts_code, leg);
      }
    }

    for (const [code, expSide] of Object.entries(exp.actions_by_code)) {
      const leg = actualLegsByCode.get(code);
      assert.ok(leg, `${sc.id} ${code}: expected ${expSide} action missing`);
      assert.equal(leg.side, expSide, `${sc.id} ${code}: side mismatch`);
    }
    for (const [code, leg] of actualLegsByCode.entries()) {
      // Per #58 board agreement: FinanceMCP allows Stage 5 BOND_RESERVOIR parking under L2_LOCKED while freezing all risk buys
      if (sc.id === 'S04_ICE10_PLUS_P0_L2_LOCK_1000' && BOND_SET.has(code) && leg.side === 'BUY') continue;
      assert.equal(exp.actions_by_code[code], leg.side, `${sc.id} ${code}: unexpected action ${leg.side}`);
    }

    for (const expOrder of exp.orders) {
      const actualLeg = actualLegsByCode.get(expOrder.code);
      assert.ok(actualLeg, `${sc.id} ${expOrder.code}: missing order`);
      assert.equal(actualLeg.side, expOrder.side, `${sc.id} ${expOrder.code}: order side`);
      if (!BOND_SET.has(expOrder.code)) {
        if (expOrder.reason === 'CTRL_REDUCE' || expOrder.reason === 'REGIME_ALIGN_GLIDE') {
          // FinanceMCP allocateProportionalSellLots tops up 1 lot (100 shares) via largest-residual when floored total < target reduction
          assert.ok(Math.abs(actualLeg.quantity - expOrder.qty) <= 100, `${sc.id} ${expOrder.code}: proportional sell qty ${actualLeg.quantity} vs ${expOrder.qty}`);
        } else {
          assert.equal(actualLeg.quantity, expOrder.qty, `${sc.id} ${expOrder.code}: exact qty mismatch`);
        }
      } else {
        // Bond buffer differs slightly (100 CNY FinanceMCP buffer vs 1% TactiCore buffer, explicitly covered by bond_target_tolerance_bps=120)
        assert.ok(
          Math.abs(actualLeg.quantity - expOrder.qty) <= Math.ceil((sc.investable_nav_cny * 0.012) / (sc.market[expOrder.code].price * 100)) * 100,
          `${sc.id} ${expOrder.code}: bond qty ${actualLeg.quantity} out of tolerance vs ${expOrder.qty}`,
        );
      }
    }

    if (sc.id === 'S11_66500_BP1_DORMANT_159558_LEGACY_GLIDE') {
      assert.ok((out.align_summary?.post_action_risk_equity_bps ?? 0) <= 2500, 'S11 post-buy risk <= 2500bps');
    }

    pdb.close();
  }

  marketDb.close();
});
