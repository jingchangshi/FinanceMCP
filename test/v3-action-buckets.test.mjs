import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-buckets-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
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
  growth3: candidateRow({ code: '589850.SH', name: '东财科创50ETF', closeMilli: 1000 }),
  growth4: candidateRow({ code: '159290.SZ', name: '东财创业板综合ETF', closeMilli: 1000 }),
  growth5: candidateRow({ code: '589060.SH', name: '东财科创综指ETF', closeMilli: 1000 }),
  growth6: candidateRow({ code: '589330.SH', name: '东财科创200ETF', closeMilli: 1000 }),
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

function run(db, { marketRegime, cashCents, totalAssetsCents, holdings = [], candidateRows, wealthCents = 0 }) {
  return runActionEngine({
    portfolioDb: db,
    marketDb: null,
    accountId: 'real-main',
    asOf: ASOF,
    holdings,
    cashCents,
    wealthCents,
    totalAssetsCents,
    marketRegime,
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: candidateRows },
  });
}

const rebalance = out => out.actions.find(action => action.code === 'P3-SUPER-ETF-REBALANCE');
const buyLegs = action => (action?.legs ?? []).filter(leg => leg.side === 'BUY');
const sellLegs = action => (action?.legs ?? []).filter(leg => leg.side === 'SELL');
const legOf = (action, code) => buyLegs(action).find(leg => leg.ts_code === code);
const grossOf = (action, codes) => buyLegs(action)
  .filter(leg => codes.includes(leg.ts_code))
  .reduce((sum, leg) => sum + leg.gross_cents, 0);

test('P0-3: OFFENSIVE + GROWTH_LEADING 按目标持仓差额跨桶配置，成长桶只取 EXP-01 前 3 只', () => {
  const db = freshDb();
  try {
    const holding = {
      ts_code: '600519.SH', name: '贵州茅台测试', quantity: 100, sellable_quantity: 100,
      weight: 0.01, market_value_cents: 100_000, price_milli: 10_000,
      latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 10_000,
    };
    const cashCents = 9_900_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: cashCents + holding.market_value_cents,
      holdings: [holding],
      candidateRows: [
        ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.growth4, ROWS.growth5, ROWS.growth6,
        ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir,
      ],
    });

    const action = rebalance(out);
    assert.ok(action, '成长/价值桶与蓄水池应合并为一个再平衡 action');
    assert.equal(out.actions.filter(a => a.code.startsWith('P3-SUPER-ETF-BUCKET')).length, 0, '不应再拆成多个桶 action');

    const growthCodes = buyLegs(action).map(leg => leg.ts_code).filter(code => ['159205.SZ', '159337.SZ', '589850.SH'].includes(code)).sort();
    assert.deepEqual(growthCodes, ['159205.SZ', '159337.SZ', '589850.SH'], '成长桶只取前 3 只');
    for (const excluded of ['159290.SZ', '589060.SH', '589330.SH']) {
      assert.equal(buyLegs(action).some(leg => leg.ts_code === excluded), false, `${excluded} 不在 EXP-01 前 3 只，不得买入`);
    }
    assert.ok(legOf(action, '159330.SZ'), '价值桶应有买入腿');
    assert.ok(legOf(action, '511010.SH'), '防御蓄水池应有买入腿');

    for (const leg of buyLegs(action)) {
      assert.equal(leg.quantity % 100, 0, `${leg.ts_code} 必须是整手`);
      if (leg.ts_code !== '511010.SH') assert.ok(leg.gross_cents >= 100_000, `${leg.ts_code} 单腿毛额必须不低于 1,000 元`);
    }
    assert.ok(legOf(action, '511010.SH').gross_cents >= 500_000, '蓄水池单腿毛额必须不低于 5,000 元');

    const baseTarget = Math.round(10_000_000 * 0.375);
    const growthGross = grossOf(action, ['159205.SZ', '159337.SZ', '589850.SH']);
    const valueGross = grossOf(action, ['159330.SZ']);
    assert.ok(Math.abs(growthGross / baseTarget - 0.65) < 0.03, `成长桶应约 65%，实际 ${(growthGross / baseTarget * 100).toFixed(1)}%`);
    assert.ok(Math.abs(valueGross / baseTarget - 0.35) < 0.03, `价值桶应约 35%，实际 ${(valueGross / baseTarget * 100).toFixed(1)}%`);

    const spent = buyLegs(action).reduce((sum, leg) => sum + leg.net_cents, 0);
    assert.ok(spent <= cashCents - 10_000, '买入合计不得超过可用现金减 100 元缓冲');
  } finally {
    db.close();
  }
});

