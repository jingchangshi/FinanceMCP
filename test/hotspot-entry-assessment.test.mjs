// goal-1030 WP2: entry-timing assessment contract.
//
// Synthetic bars make the stage machine the variable; a second group runs the
// same module on the frozen 2026-10-29 sample so the production evidence is
// checked too. These are research states — never trade instructions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStrategyEvents } from '../build/ashare/strategies.js';
import { ENTRY_RULES_VERSION, ENTRY_MAX_DISTANCE_ATR } from '../build/ashare/entryAssessment.js';
import { loadFixture, replayStock, candidateByCode } from './hotspot-20261029-fixture.mjs';

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
    high20: N(n), bollUp: N(n), bollMid: N(n), bollWidth: N(n), atr14: N(n, 1),
  };
  for (const [k, v] of Object.entries(over)) x[k] = v;
  return x;
}

const scanAt = (code, b, x) => detectStrategyEvents(code, b, x, new Map(), b.dates.length - 1);
const family = (scan, fam) => scan.entry.entry_assessments.find(a => a.strategy_family === fam);

// ---------------------------------------------------------------- NEWLY_CONFIRMED

test('entry: a fresh breakout is NEWLY_CONFIRMED with an objective risk and reward', () => {
  const n = 100;
  const d = dates(n);
  const high = N(n, 100.5);
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[95] = 103; close[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) close[i] = 103;

  const scan = scanAt('600001.SH', mkBars(n, { dates: d, high, close, vol }), mkX(n));
  const bo = family(scan, 'BREAKOUT');
  assert.ok(bo, 'breakout family assessed');
  assert.equal(bo.entry_stage, 'NEWLY_CONFIRMED');
  assert.equal(bo.entry_eligibility, true);
  assert.equal(bo.confirmed_on, d[95]);
  assert.equal(bo.signal_age_trade_days, 4);
  assert.equal(bo.entry_trigger.reference_price, 103, 'reference = confirmation close');
  assert.equal(bo.entry_trigger.reference_kind, 'confirmation_close');
  assert.equal(bo.invalidation_condition.code, 'close_below_prior_high');
  assert.equal(bo.invalidation_condition.level, 100.5);
  assert.equal(bo.objective_risk_distance.price, 100.5);
  assert.equal(bo.reward_estimate.kind, 'measured_move');
  assert.equal(bo.reward_estimate.price, 104, 'entry + box height (100.5 − 99.5)');
  assert.equal(bo.risk_reward, 0.4, 'reward 1 / risk 2.5');
  assert.equal(bo.analysis_version, ENTRY_RULES_VERSION);
  assert.equal(scan.entry.entry_stage, 'NEWLY_CONFIRMED');
});

test('entry: the score is exactly reproducible from its recorded contributions', () => {
  const n = 100;
  const high = N(n, 100.5);
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[95] = 103; close[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) close[i] = 103;
  const scan = scanAt('600001.SH', mkBars(n, { high, close, vol }), mkX(n));
  const bo = family(scan, 'BREAKOUT');
  const sum = 100 + bo.ranking_contributions.reduce((s, c) => s + c.points, 0);
  const expected = Math.round(Math.max(0, Math.min(100, sum)) * 100) / 100;
  assert.equal(bo.entry_score, expected);
  assert.ok(bo.ranking_contributions.every(c => Number.isFinite(c.points)));
  assert.deepEqual(bo.ranking_contributions.map(c => c.factor),
    ['distance', 'hard_risk', 'soft_risk', 'age', 'data_quality', 'stage', 'risk_reward']);
  // R/R 0.4 ⇒ a shortfall of 13 points; a ratio of 3 or better costs nothing.
  const rr = bo.ranking_contributions.find(c => c.factor === 'risk_reward');
  assert.equal(rr.raw, 0.4);
  assert.equal(rr.points, -13);
});

