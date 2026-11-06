// Technical methodology V2 — per-stock research state machine (goal-1102 §四).
//
// These tests feed hand-built contexts and signals straight into
// `buildResearchUniverse`, so each precedence rule is asserted in isolation
// rather than only being observable when a market scan happens to produce it.
//
// The rules under test:
//   BLOCKED > INVALIDATED > DETERIORATING > EXTENDED > FOCUS > WATCH
// plus the acceptance invariants:
//   - a one-price limit-down as-of bar is never FOCUS, whatever the pattern,
//   - a suspended / no-bar name never borrows the as-of date as a confirmation,
//   - no stock carries a cross-family score, priority or entry field,
//   - one stock = one record, one state, even when several families list it.
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildResearchUniverse, highlightStocks } = await import('../build/ashare/technicalResearchStateV2.js');
const { RESEARCH_STATE_ORDER } = await import('../build/ashare/technicalFrameworkV2.js');

const AS_OF = '2026-11-02';
const FAMILIES = [
  'TREND_CONTINUATION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'VOLATILITY_EXPANSION', 'MEAN_REVERSION',
];

function ctx(over = {}) {
  return {
    ts_code: '600001.SH',
    name: '测试股',
    trade_date: AS_OF,
    as_of: AS_OF,
    bars_behind_as_of: 0,
    trading_status: 'TRADABLE',
    price_volume_tags: [],
    market_regime: 'range',
    close: 10,
    pct_chg: 1,
    volume_ratio_20: 1.2,
    atr_pct: 2,
    rps120: 60,
    notes: [],
    ...over,
  };
}

function signal(over = {}) {
  return {
    ts_code: '600001.SH',
    name: '测试股',
    trade_date: AS_OF,
    as_of: AS_OF,
    family: 'TREND_CONTINUATION',
    strategy_id: 'trend_pullback_confirm',
    stage: 'CONFIRMED',
    stage_detail: '回踩确认',
    pattern_event_date: '2026-10-28',
    first_observed_date: '2026-10-30',
    invalidated_at: null,
    expires_at: null,
    formed_on: '2026-10-30',
    confirmed_on: '2026-10-30',
    last_evaluated_on: AS_OF,
    formation_basis: [],
    confirmation_conditions: ['收盘价站上 10.50'],
    invalidation_conditions: ['收盘价跌破 9.40'],
    invalidation: null,
    key_levels: { support: 9.4, resistance: 10.5 },
    evidence: {},
    counter_evidence: [],
    confirmation_lag: 2,
    market_regime: 'range',
    price_volume_tags: [],
    trading_status: 'TRADABLE',
    research_ready: true,
    research_blockers: [],
    evidence_level: 'UNVERIFIED',
    price_position: null,
    ...over,
  };
}

/** A descriptive price-position record as the framework builds it. */
function position(over = {}) {
  return {
    basis: 'adjusted_close',
    close: 11.5, ma20: 10, ma60: 9.4, atr14: 0.5, rsi6: 55, rsi14: 52,
    close_vs_ma20_pct: 15, close_vs_ma20_atr: 3, close_vs_ma60_pct: 22.3,
    ma20_above_ma60: true, ma20_rising: true,
    reference_price: 10, reference_kind: 'ma20_reclaim',
    reference_distance_pct: 15, reference_distance_atr: 3,
    bars_since_confirmation: 2,
    invalidation_level: 9.4, invalidation_distance_pct: 18.3, invalidation_distance_atr: 4.2,
    price_extension: true,
    price_extension_basis: ['(close-ma20)/atr14=3.0000 vs threshold 3.0'],
    ...over,
  };
}

/** Build the minimal TechnicalViewV2 shape `buildResearchUniverse` consumes. */
function view(contexts, signals) {
  const families = FAMILIES.map(family => ({
    family,
    label: family,
    definition: '',
    candidates: signals.filter(s => s.family === family),
    counts: { total: 0, research_ready: 0 },
  }));
  return { as_of: AS_OF, contexts, families };
}

