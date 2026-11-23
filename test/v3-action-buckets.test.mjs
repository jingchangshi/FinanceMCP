import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-buckets-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
process.env.ASHARE_ACCOUNT_ID = 'real-main';
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { runActionEngine } = await import('../build/portfolio/actionEngine.js');

const ASOF = '20261120';

function regime(tier, style) {
  return {
    schema: 'ashare-market-regime/1.0',
    as_of_trade_date: ASOF,
    available: true,
    regime: tier,
    raw_regime: tier,
    target_equity_bps: 0,
    target_equity_pct: 0,
    hysteresis_held: false,
    crash_override: false,
    style,
    style_spread_20d_pct: null,
    value_anchor: {},
    growth_anchor: {},
    breadth: {},
    history: [],
    regime_label_zh: tier === 'DEFENSIVE' ? '防守' : tier === 'STRUCTURAL' ? '结构' : '进攻',
    style_label_zh: style === 'GROWTH_LEADING' ? '成长占优' : style === 'VALUE_LEADING' ? '价值占优' : '均衡',
    summary_zh: '',
    notes: [],
  };
}

/** 组装动作引擎只读取的候选字段；其余字段填最小占位，避免伪造研究结论。 */
function candidateRow({ code, name, closeMilli, category = 'broad_based', categoryLabel, buyBlocked = false, score = 0.5 }) {
  return {
    rank: 1,
    ts_code: code,
    category,
    category_label: categoryLabel ?? category,
    name,
    name_source: 'fund_basic',
    held: false,
    included: true,
    eligibility: 'eligible',
    status: 'OK',
    status_reasons: [],
    as_of_trade_date: ASOF,
    filters: {
      premium_discount: {
        state: 'pass',
        detail: '',
        value_pct: 0.1,
        premium_bps: 10,
        unit_nav: closeMilli / 1000,
        nav_date: ASOF,
        lag_trade_days: 0,
        nav_stale: false,
        buy_blocked: buyBlocked,
      },
    },
    data: {
      bars_used: 60,
      latest_bar_date: ASOF,
      latest_close_milli: closeMilli,
      price_basis: 'qfq_adjusted',
      adj_base: null,
      adj_missing_bars: 0,
      share: { fd_share_wan: 100_000, trade_date: ASOF },
      size_wan_cny: 10_000_000,
      unit_nav: closeMilli / 1000,
      nav_date: ASOF,
      premium_bps: 10,
      nav_stale: false,
      buy_blocked: buyBlocked,
      coverage: {
        fund_basic: true, fund_daily: true, fund_adj: true, fund_share: true, fund_nav: true, latest_trade_date: ASOF,
      },
    },
    exclusions: [],
    score,
    score_components: {},
    source: 'server_cache',
    research: {},
  };
}

const ROWS = {
  value: candidateRow({ code: '159330.SZ', name: '东财沪深300ETF', closeMilli: 4000 }),
  growth1: candidateRow({ code: '159205.SZ', name: '东财创业板ETF', closeMilli: 1000 }),
  growth2: candidateRow({ code: '159337.SZ', name: '东财中证500ETF', closeMilli: 2000 }),
  defensive1: candidateRow({ code: '159549.SZ', name: '红利低波100ETF', closeMilli: 1000, category: 'industry_theme' }),
  defensive2: candidateRow({ code: '159207.SZ', name: '智选高股息ETF', closeMilli: 2000, category: 'industry_theme' }),
  reservoir: candidateRow({ code: '511010.SH', name: '国债ETF', closeMilli: 100_000, category: 'bond' }),
};

let dbSeq = 0;
function freshDb() {
  dbSeq += 1;
  return openPortfolioDb(join(dir, `bucket-${dbSeq}-portfolio.sqlite`), {
    marketPath: join(dir, `bucket-${dbSeq}-market.sqlite`),
  });
}

function run(db, { marketRegime, cashCents, totalAssetsCents, holdings = [], candidateRows }) {
  return runActionEngine({
    portfolioDb: db,
    marketDb: null,
    accountId: 'real-main',
    asOf: ASOF,
    holdings,
    cashCents,
    totalAssetsCents,
    marketRegime,
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: candidateRows },
  });
}

const buyGross = (plan, codes) => plan.legs
  .filter(leg => codes.includes(leg.ts_code))
  .reduce((sum, leg) => sum + leg.gross_cents, 0);