test('entry: a stop inside one bar of noise flags the ratio HIGH and earns no points', () => {
  const n = 100;
  const high = N(n, 102.98); // breakout of a level only 0.02 ATR below the close
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[95] = 103; close[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) close[i] = 103;
  const bo = family(scanAt('600001.SH', mkBars(n, { high, close, vol }), mkX(n)), 'BREAKOUT');
  assert.equal(bo.entry_stage, 'NEWLY_CONFIRMED');
  assert.ok(bo.risk_reward > 50, `inflated ratio ${bo.risk_reward} is still reported`);
  assert.equal(bo.risk_reward_uncertainty, 'HIGH', 'but it is not presented as usable');
  assert.equal(bo.ranking_contributions.find(c => c.factor === 'risk_reward').points, -15,
    'an unusable ratio earns no credit');
});

// ---------------------------------------------------------------- EXTENDED

test('entry: price more than 1 ATR past the entry reference is EXTENDED, not eligible', () => {
  const n = 100;
  const high = N(n, 100.5);
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[95] = 103; close[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) close[i] = 103;
  close[99] = 103 + ENTRY_MAX_DISTANCE_ATR + 1; // 2 ATR above the confirmation close

  const scan = scanAt('600001.SH', mkBars(n, { high, close, vol }), mkX(n));
  const bo = family(scan, 'BREAKOUT');
  assert.equal(bo.entry_stage, 'EXTENDED');
  assert.equal(bo.entry_eligibility, false);
  assert.ok(bo.rejection_reasons.includes('ENTRY_TOO_FAR'));
  assert.equal(scan.entry.entry_eligibility, false);
});

// ---------------------------------------------------------------- RISK_BLOCKED vs soft

test('entry: a hard risk blocks entry; a bearish divergence only warns', () => {
  const n = 100;
  const d = dates(n);
  const high = N(n, 100.5);
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[95] = 103; close[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) close[i] = 103;
  // overheated on the as-of-1 bar: rsi6 > 85 and cci14 > 200
  const rsi6 = N(n); const cci14 = N(n);
  rsi6[98] = 90; cci14[98] = 250;

  const hot = scanAt('600001.SH',
    mkBars(n, { dates: d, high, close, vol }), mkX(n, { rsi6, cci14 }));
  const bo = family(hot, 'BREAKOUT');
  assert.equal(bo.entry_stage, 'RISK_BLOCKED');
  assert.equal(bo.entry_eligibility, false);
  assert.ok(bo.rejection_reasons.includes('HARD_RISK_CONFLICT'));

  // Same breakout, but the risk is a bearish divergence after confirmation.
  const low = N(n, 99.5);
  const high2 = high.slice();
  high2[97] = 106; // new high on a lower DIF
  const open2 = close.slice();
  open2[97] = 104; // down bar, required by the divergence rule
  const dif = N(n, -1);
  dif[60] = 5; // the "past" extreme has a high DIF
  dif[97] = -2;
  const bear = scanAt('600001.SH',
    mkBars(n, { dates: d, high: high2, close, low, vol, open: open2 }),
    mkX(n, { dif }));
  const bo2 = family(bear, 'BREAKOUT');
  assert.ok(bo2.soft_risk_warnings.some(w => w.startsWith('macd_bear_divergence')),
    'divergence recorded as soft evidence');
  assert.notEqual(bo2.entry_stage, 'RISK_BLOCKED', 'soft risk never blocks by itself');
});

// ---------------------------------------------------------------- PREPARING