const build = (contexts, signals, sectors = new Map()) => buildResearchUniverse(view(contexts, signals), sectors);
const only = (universe) => {
  assert.equal(universe.stocks.length, 1, `expected one stock, got ${universe.stocks.map(s => s.ts_code)}`);
  return universe.stocks[0];
};

// ------------------------------------------------------------------ precedence

test('a one-price limit-down as-of bar is BLOCKED even with a live confirmation', () => {
  const code = '002724.SZ';
  const u = build(
    [ctx({ ts_code: code, name: '海洋王', trading_status: 'ONE_PRICE_LIMIT_DOWN', price_volume_tags: ['ONE_PRICE_LIMIT_DOWN'] })],
    [signal({ ts_code: code, name: '海洋王' })],
  );
  const s = only(u);
  assert.equal(s.research_state, 'BLOCKED');
  assert.notEqual(s.research_state, 'FOCUS');
  assert.equal(s.research_ready, false);
  assert.deepEqual(s.trading_constraints, ['ONE_PRICE_LIMIT_DOWN']);
  assert.match(s.decisive_reasons.join(''), /一字跌停/);
  // The pattern evidence is kept, not deleted: the price facts decide the day.
  assert.equal(s.signals.length, 1);
  assert.equal(s.signals[0].stage, 'CONFIRMED');
  assert.ok(u.daily_highlights.includes(code) === false, 'a blocked name is never a daily highlight');
});

test('a suspended name is BLOCKED and keeps its own bar date instead of the as-of date', () => {
  const code = '002129.SZ';
  const lastBar = '2026-10-30';
  const u = build(
    [ctx({ ts_code: code, name: 'TCL中环', trade_date: lastBar, bars_behind_as_of: 1, trading_status: 'SUSPENDED' })],
    [signal({ ts_code: code, name: 'TCL中环', trade_date: lastBar, confirmed_on: '2026-10-20', first_observed_date: '2026-10-20' })],
  );
  const s = only(u);
  assert.equal(s.research_state, 'BLOCKED');
  assert.equal(s.trade_date, lastBar);
  assert.equal(s.as_of_trade_date, AS_OF);
  assert.equal(s.bars_behind_as_of, 1);
  // No fabricated same-day confirmation: the signal keeps the date it was provable.
  assert.equal(s.signals[0].confirmed_on, '2026-10-20');
  assert.notEqual(s.signals[0].confirmed_on, AS_OF);
});

test('a missing bar (NO_BAR) or a stale bar is BLOCKED, not silently tradable', () => {
  const noBar = build([ctx({ ts_code: '600002.SH', trading_status: 'NO_BAR' })], [signal({ ts_code: '600002.SH' })]);
  assert.equal(only(noBar).research_state, 'BLOCKED');
  const stale = build([ctx({ ts_code: '600003.SH', bars_behind_as_of: 3, trade_date: '2026-10-28' })], [signal({ ts_code: '600003.SH' })]);
  assert.equal(only(stale).research_state, 'BLOCKED');
  assert.deepEqual(only(stale).trading_constraints, ['STALE_BAR']);
});

test('all-dead episodes are INVALIDATED and carry the invalidation reason', () => {
  const u = build(
    [ctx()],
    [signal({
      family: 'PLATFORM_BREAKOUT', strategy_id: 'pb_v2_platform_breakout',
      stage: 'FAILED', stage_detail: 'PLATFORM_BREAKOUT_FAILED',
      confirmed_on: '2026-10-20', invalidated_at: '2026-10-31',
      invalidation: { on: '2026-10-31', reason: '收盘跌破 9.40' }, research_ready: false,
    })],
  );
  const s = only(u);
  assert.equal(s.research_state, 'INVALIDATED', 'a failed breakout is not FOCUS');
  assert.match(s.decisive_reasons.join(''), /收盘跌破 9\.40/);
  assert.equal(s.signals[0].invalidated_at, '2026-10-31');
  assert.equal(s.signals[0].confirmed_on, '2026-10-20', 'the historical breakout date stays queryable');
});