test('P0-3: 已持有的桶成员按“目标 - 现有持仓”差额减少买入，而不是均分新增现金', () => {
  const db = freshDb();
  try {
    const heldGrowth = {
      ts_code: '159205.SZ', name: '东财创业板ETF', quantity: 5000, sellable_quantity: 5000,
      weight: 0.05, market_value_cents: 500_000, price_milli: 1000,
      latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 1000,
    };
    const cashCents = 9_500_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: cashCents + heldGrowth.market_value_cents,
      holdings: [heldGrowth],
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, ROWS.reservoir],
    });
    const action = rebalance(out);
    assert.ok(action);
    const heldLeg = legOf(action, '159205.SZ');
    const peerLeg = legOf(action, '159337.SZ');
    assert.ok(heldLeg && peerLeg, '两只成长成员都应有买入腿');
    assert.ok(heldLeg.gross_cents < peerLeg.gross_cents, '已持有 5,000 元份额的成员应少买');
    assert.ok(heldLeg.gross_cents < 500_000, `目标差额应扣减现有持仓，实际 ${heldLeg.gross_cents}`);
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
      candidateRows: [
        ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir,
      ],
    });
    const action = rebalance(out);
    assert.ok(action, 'DEFENSIVE 档应使用防御红利桶');
    assert.deepEqual(buyLegs(action).map(leg => leg.ts_code).sort(), ['159207.SZ', '159549.SZ', '511010.SH']);
    for (const leg of buyLegs(action).filter(item => item.ts_code !== '511010.SH')) {
      assert.equal(leg.quantity % 100, 0);
      assert.ok(leg.gross_cents >= 100_000);
      assert.ok((leg.gross_cents / 10_000_000) <= 0.20, '行业主题腿买后不得超过 20% 上限');
    }
  } finally {
    db.close();
  }
});

test('P0-3: 国债蓄水池缺少行情时不买、不臆造价格，并留下阻断说明', () => {
  const db = freshDb();
  try {
    const cashCents = 9_900_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: 10_000_000,
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, ROWS.defensive1, ROWS.defensive2],
    });
    const action = rebalance(out);
    assert.ok(action, '缺蓄水池行情不应影响风格桶买单');
    assert.equal(buyLegs(action).some(leg => leg.ts_code === '511010.SH'), false);
    assert.ok(
      out.blockers.some(line => line.includes('511010.SH') && line.includes('缺少当日新鲜报价')),
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
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir],
    });
    assert.equal(rebalance(out), undefined, '小账户所有腿都低于最低门槛时不应生成 action');
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
    const cashCents = 9_900_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: 10_000_000,
      candidateRows: [ROWS.value, ROWS.defensive1, ROWS.defensive2, ROWS.reservoir],
    });
    const action = rebalance(out);
    assert.ok(action);
    assert.equal(buyLegs(action).some(leg => ['159205.SZ', '159337.SZ', '589850.SH'].includes(leg.ts_code)), false);
    assert.ok(out.blockers.some(line => line.includes('成长桶')), '缺失的成长桶必须留下阻断说明');
    const baseTarget = Math.round(10_000_000 * 0.375);
    const valueLeg = legOf(action, '159330.SZ');
    assert.ok(valueLeg.gross_cents <= baseTarget * 0.35 + 1, '价值桶只能拿 35% 目标，不得吞掉成长桶份额');
    assert.ok(legOf(action, '511010.SH'), '未部署的成长预算转为防御桶时仍应保留蓄水池腿');
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
    const cashCents = 9_900_000;
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents,
      totalAssetsCents: 10_000_000,
      candidateRows: [blockedGrowth, ROWS.growth2, ROWS.growth3, ROWS.value, ROWS.reservoir],
    });
    const action = rebalance(out);
    assert.ok(action);
    assert.equal(buyLegs(action).some(leg => leg.ts_code === '159205.SZ'), false, '禁买候选不得买入');
    assert.ok(legOf(action, '159337.SZ'));
    assert.ok(legOf(action, '589850.SH'));
  } finally {
    db.close();
  }
});

