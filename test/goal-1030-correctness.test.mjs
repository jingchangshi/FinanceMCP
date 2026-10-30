// goal-1030 WP6.1: the twelve correctness requirements, one test each.
//
// This file is the auditable checklist: `WP6.1-NN` maps 1:1 to the requirement
// list in the work order. Each test asserts the property at the layer that owns
// it (state machine, assessment, ranking, point-in-time membership) and uses
// either hand-built bars or the frozen 2026-10-29 fixture — never a live DB.
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStrategyEvents } from '../build/ashare/strategies.js';
import { activeSwMembers } from '../build/ashare/industryClassification.js';
import { buildEntryView, classifyCandidate } from '../build/ashare/entryRanking.js';
import { loadFixture, replayStock, AS_OF } from './hotspot-20261029-fixture.mjs';

const N = (n, v = Number.NaN) => new Array(n).fill(v);

function dates(n) {
  const out = [];
  const d = new Date(Date.UTC(2025, 0, 1));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function mkBars(n, o = {}) {
  const arr = (v, d) => (Array.isArray(v) ? v.slice() : N(n, v ?? d));
  const close = arr(o.close, 100);
  const open = arr(o.open, close);
  const high = Array.isArray(o.high) ? o.high.slice() : close.map(c => c + 0.5);
  const low = Array.isArray(o.low) ? o.low.slice() : close.map(c => c - 0.5);
  const vol = arr(o.vol, 100000);
  return {
    dates: o.dates ?? dates(n), open, high, low, close, vol,
    amount: close.map(c => c * 1000), rawOpen: open.slice(), rawClose: close.slice(),
    upLimit: close.map(c => c * 1.1), adjMissing: 0,
  };
}

function mkX(n, over = {}) {
  const x = {
    dif: N(n), dea: N(n), ma5: N(n), ma20: N(n), ma60: N(n),
    rsi14: N(n), rsi6: N(n), cci14: N(n), volMa20: N(n, 100000),
    high20: N(n), bollUp: N(n), bollMid: N(n), bollWidth: N(n), atr14: N(n),
  };
  for (const [k, v] of Object.entries(over)) x[k] = v;
  return x;
}

/** A pullback-resume cycle: touch MA20, resume, then break MA60. */
function cycleBars(n, touches, resumeAt, invalidAt) {
  const close = N(n, 101);
  const low = N(n, 101.5);
  for (const k of touches) low[k] = 100.5;
  if (resumeAt !== null) close[resumeAt] = 102;
  if (invalidAt !== null) close[invalidAt] = 85;
  return mkBars(n, { close, low });
}

// ---------------------------------------------------------------- 01

test('WP6.1-01: a historical bullish signal is invalidated deterministically', () => {
  const n = 130;
  const d = dates(n);
  const bars = cycleBars(n, [64, 65, 66, 67, 68], 69, 75);
  const x = mkX(n, { ma20: N(n, 100), ma60: N(n, 90) });
  const scan = detectStrategyEvents('600001.SH', bars, x, new Map(), 90);
  const trend = [...scan.events].reverse().find(e => e.strategy_id === 'tc_pullback_resume');
  assert.ok(trend, 'the pullback-resume must produce a trend signal');
  assert.equal(trend.status, 'invalidated', 'close below MA60 invalidates it');
  assert.equal(trend.invalidated_on, d[75], 'the invalidation date is the bar that fired, not today');
  assert.equal(trend.invalidation_reason, 'close_below_ma60');
  assert.equal(trend.signal_age_trade_days, 6, 'age freezes at the invalidation bar');
});

// ---------------------------------------------------------------- 02

test('WP6.1-02: re-confirmation after invalidation gets a new identity; the old one never revives', () => {
  const n = 130;
  const d = dates(n);
  const close = N(n, 101);
  const low = N(n, 101.5);
  for (let i = 64; i <= 68; i++) low[i] = 100.5;
  close[69] = 102;
  close[75] = 85;
  for (let i = 76; i <= 79; i++) close[i] = [86, 95, 101, 101][i - 76];
  for (let i = 80; i <= 84; i++) low[i] = 100.5;
  close[85] = 102;
  const bars = mkBars(n, { close, low });
  const x = mkX(n, { ma20: N(n, 100), ma60: N(n, 90) });
  const scan = detectStrategyEvents('600001.SH', bars, x, new Map(), 95);
  const trend = scan.events.filter(e => e.strategy_id === 'tc_pullback_resume');
  assert.ok(trend.length >= 2, 'two cycles ⇒ two signals');

  const first = trend.find(e => e.confirmed_on === d[69]);
  const second = trend.find(e => e.confirmed_on === d[85]);
  assert.ok(first && second, 'both confirmations are recorded at their own dates');
  assert.notEqual(first.signal_id, second.signal_id, 'a new confirmation is a new identity');
  assert.equal(first.status, 'invalidated', 'the first cycle stays dead');
  assert.notEqual(second.status, 'invalidated', 'the second cycle is live on its own evidence');
});

// ---------------------------------------------------------------- 03

test('WP6.1-03: a bearish divergence is a soft warning, never a substitute for invalidation', async () => {
  const fixture = loadFixture();
  const { scan } = await replayStock('301234.SZ', fixture);
  const withDivergence = scan.entry.entry_assessments.filter(a =>
    a.soft_risk_warnings.some(w => /bear_divergence/.test(w)));
  assert.ok(withDivergence.length > 0, 'the 10-29 sample carries a bearish divergence (五洲医疗)');
  for (const a of withDivergence) {
    assert.ok(!a.hard_invalidations.some(w => /bear_divergence/.test(w)),
      'divergence must not be promoted to a hard invalidation');
    assert.notEqual(a.entry_stage, 'INVALIDATED', 'a divergence alone does not kill the setup');
  }
});

// ---------------------------------------------------------------- 04

test('WP6.1-04: same-family indicators are one conclusion, never independent evidence', async () => {
  const fixture = loadFixture();
  const { scan } = await replayStock('601857.SH', fixture);
  const byFamily = new Map();
  for (const a of scan.entry.entry_assessments) {
    byFamily.set(a.strategy_family, (byFamily.get(a.strategy_family) ?? 0) + 1);
    const factors = a.ranking_contributions.map(c => c.factor);
    assert.equal(new Set(factors).size, factors.length,
      `family ${a.strategy_family} must not score the same factor twice`);
  }
  for (const [family, count] of byFamily) {
    assert.equal(count, 1, `family ${family} produces exactly one assessment`);
  }
});

// ---------------------------------------------------------------- 05

test('WP6.1-05: an old confirmation cannot pose as today’s new signal', async () => {
  const fixture = loadFixture();
  for (const c of fixture.snapshot.candidates) {
    for (const s of c.signals ?? []) {
      assert.ok(s.confirmed_on <= AS_OF, `${c.ts_code} ${s.strategy_id} confirmed in the future`);
      assert.ok(s.confirmed_on < AS_OF,
        `${c.ts_code} ${s.strategy_id} is confirmed on the as-of day and would read as brand new`);
    }
  }
  // The assessment's own age field must agree with its dates. 600519 is the
  // control here: every signal it carries was confirmed earlier, so no old
  // confirmation may surface as a same-day (age 0) "new" one.
  const { scan } = await replayStock('600519.SH', fixture);
  assert.ok(scan.entry.entry_assessments.length > 0);
  for (const a of scan.entry.entry_assessments) {
    if (a.confirmed_on === null) continue;
    assert.ok(a.confirmed_on <= a.as_of_trade_date, 'confirmed_on never exceeds the as-of date');
    assert.ok(a.signal_age_trade_days === null || a.signal_age_trade_days > 0,
      '600519 carries no same-day confirmation, so no assessment may claim age 0');
  }
});

// ---------------------------------------------------------------- 06

test('WP6.1-06: the ranking explanation reproduces the final entry score exactly', async () => {
  const fixture = loadFixture();
  let checked = 0;
  for (const code of Object.keys(fixture.bars).slice(0, 6)) {
    const { scan } = await replayStock(code, fixture);
    for (const a of scan.entry.entry_assessments) {
      if (a.entry_score === null) {
        assert.deepEqual(a.ranking_contributions, [], 'an unscored assessment explains nothing');
        continue;
      }
      const sum = a.ranking_contributions.reduce((t, c) => t + c.points, 0);
      const reproduced = Math.max(0, Math.min(100, 100 + sum));
      assert.ok(Math.abs(reproduced - a.entry_score) <= 0.05,
        `${code} ${a.strategy_family}: 100 + Σpoints = ${reproduced.toFixed(2)} ≠ ${a.entry_score}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'the fixture must contain scored assessments');
});

// ---------------------------------------------------------------- 07

test('WP6.1-07: a high score never buys a place in the entry pool without eligibility', () => {
  const cand = (over = {}) => ({
    as_of: AS_OF, ts_code: '600000.SH', name: '测试', instrument_type: 'STOCK',
    primary_sector: null, sectors: [], etf_sources: [], multi_etf: false,
    leaderships: [], leader_evidence: [], signals: [], risk_events: [],
    trade_permission: 'EXECUTABLE', trade_permission_reason: 'MAINBOARD_OK',
    pool: 'FOCUS', inclusion_reason: 'x', priority: 99, priority_reason: 'p',
    research_score: 0.9, data_quality: 'OK', entry_stage: null, entry_eligibility: false,
    entry_score: null, entry_assessments: [], entry_rejection_reasons: [], ...over,
  });
  const view = buildEntryView([
    cand({ ts_code: '600001.SH', entry_stage: 'EXTENDED', entry_score: 99, entry_rejection_reasons: ['ENTRY_TOO_FAR'] }),
    cand({ ts_code: '600002.SH', entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true, entry_score: 88 }),
  ], AS_OF);
  assert.deepEqual(view.entry_top10.map(e => e.ts_code), ['600002.SH'],
    '99 分但已延伸的候选不得进入入场池');
});

// ---------------------------------------------------------------- 08

test('WP6.1-08: a day with no qualified candidate returns zero, not a substitute', () => {
  const view = buildEntryView([], AS_OF);
  assert.deepEqual(view.entry_top10, []);
  assert.deepEqual(view.preparing_top, []);
  assert.deepEqual(view.rejected_high_rank, []);
  assert.equal(Object.values(view.counts).reduce((a, b) => a + b, 0), 0);
  assert.ok(view.definition_note.length > 0, 'the empty answer still explains itself');
});

// ---------------------------------------------------------------- 09

test('WP6.1-09: non-mainboard names stay research-only, whatever their score', () => {
  const base = {
    as_of: AS_OF, ts_code: '688001.SH', name: '科创板', instrument_type: 'STOCK',
    primary_sector: null, sectors: [], etf_sources: [], multi_etf: false,
    leaderships: [], leader_evidence: [], signals: [], risk_events: [],
    trade_permission: 'RESEARCH_ONLY', trade_permission_reason: 'STAR_RESEARCH_ONLY',
    pool: 'FOCUS', inclusion_reason: 'x', priority: 90, priority_reason: 'p',
    research_score: 0.8, data_quality: 'OK', entry_stage: 'NEWLY_CONFIRMED',
    entry_eligibility: true, entry_score: 100, entry_assessments: [], entry_rejection_reasons: [],
  };
  const c = classifyCandidate(base);
  assert.equal(c.candidate_class, 'RESEARCH_ONLY');
  assert.equal(c.entry_eligibility, false, 'a 100-point STAR name is still not executable');
  assert.ok(c.eligibility_reasons.includes('RESEARCH_ONLY_PERMISSION'));
});

// ---------------------------------------------------------------- 10

test('WP6.1-10: missing or unusable data never fabricates a confirmation', () => {
  const n = 130;
  const bars = cycleBars(n, [64, 65, 66, 67, 68], 69, null);
  // Kill the data the trigger needs: no MA20/MA60/ATR at all.
  const blind = detectStrategyEvents('600001.SH', bars, mkX(n), new Map(), 90);
  assert.equal(blind.events.length, 0, 'without indicators there is no confirmation');
  assert.equal(blind.entry.entry_eligibility, false, 'nothing unconfirmed may be eligible');
  assert.ok(blind.entry.entry_stage !== 'NEWLY_CONFIRMED' && blind.entry.entry_stage !== 'PULLBACK_READY',
    'no data must never produce an eligible stage');
  assert.ok(blind.entry.rejection_reasons.length > 0, 'the refusal states a reason');

  // A truncated series (fewer bars than any window) must also stay silent.
  const shortBars = mkBars(20, {});
  const short = detectStrategyEvents('600001.SH', shortBars, mkX(20, { ma20: N(20, 100), ma60: N(20, 90) }), new Map(), 19);
  assert.equal(short.events.length, 0, 'insufficient history is not a signal');
});

// ---------------------------------------------------------------- 11

test('WP6.1-11: industry membership is point-in-time, never backfilled', () => {
  const rows = [
    { ts_code: '600001.SH', l1_code: '801010.SI', l1_name: 'A', in_date: '20200101', out_date: null, collected_at: '20260101' },
    { ts_code: '600002.SH', l1_code: '801010.SI', l1_name: 'A', in_date: '20261101', out_date: null, collected_at: '20260101' },
    { ts_code: '600003.SH', l1_code: '801010.SI', l1_name: 'A', in_date: '20200101', out_date: '20260601', collected_at: '20260101' },
    { ts_code: '600004.SH', l1_code: '801010.SI', l1_name: 'A', in_date: 'BAD', out_date: null, collected_at: '20260101' },
  ];
  const active = activeSwMembers(rows, '20261029').map(r => r.ts_code);
  assert.deepEqual(active, ['600001.SH'],
    'not-yet-member, already-left and malformed rows are all excluded as of 20261029');
});

// ---------------------------------------------------------------- 12

test('WP6.1-12: the entry ranking is independent of the official watchlist', () => {
  const cand = (over) => ({
    as_of: AS_OF, ts_code: '600000.SH', name: '测试', instrument_type: 'STOCK',
    primary_sector: null, sectors: [], etf_sources: [], multi_etf: false,
    leaderships: [], leader_evidence: [], signals: [], risk_events: [],
    trade_permission: 'EXECUTABLE', trade_permission_reason: 'MAINBOARD_OK',
    pool: 'RAW', inclusion_reason: 'x', priority: 50, priority_reason: 'p',
    research_score: 0.5, data_quality: 'OK', entry_stage: null, entry_eligibility: false,
    entry_score: null, entry_assessments: [], entry_rejection_reasons: [], ...over,
  });
  // A RAW candidate (never in FOCUS, never on the watchlist) can be entry-eligible…
  const view = buildEntryView([
    cand({ ts_code: '600010.SH', pool: 'RAW', entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true, entry_score: 80 }),
    cand({ ts_code: '600011.SH', pool: 'FOCUS', priority: 99, entry_stage: 'EXTENDED', entry_score: 99 }),
  ], AS_OF);
  assert.deepEqual(view.entry_top10.map(e => e.ts_code), ['600010.SH'],
    'entry eligibility does not require FOCUS/watchlist membership');
  // …and the watchlist-facing research ranking is untouched by entry fields.
  assert.deepEqual(view.research_top10.map(e => e.ts_code), ['600011.SH', '600010.SH'],
    'research_top10 still ranks by priority alone');
});