test('P0-3: OFFENSIVE + GROWTH_LEADING 按成长 65 / 价值 35 跨桶等权拆分', () => {
  const db = freshDb();
  try {
    const holding = {
      ts_code: '600519.SH', name: '贵州茅台测试', quantity: 100, sellable_quantity: 100,
      weight: 0.1, market_value_cents: 1_000_000, price_milli: 10_000,
      latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 10_000,
    };
    const cashCents = 9_000_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: cashCents + holding.market_value_cents,
      holdings: [holding],
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir],
    });

    const deployBudgetCents = Math.min(8_500_000 - 1_000_000, cashCents - 1_500_000);
    const growthPlan = out.actions.find(action => action.code === 'P3-SUPER-ETF-BUCKET-GROWTH');
    const valuePlan = out.actions.find(action => action.code === 'P3-SUPER-ETF-BUCKET-VALUE');
    assert.ok(growthPlan, '应生成成长桶等权买单');
    assert.ok(valuePlan, '应生成价值桶等权买单');
    assert.equal(out.actions.some(action => action.code === 'P3-SUPER-ETF-BUCKET-DEFENSIVE'), false);

    const growthCodes = growthPlan.legs.map(leg => leg.ts_code).sort();
    assert.deepEqual(growthCodes, ['159205.SZ', '159337.SZ'], '成长桶应覆盖两只合格成员，等权而非单押一只');
    assert.deepEqual(valuePlan.legs.map(leg => leg.ts_code), ['159330.SZ']);

    for (const leg of [...growthPlan.legs, ...valuePlan.legs]) {
      assert.equal(leg.side, 'BUY');
      assert.equal(leg.quantity % 100, 0, `${leg.ts_code} 必须是整手`);
      assert.ok(leg.gross_cents >= 100_000, `${leg.ts_code} 单腿毛额必须不低于 1,000 元`);
    }

    const growthRatio = buyGross(growthPlan, ['159205.SZ', '159337.SZ']) / deployBudgetCents;
    const valueRatio = buyGross(valuePlan, ['159330.SZ']) / deployBudgetCents;
    assert.ok(Math.abs(growthRatio - 0.65) < 0.02, `成长桶占比应约 65%，实际 ${(growthRatio * 100).toFixed(1)}%`);
    assert.ok(Math.abs(valueRatio - 0.35) < 0.02, `价值桶占比应约 35%，实际 ${(valueRatio * 100).toFixed(1)}%`);

    // 防御现金蓄水池作为独立腿出现，且只买 511010.SH。
    const reservoir = out.actions.find(action => action.code === 'P3-BOND-RESERVOIR-BUY-511010.SH');
    assert.ok(reservoir, '防御现金应转入国债 ETF 蓄水池');
    assert.deepEqual(reservoir.legs.map(leg => leg.ts_code), ['511010.SH']);
    assert.ok(reservoir.legs[0].gross_cents >= 500_000, '蓄水池单腿毛额必须不低于 5,000 元');
    assert.equal(
      [...growthPlan.legs, ...valuePlan.legs].some(leg => leg.ts_code === '511010.SH'),
      false,
      '国债 ETF 不得混入权益风格桶',
    );

    // 所有买入合计不得超过可用现金，并保留 100 元现金缓冲。
    const spent = out.actions
      .filter(action => action.kind !== 'REDUCE')
      .flatMap(action => action.legs)
      .filter(leg => leg.side === 'BUY')
      .reduce((sum, leg) => sum + leg.net_cents, 0);
    assert.ok(spent <= cashCents - 10_000, `买入合计 ${spent} 不得超过可用现金减 100 元缓冲 ${cashCents - 10_000}`);
  } finally {
    db.close();
  }
});

test('P0-3: DEFENSIVE 档权益预算进入防御红利桶，不使用成长/价值桶', () => {
  const db = freshDb();
  try {
    const cashCents = 10_000_000;
    const out = run(db, {
      marketRegime: regime('DEFENSIVE', 'BALANCED'),
      cashCents,
      totalAssetsCents: cashCents,
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir],
    });

    const defensivePlan = out.actions.find(action => action.code === 'P3-SUPER-ETF-BUCKET-DEFENSIVE');
    assert.ok(defensivePlan, 'DEFENSIVE 档应使用防御红利桶');
    assert.deepEqual(defensivePlan.legs.map(leg => leg.ts_code).sort(), ['159207.SZ', '159549.SZ']);
    assert.equal(out.actions.some(action => action.code === 'P3-SUPER-ETF-BUCKET-GROWTH'), false);
    assert.equal(out.actions.some(action => action.code === 'P3-SUPER-ETF-BUCKET-VALUE'), false);
    for (const leg of defensivePlan.legs) {
      assert.equal(leg.quantity % 100, 0);
      assert.ok(leg.gross_cents >= 100_000);
    }

    const reservoir = out.actions.find(action => action.code === 'P3-BOND-RESERVOIR-BUY-511010.SH');
    assert.ok(reservoir, '防守档 85% 防御桶应继续转入国债 ETF 蓄水池');
    assert.ok(reservoir.legs[0].gross_cents >= 500_000);
  } finally {
    db.close();
  }
});