test('expired-only episodes are INVALIDATED with the window-end date', () => {
  const u = build(
    [ctx()],
    [signal({ stage: 'EXPIRED', stage_detail: '过期', expires_at: '2026-10-27', research_ready: false })],
  );
  const s = only(u);
  assert.equal(s.research_state, 'INVALIDATED');
  assert.match(s.decisive_reasons.join(''), /2026-10-27/);
});

test('a failed episode from another family and an expired window never veto a live setup', () => {
  const live = signal({ family: 'TREND_CONTINUATION', strategy_id: 'tc_v2_pullback_resume' });
  const deadOther = signal({
    family: 'MEAN_REVERSION', strategy_id: 'mr_v2_oversold_reversion', stage: 'FAILED',
    stage_detail: '失效', confirmed_on: '2026-10-20', invalidated_at: '2026-10-31',
    invalidation: { on: '2026-10-31', reason: '反弹未站回中轨' }, research_ready: false,
  });
  const expired = signal({
    family: 'REVERSAL', strategy_id: 'rv_v2_macd_dif_divergence', stage: 'EXPIRED',
    stage_detail: '过期', confirmed_on: null, expires_at: '2026-10-29', research_ready: false,
  });
  const s = only(build([ctx()], [live, deadOther, expired]));
  assert.equal(s.research_state, 'FOCUS', 'other-family failures and expiries are history, not current evidence');
  assert.deepEqual(s.conflicting_evidence, []);
  assert.equal(s.signals.length, 3, 'the dead episodes stay in signals for audit');
});

test('a historical same-family failure before the live confirmation coexists with it', () => {
  const live = signal({ confirmed_on: '2026-11-01', formed_on: '2026-10-28' });
  const history = signal({
    stage: 'FAILED', stage_detail: '失效', confirmed_on: '2026-10-10',
    invalidated_at: '2026-10-20', invalidation: { on: '2026-10-20', reason: '跌破 MA60' },
    research_ready: false,
  });
  const s = only(build([ctx()], [live, history]));
  assert.equal(s.research_state, 'FOCUS');
  assert.deepEqual(s.conflicting_evidence, [], 'an already-superseded failure cannot negate the live setup');
  assert.equal(s.signals.filter(x => x.stage === 'FAILED').length, 1, 'history is preserved');
});

test('a same-family failure after the live confirmation is current evidence ⇒ DETERIORATING', () => {
  const live = signal({
    family: 'REVERSAL', strategy_id: 'rv_v2_macd_w_bottom', stage: 'FOLLOW_THROUGH',
    confirmed_on: '2026-10-26', formed_on: '2026-10-19',
  });
  const failed = signal({
    family: 'REVERSAL', strategy_id: 'rv_v2_macd_dif_divergence', stage: 'FAILED',
    stage_detail: 'DIF_DIVERGENCE_FAILED', confirmed_on: null, invalidated_at: '2026-10-30',
    invalidation: { on: '2026-10-30', reason: '收盘跌破背离低点' }, research_ready: false,
  });
  const s = only(build([ctx()], [live, failed]));
  assert.equal(s.research_state, 'DETERIORATING');
  assert.match(s.decisive_reasons.join(''), /rv_v2_macd_w_bottom/);
  assert.match(s.decisive_reasons.join(''), /2026-10-26/);
  assert.match(s.conflicting_evidence.join(''), /rv_v2_macd_dif_divergence/);
  assert.match(s.conflicting_evidence.join(''), /2026-10-30/);
});

test('a live setup after a rapid run-up is EXTENDED, never FOCUS', () => {
  const s = only(build([ctx({ price_volume_tags: ['RAPID_RUNUP'] })], [signal()]));
  assert.equal(s.research_state, 'EXTENDED');
  assert.match(s.decisive_reasons.join(''), /15%/);
});