test('entry: a pattern that has not confirmed is PREPARING and not an entry candidate', () => {
  const n = 100;
  const high = N(n, 100.5);
  const close = N(n, 100.2); // pressing the prior high, no breakout
  const scan = scanAt('600001.SH', mkBars(n, { high, close }), mkX(n));
  const bo = family(scan, 'BREAKOUT');
  assert.ok(bo);
  assert.equal(bo.entry_stage, 'PREPARING');
  assert.equal(bo.confirmed_on, null, 'no confirmation date yet');
  assert.equal(bo.entry_trigger.reference_price, 100.5);
  assert.equal(bo.reward_estimate.kind, 'none', 'no measured move before confirmation');
  assert.equal(bo.entry_eligibility, false, 'PREPARING is watchable, never an entry candidate');
  assert.deepEqual(bo.rejection_reasons, ['NOT_CONFIRMED']);
  assert.equal(bo.entry_score < 100, true, 'unconfirmed evidence carries the stage penalty');
  assert.equal(scan.entry.entry_stage, 'PREPARING');
  assert.equal(scan.entry.entry_eligibility, false);
});

test('entry: an unconfirmed pattern far from its trigger scores below one pressing it', () => {
  const n = 140;
  // Compressed bands with the upper band at 110: the squeeze trigger is 110.
  const squeeze = { bollUp: N(n, 110), bollMid: N(n, 100), bollWidth: N(n, 0.01) };
  const near = scanAt('600001.SH', mkBars(n, { close: N(n, 109.6) }), mkX(n, squeeze));
  const far = scanAt('600001.SH', mkBars(n, { close: N(n, 95) }), mkX(n, squeeze)); // 15 ATR below
  const a = family(near, 'BREAKOUT');
  const b = family(far, 'BREAKOUT');
  assert.equal(a.entry_stage, 'PREPARING');
  assert.equal(b.entry_stage, 'PREPARING');
  assert.equal(a.entry_trigger.reference_price, 110);
  assert.ok(b.entry_score < a.entry_score,
    `far ${b.entry_score} must rank below near ${a.entry_score}`);
  // Proximity is measured in both directions for an unconfirmed pattern.
  const dist = b.ranking_contributions.find(c => c.factor === 'distance');
  assert.ok(dist.points <= -30, `far pattern distance penalty ${dist.points}`);
});

// ---------------------------------------------------------------- permission

test('entry: non-mainboard names stay ineligible for entry research', () => {
  const n = 100;
  const high = N(n, 100.5);
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[95] = 103; close[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) close[i] = 103;
  const scan = scanAt('300001.SZ', mkBars(n, { high, close, vol }), mkX(n));
  const bo = family(scan, 'BREAKOUT');
  assert.equal(bo.entry_stage, 'NEWLY_CONFIRMED');
  assert.equal(bo.entry_eligibility, false);
  assert.ok(bo.rejection_reasons.includes('RESEARCH_ONLY_PERMISSION'));
});

// ---------------------------------------------------------------- risk ordering

test('entry: a breakdown before confirmation is superseded; one after it blocks', () => {
  const n = 100;
  const d = dates(n);
  const baseHigh = N(n, 100.5);
  const baseClose = N(n, 100);
  const vol = N(n, 100000);
  baseHigh[95] = 103; baseClose[95] = 103; vol[95] = 200000;
  for (let i = 96; i < n; i++) baseClose[i] = 103;

  // ma60 cross below on bar 90 — strictly BEFORE the 95 confirmation.
  const before = N(n, 90);
  for (let i = 90; i <= 94; i++) before[i] = 110;
  const a = family(scanAt('600001.SH',
    mkBars(n, { dates: d, high: baseHigh, close: baseClose, vol }), mkX(n, { ma60: before })), 'BREAKOUT');
  assert.equal(a.entry_stage, 'NEWLY_CONFIRMED', 'a pre-confirmation breakdown is history, not a veto');
  assert.deepEqual(a.hard_invalidations, []);

  // Same breakout, but the trend breaks on bar 97 — AFTER the confirmation.
  const after = N(n, 90);
  for (let i = 97; i < n; i++) after[i] = 110;
  const b = family(scanAt('600001.SH',
    mkBars(n, { dates: d, high: baseHigh, close: baseClose, vol }), mkX(n, { ma60: after })), 'BREAKOUT');
  assert.equal(b.entry_stage, 'RISK_BLOCKED');
  assert.equal(b.entry_eligibility, false);
  assert.ok(b.rejection_reasons.includes('HARD_RISK_CONFLICT'));
  assert.ok(b.entry_score !== null && b.entry_score < (a.entry_score ?? 0),
    'blocked setup scores below the clean one');
});