test('P0-3: DEF→OFF 时卖出超额 511010 作为权益融资腿，并保留防御目标', () => {
  const db = freshDb();
  try {
    // 15% 权益（159558）+ 85% 国债，无现金；切到 OFFENSIVE 需要融资。
    const holdings = [
      {
        ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 15_000, sellable_quantity: 15_000,
        weight: 0.15, market_value_cents: 1_500_000, price_milli: 1000,
        latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 1000,
      },
      {
        ts_code: '511010.SH', name: '国债ETF', quantity: 850, sellable_quantity: 850,
        weight: 0.85, market_value_cents: 8_500_000, price_milli: 100_000,
        latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 100_000,
      },
    ];
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents: 0,
      totalAssetsCents: 10_000_000,
      holdings,
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, ROWS.reservoir],
    });
    const action = rebalance(out);
    assert.ok(action, 'DEF→OFF 应生成再平衡 action');
    const funding = sellLegs(action).find(leg => leg.ts_code === '511010.SH');
    assert.ok(funding, '应卖出超额国债 ETF 作为融资腿');
    assert.equal(funding.reason, 'P3_DEFENSIVE_RESERVOIR_FUNDING');
    assert.ok(funding.gross_cents >= 500_000);
    const growthLegs = buyLegs(action).filter(leg => ['159205.SZ', '159337.SZ', '589850.SH'].includes(leg.ts_code));
    assert.ok(growthLegs.length > 0, '融资后应能买入成长桶');
    assert.equal(buyLegs(action).some(leg => leg.ts_code === '511010.SH'), false, '防御目标仍充足时不应再买国债 ETF');
  } finally {
    db.close();
  }
});

test('P0-3: 蓄水池买入只认当日新鲜报价且必须 included/未禁买', () => {
  const staleReservoir = candidateRow({ code: '511010.SH', name: '国债ETF', closeMilli: 50_000, category: 'bond' });
  staleReservoir.data.latest_bar_date = '20261119'; // 旧报价：不得用于买入
  const excludedReservoir = candidateRow({ code: '511010.SH', name: '国债ETF', closeMilli: 100_000, category: 'bond' });
  excludedReservoir.included = false;

  for (const [label, row] of [['stale', staleReservoir], ['not-included', excludedReservoir]]) {
    const db = freshDb();
    try {
      const cashCents = 9_900_000;
      const out = run(db, {
        marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
        cashCents,
        totalAssetsCents: 10_000_000,
        candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, row],
      });
      const action = rebalance(out);
      assert.ok(action, `${label}: 风格桶仍应生成`);
      assert.equal(buyLegs(action).some(leg => leg.ts_code === '511010.SH'), false, `${label}: 蓄水池不得买入`);
      assert.ok(
        out.blockers.some(line => line.includes('511010.SH') && line.includes('缺少当日新鲜报价')),
        `${label}: 必须留下新鲜报价/过滤阻断说明`,
      );
    } finally {
      db.close();
    }
  }
});

test('P0-3: 蓄水池卖出只有旧报价时改用持仓参考价并明确告警，不臆造当日价', () => {
  const db = freshDb();
  try {
    const staleReservoir = candidateRow({ code: '511010.SH', name: '国债ETF', closeMilli: 50_000, category: 'bond' });
    staleReservoir.data.latest_bar_date = '20261119'; // 旧报价 50 元，与持仓 100 元不同
    const holdings = [
      {
        ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 15_000, sellable_quantity: 15_000,
        weight: 0.15, market_value_cents: 1_500_000, price_milli: 1000,
        latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 1000,
      },
      {
        ts_code: '511010.SH', name: '国债ETF', quantity: 850, sellable_quantity: 850,
        weight: 0.85, market_value_cents: 8_500_000, price_milli: 100_000,
        latest_bar_date: ASOF, bar_quality: 'READY', ref_cost_milli: 100_000,
      },
    ];
    const out = run(db, {
      marketRegime: regime('OFFENSIVE', 'GROWTH_LEADING'),
      cashCents: 0,
      totalAssetsCents: 10_000_000,
      holdings,
      candidateRows: [ROWS.growth1, ROWS.growth2, ROWS.growth3, ROWS.value, staleReservoir],
    });
    const action = rebalance(out);
    assert.ok(action);
    const funding = sellLegs(action).find(leg => leg.ts_code === '511010.SH');
    assert.ok(funding, '仍应生成融资卖出腿');
    assert.equal(funding.price_milli, 100_000, '旧报价 50 元不得用于卖出，应使用持仓参考价 100 元');
    assert.ok(
      out.blockers.some(line => line.includes('511010.SH') && line.includes('按持仓参考价计价')),
      '旧报价卖出必须明确告警',
    );
  } finally {
    db.close();
  }
});