test('a live setup with price extension is EXTENDED, described by its ATR distance', () => {
  const s = only(build([ctx()], [signal({ price_position: position() })]));
  assert.equal(s.research_state, 'EXTENDED');
  assert.match(s.decisive_reasons.join(''), /价格延伸/);
  assert.match(s.decisive_reasons.join(''), /3 倍 ATR14/);
  assert.equal(s.price_position.price_extension, true);
  assert.equal(s.signals[0].price_position.price_extension, true);
});

test('a high RSI is descriptive only and never gates the state', () => {
  const s = only(build([ctx()], [signal({
    price_position: position({ price_extension: false, close_vs_ma20_atr: 2.9, rsi6: 92, rsi14: 88 }),
  })]));
  assert.equal(s.research_state, 'FOCUS');
  assert.equal(s.price_position.rsi6, 92);
  assert.equal(s.price_position.rsi14, 88);
  assert.equal(s.price_position.price_extension, false);
});

test('a live, tradable, executable confirmation is FOCUS', () => {
  const s = only(build([ctx()], [signal()]));
  assert.equal(s.research_state, 'FOCUS');
  assert.equal(s.research_ready, true);
  assert.deepEqual(s.trading_constraints, []);
});

test('a one-price limit-up live setup is WATCH: the price cannot be executed normally', () => {
  const s = only(build([ctx({ trading_status: 'ONE_PRICE_LIMIT_UP' })], [signal()]));
  assert.equal(s.research_state, 'WATCH');
  assert.ok(s.trading_constraints.includes('ONE_PRICE_LIMIT_UP'));
});

test('a non-mainboard stock with a live setup is WATCH / RESEARCH_ONLY', () => {
  const s = only(build([ctx({ ts_code: '688001.SH' })], [signal({ ts_code: '688001.SH' })]));
  assert.equal(s.research_state, 'WATCH');
  assert.equal(s.trade_permission, 'RESEARCH_ONLY');
  assert.equal(s.trade_permission_reason, 'STAR_RESEARCH_ONLY');
  assert.ok(s.trading_constraints.includes('RESEARCH_ONLY'));
});

test('forming-only is WATCH and states what has not happened yet', () => {
  const s = only(build([ctx()], [signal({ stage: 'FORMING', stage_detail: '平台形成', confirmed_on: null, research_ready: false })]));
  assert.equal(s.research_state, 'WATCH');
  assert.match(s.decisive_reasons.join(''), /仍在形成/);
  assert.deepEqual(s.watch_conditions, ['收盘价站上 10.50']);
});

// ------------------------------------------------------------------ invariants

test('one stock is one record, one state, even across all five families', () => {
  const signals = FAMILIES.map((family, i) => signal({ family, strategy_id: `s${i}` }));
  const u = build([ctx()], signals);
  const s = only(u);
  assert.equal(s.signals.length, 5);
  assert.equal(s.research_state, 'FOCUS');
  assert.equal(u.counts.total, 1);
  assert.equal(Object.entries(u.counts).filter(([k]) => k !== 'total').reduce((a, [, v]) => a + v, 0), 1);
  // States sort in display order; ties fall back to the confirmation date.
  assert.equal(u.stocks.length, 1);
});