// ---------------------------------------------------------------- W bottom geometry

test('entry: an invalidated W-bottom is INVALIDATED and never invents a reward', () => {
  const n = 120;
  const d = dates(n);
  const close = N(n, 100);
  const dif = N(n, 0);
  for (let i = 0; i <= 40; i++) dif[i] = -(i / 40);
  for (let i = 41; i <= 55; i++) dif[i] = -1 + 1.2 * ((i - 40) / 15);
  for (let i = 56; i <= 70; i++) dif[i] = 0.2 - 1.1 * ((i - 55) / 15);
  dif[75] = 0.3; dif[74] = 0.15;
  for (let i = 76; i < n; i++) dif[i] = 0.3 + (i - 75) * 0.01;
  dif[100] = -1.1;
  for (let i = 101; i < n; i++) dif[i] = -1.0 + (i - 100) * 0.01;

  const scan = scanAt('600001.SH', mkBars(n, { dates: d, close }), mkX(n, { dif }));
  const rev = family(scan, 'REVERSAL');
  assert.ok(rev);
  assert.equal(rev.entry_stage, 'INVALIDATED');
  assert.deepEqual(rev.hard_invalidations, ['dif_below_w_lows']);
  assert.equal(rev.entry_eligibility, false);
  assert.equal(rev.risk_reward, null);
  assert.equal(rev.reward_estimate.kind, 'none');
});

// ---------------------------------------------------------------- frozen sample

test('entry: 2026-10-29 production sample keeps soft risk soft and empty families empty', async () => {
  const fx = loadFixture();
  const ping = await replayStock('000001.SZ', fx);
  const pingTrend = family(ping.scan, 'TREND_CONTINUATION');
  assert.ok(pingTrend);
  // A trend_breakdown one bar BEFORE the confirmation is superseded by it: the
  // confirmation contract re-established the trend, so it may not veto entry.
  assert.deepEqual(pingTrend.hard_invalidations, []);
  assert.ok(['NEWLY_CONFIRMED', 'PULLBACK_READY', 'EXTENDED'].includes(pingTrend.entry_stage),
    `平安 trend stage ${pingTrend.entry_stage}`);

  const wu = await replayStock('301234.SZ', fx);
  const wuTrend = family(wu.scan, 'TREND_CONTINUATION');
  assert.ok(wuTrend);
  assert.ok(wuTrend.soft_risk_warnings.some(w => w.startsWith('macd_bear_divergence@20261029')));
  assert.notEqual(wuTrend.entry_stage, 'RISK_BLOCKED', 'a divergence is not a block');

  // 艾艾精工: the W-bottom is history, so nothing is entry-eligible. Whatever
  // forming pattern exists (a squeeze) stays PREPARING — watchable, not an entry.
  const ai = await replayStock('603580.SH', fx);
  assert.equal(ai.scan.events.some(e => e.status === 'active' || e.status === 'confirmed'), false,
    'no live signal on the as-of bar');
  assert.equal(ai.scan.entry.entry_eligibility, false);
  assert.ok(ai.scan.entry.entry_assessments.every(a => a.entry_eligibility === false));
  const aiReversal = family(ai.scan, 'REVERSAL');
  assert.notEqual(aiReversal.entry_stage, 'NEWLY_CONFIRMED');
  assert.ok(['PREPARING', null].includes(ai.scan.entry.entry_stage),
    `艾艾 rollup ${ai.scan.entry.entry_stage}`);

  // The frozen snapshot itself must not claim entry fields that predate WP2.
  const stored = candidateByCode(fx.snapshot, '000001.SZ');
  assert.equal('entry_stage' in stored, false);
});