test('P0-3: 国债蓄水池缺少行情时不买、不臆造价格，并留下阻断说明', () => {
  const db = freshDb();
  try {
    const cashCents = 9_000_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: 10_000_000,
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.value, ROWS.defensive1, ROWS.defensive2],
    });
    assert.equal(out.actions.some(action => action.code.startsWith('P3-BOND-RESERVOIR')), false);
    assert.equal(
      out.actions.flatMap(action => action.legs).some(leg => leg.ts_code === '511010.SH'),
      false,
      '没有当日报价时绝不能凭空生成 511010.SH 买单',
    );
    assert.ok(
      out.blockers.some(line => line.includes('511010.SH') && line.includes('缺少当日可交易报价')),
      '缺行情必须给出阻断说明',
    );
  } finally {
    db.close();
  }
});

test('P0-3: 防御桶待配置金额低于 5,000 元时跳过蓄水池并说明原因', () => {
  const db = freshDb();
  try {
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents: 300_000,
      totalAssetsCents: 300_000,
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir],
    });
    assert.equal(out.actions.some(action => action.code.startsWith('P3-BOND-RESERVOIR')), false);
    assert.ok(
      out.blockers.some(line => line.includes('国债 ETF 防御蓄水池') && line.includes('不足最低单腿门槛')),
      `应说明蓄水池订单过小，实际阻断：${JSON.stringify(out.blockers)}`,
    );
  } finally {
    db.close();
  }
});

test('P0-3: 某个风格桶无合格成员时跳过该桶，绝不把预算转嫁给另一只 ETF', () => {
  const db = freshDb();
  try {
    const cashCents = 9_000_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: 10_000_000,
      // 成长桶成员全部缺席，仅保留价值桶与防御成员。
      candidateRows: [ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir],
    });

    assert.equal(out.actions.some(action => action.code === 'P3-SUPER-ETF-BUCKET-GROWTH'), false);
    assert.ok(out.blockers.some(line => line.includes('成长桶')), '缺失的成长桶必须留下阻断说明');
    const valuePlan = out.actions.find(action => action.code === 'P3-SUPER-ETF-BUCKET-VALUE');
    assert.ok(valuePlan);
    const deployBudgetCents = Math.min(8_500_000, cashCents - 1_500_000);
    assert.ok(
      valuePlan.legs[0].gross_cents <= Math.floor(deployBudgetCents * 0.35) + 1,
      `价值桶只能拿 35% 预算，不得吞掉成长桶份额：${valuePlan.legs[0].gross_cents}`,
    );
    const reservoir = out.actions.find(action => action.code === 'P3-BOND-RESERVOIR-BUY-511010.SH');
    assert.ok(reservoir);
    assert.ok(
      reservoir.legs[0].gross_cents <= 1_500_000,
      '蓄水池不得超过防御桶目标，不得吸收无法部署的成长桶预算',
    );
  } finally {
    db.close();
  }
});

test('P0-3: 被禁买的超级 ETF 不得进入风格桶买单', () => {
  const db = freshDb();
  try {
    const blockedGrowth = candidateRow({
      code: '159205.SZ', name: '东财创业板ETF', closeMilli: 1000, buyBlocked: true,
    });
    const cashCents = 9_000_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: 10_000_000,
      candidateRows: [blockedGrowth, ROWS.growth2, ROWS.value, ROWS.reservoir],
    });
    assert.equal(
      out.actions.flatMap(action => action.legs).some(leg => leg.ts_code === '159205.SZ' && leg.side === 'BUY'),
      false,
      '溢价/净值滞后被禁买的候选不得买入',
    );
    const growthPlan = out.actions.find(action => action.code === 'P3-SUPER-ETF-BUCKET-GROWTH');
    assert.ok(growthPlan);
    assert.deepEqual(growthPlan.legs.map(leg => leg.ts_code), ['159337.SZ']);
  } finally {
    db.close();
  }
});