test('counts sum to the stock total and ordering follows RESEARCH_STATE_ORDER', () => {
  const contexts = ['600001.SH', '600002.SH', '600003.SH', '600004.SH'].map(ts_code => ctx({ ts_code, name: ts_code }));
  const signals = [
    signal({ ts_code: '600001.SH', name: '600001.SH' }),
    signal({ ts_code: '600002.SH', name: '600002.SH', stage: 'FAILED', stage_detail: '失效', invalidated_at: '2026-10-31', invalidation: { on: '2026-10-31', reason: 'x' } }),
    signal({ ts_code: '600003.SH', name: '600003.SH', stage: 'FORMING', stage_detail: '形成', confirmed_on: null }),
    signal({ ts_code: '600004.SH', name: '600004.SH', stage: 'CONFIRMED', price_volume_tags: [] }),
  ];
  const u = build(contexts, signals);
  assert.equal(u.counts.total, 4);
  const sum = u.counts.FOCUS + u.counts.WATCH + u.counts.EXTENDED + u.counts.DETERIORATING + u.counts.BLOCKED + u.counts.INVALIDATED;
  assert.equal(sum, 4);
  const order = u.stocks.map(s => RESEARCH_STATE_ORDER[s.research_state]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('daily highlights are at most five and never include a blocked or dead stock', () => {
  const codes = Array.from({ length: 9 }, (_, i) => `60010${i}.SH`);
  const signals = codes.map(ts_code => signal({ ts_code, name: ts_code }));
  const contexts = codes.map((ts_code, i) =>
    ctx({ ts_code, name: ts_code, trading_status: i === 0 ? 'ONE_PRICE_LIMIT_DOWN' : 'TRADABLE' }));
  const u = build(contexts, signals);
  assert.ok(u.daily_highlights.length > 0 && u.daily_highlights.length <= 5);
  for (const code of u.daily_highlights) {
    const s = u.stocks.find(x => x.ts_code === code);
    assert.ok(s.research_state === 'FOCUS' || s.research_state === 'WATCH');
  }
  assert.ok(!u.daily_highlights.includes(codes[0]));
  assert.equal(highlightStocks(u).length, u.daily_highlights.length);
});

test('every stock record carries both dates of the dual-time contract', () => {
  const s = only(build([ctx()], [signal()]));
  assert.equal(s.signals[0].pattern_event_date, '2026-10-28');
  assert.equal(s.signals[0].first_observed_date, '2026-10-30');
  assert.notEqual(s.signals[0].pattern_event_date, s.signals[0].first_observed_date);
});

test('no cross-family score, priority, entry or ranking field exists on a stock record', () => {
  const s = only(build([ctx()], [signal()]));
  for (const forbidden of ['score', 'priority', 'entry_score', 'entry_view', 'entry_summary', 'rank', 'rank_score', 'confidence']) {
    assert.equal(forbidden in s, false, `stock record must not expose ${forbidden}`);
  }
  assert.deepEqual(Object.keys(s).sort(), [
    'as_of_trade_date', 'bars_behind_as_of', 'conflicting_evidence', 'counter_evidence',
    'decisive_reasons', 'evidence_level', 'market_regime', 'name', 'price_position',
    'price_volume_tags', 'primary_family', 'primary_pattern', 'research_ready',
    'research_state', 'research_state_label', 'rps120', 'sectors', 'signals', 'trade_date',
    'trade_permission', 'trade_permission_reason', 'trading_constraints', 'trading_status',
    'ts_code', 'watch_conditions',
  ]);
  assert.equal(s.price_position, null, 'no position snapshot when the primary signal has none');
});

test('the price position is carried on the stock and on every signal', () => {
  const s = only(build([ctx()], [signal({ price_position: position() })]));
  assert.equal(s.price_position.basis, 'adjusted_close');
  assert.equal(s.price_position.close, 11.5);
  assert.equal(s.signals[0].price_position.price_extension, true);
});

test('the aggregation is deterministic', () => {
  const contexts = [ctx(), ctx({ ts_code: '600009.SH', name: 'B' })];
  const signals = [signal(), signal({ ts_code: '600009.SH', name: 'B', family: 'REVERSAL', strategy_id: 'reversal_confirm' })];
  assert.deepEqual(build(contexts, signals), build(contexts, signals));
});

test('sectors are carried through for readability, and absence is an empty list', () => {
  const sectors = new Map([['600001.SH', ['SW2021:801080.SI']]]);
  const u = build([ctx(), ctx({ ts_code: '600002.SH', name: 'B' })],
    [signal(), signal({ ts_code: '600002.SH', name: 'B' })], sectors);
  assert.deepEqual(u.stocks.find(s => s.ts_code === '600001.SH').sectors, ['SW2021:801080.SI']);
  assert.deepEqual(u.stocks.find(s => s.ts_code === '600002.SH').sectors, []);
});
