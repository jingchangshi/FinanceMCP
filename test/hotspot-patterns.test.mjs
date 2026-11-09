// goal-1028 P6.1: pattern-detector time semantics. The contract under test:
// (1) an event dated at confirmation is only visible from the confirmation
// bar onward, (2) scanning a truncated series equals scanning the full series
// and looking only at events with confirmed_on <= truncation date (no look-
// ahead, no backdating), (3) invalidation is captured once the breaching bar
// exists. Pure module ⇒ imported straight from build with no DB.
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  confirmedLocalLows, detectWBottom, detectRangeBreakout, detectPullbackResume,
  detectPullbackForming, detectRpsHold,
  DEFAULT_MACD_W_OPTS, DEFAULT_RSI_W_OPTS, DEFAULT_RANGE_BREAKOUT_OPTS,
} = await import('../build/ashare/patterns.js');

// ---------------------------------------------------------------- fixtures

/** Series of length n filled with `fill`, with a shaped segment. */
function series(n, fill, shape = {}) {
  const v = new Array(n).fill(fill);
  for (const [idx, val] of Object.entries(shape)) v[Number(idx)] = val;
  return v;
}

/**
 * A textbook DIF double bottom on a 120-bar series:
 *  - declines into low A at bar 40 (value -1.0)
 *  - recovers to neckline 0.2 at bar 55
 *  - falls into low B at bar 70 (value -0.9)
 *  - crosses above the neckline at bar 75 (value 0.3) — confirmation bar
 *  - keeps rising; at bar 100 drops to -1.1 (invalidation) when requested
 */
function difW({ invalidate = false, noSecondTouch = false, noCross = false } = {}) {
  const n = 120;
  const v = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i < 40) v[i] = -0.05 * i;                    // slide to A: -2.0 at 40... reshape below
  }
  // explicit shape
  for (let i = 0; i < n; i++) v[i] = 0;
  for (let i = 0; i <= 40; i++) v[i] = -(i / 40);            // -1.0 at 40
  for (let i = 41; i <= 55; i++) v[i] = -1 + 1.2 * ((i - 40) / 15); // rise to 0.2
  for (let i = 56; i <= 70; i++) v[i] = 0.2 - 1.1 * ((i - 55) / 15); // fall to -0.9
  for (let i = 71; i < n; i++) v[i] = -0.9 + (i - 70) * 0.05;       // rise
  if (!noCross) {
    v[75] = 0.3; v[74] = 0.15;                                  // cross neckline 0.2 at 75
    for (let i = 76; i < n; i++) v[i] = 0.3 + (i - 75) * 0.01;   // hold above
  } else {
    for (let i = 71; i < n; i++) v[i] = Math.min(v[i], 0.15);    // never cross 0.2
  }
  if (noSecondTouch) {
    for (let i = 56; i <= 70; i++) v[i] = 0.2 - 0.5 * ((i - 55) / 15); // second dip only to -0.3 (proximity fail vs -1.0)
    for (let i = 71; i < n; i++) v[i] = -0.3 + (i - 70) * 0.05;        // continue from the shallow dip (no discontinuity)
    if (!noCross) { v[75] = 0.3; v[74] = 0.15; for (let i = 76; i < n; i++) v[i] = 0.3 + (i - 75) * 0.01; }
  }
  if (invalidate) {
    v[100] = -1.1;
    for (let i = 101; i < n; i++) v[i] = -1.0 + (i - 100) * 0.01;
  }
  return v;
}

// ---------------------------------------------------------------- local lows

test('confirmedLocalLows requires full neighborhood and K-bar lag', () => {
  const v = series(50, 1);
  v[20] = -1; // clear unique low at 20
  const opts = { L: 5, K: 5 };
  // At i=24: neighborhood [15,25] not fully observable (20+5=25 > 24) ⇒ not confirmed
  assert.equal(confirmedLocalLows(v, 24, opts).some(l => l.index === 20), false);
  // At i=25: neighborhood observable, K=5 satisfied (20+5=25) ⇒ confirmed
  assert.equal(confirmedLocalLows(v, 25, opts).some(l => l.index === 20), true);
});

test('confirmedLocalLows is truncation-invariant: result at i identical on prefix', () => {
  const v = difW();
  const opts = DEFAULT_MACD_W_OPTS;
  for (const i of [60, 80, 100, 119]) {
    const full = confirmedLocalLows(v, i, opts).map(l => `${l.index}:${l.value}`);
    const prefix = confirmedLocalLows(v.slice(0, i + 1), i, opts).map(l => `${l.index}:${l.value}`);
    assert.deepEqual(prefix, full, `truncation mismatch at i=${i}`);
  }
});

// ---------------------------------------------------------------- W bottom

test('W bottom: signal dated at neckline cross (i=75), never the formation low', () => {
  const v = difW();
  // Unconfirmed before the cross: detect at i=74 must return null for this pair
  // (no neckline cross yet).
  assert.equal(detectWBottom(v, 74, DEFAULT_MACD_W_OPTS), null);
  // Confirmed at 75.
  const w = detectWBottom(v, 75, DEFAULT_MACD_W_OPTS);
  assert.ok(w, 'confirmed at cross bar');
  assert.equal(w.confirmIndex, 75);
  assert.equal(w.j1, 40);
  assert.equal(w.j2, 70);
  assert.ok(w.confirmIndex - w.j2 >= DEFAULT_MACD_W_OPTS.K, 'confirmation lag ≥ K bars after second low');
});

test('W bottom: unconfirmed pattern is invisible; confirmed pattern persists with identical dates', () => {
  const v = difW();
  assert.equal(detectWBottom(v, 70, DEFAULT_MACD_W_OPTS), null, 'formed but not crossed');
  const at75 = detectWBottom(v, 75, DEFAULT_MACD_W_OPTS);
  const at90 = detectWBottom(v, 90, DEFAULT_MACD_W_OPTS);
  assert.ok(at75 && at90);
  assert.equal(at90.confirmIndex, at75.confirmIndex, 'confirm date stable across later evaluations');
  assert.equal(at90.j1, at75.j1);
  assert.equal(at90.j2, at75.j2);
});

test('W bottom: truncation-invariant — scanning a prefix never reveals the event early', () => {
  const v = difW();
  for (let i = 0; i < v.length; i++) {
    const full = detectWBottom(v, i, DEFAULT_MACD_W_OPTS);
    const prefix = detectWBottom(v.slice(0, i + 1), i, DEFAULT_MACD_W_OPTS);
    if (full === null) { assert.equal(prefix, null, `i=${i}`); continue; }
    assert.equal(prefix.confirmIndex, full.confirmIndex, `i=${i} confirm`);
    assert.equal(prefix.j1, full.j1, `i=${i} j1`);
    assert.equal(prefix.j2, full.j2, `i=${i} j2`);
  }
});

test('W bottom: invalidation captured once the breaching bar exists', () => {
  const v = difW({ invalidate: true });
  const w = detectWBottom(v, 119, DEFAULT_MACD_W_OPTS);
  assert.ok(w);
  assert.equal(w.invalidateIndex, 100);
  assert.ok(w.invalidateBelow <= -0.9);
  // Before the breach exists the same pattern reports intact.
  const before = detectWBottom(v.slice(0, 100), 99, DEFAULT_MACD_W_OPTS);
  assert.ok(before);
  assert.equal(before.invalidateIndex, null);
});

test('W bottom: no confirmation ⇒ no event even 40 bars later (asymmetric failure)', () => {
  const v = difW({ noCross: true });
  assert.equal(detectWBottom(v, 119, DEFAULT_MACD_W_OPTS), null);
});

test('W bottom: second low far from first (proximity) ⇒ rejected', () => {
  const v = difW({ noSecondTouch: true });
  assert.equal(detectWBottom(v, 119, DEFAULT_MACD_W_OPTS), null);
});

test('W bottom RSI: both lows must be below the ceiling', () => {
  // Build a W on RSI-like values where lows are 55/54 — above ceiling 40 ⇒ null.
  const n = 120;
  const v = new Array(n).fill(50);
  for (let i = 30; i <= 40; i++) v[i] = 55 - (i - 30);      // low 45 at 40? shape to 55-ish lows
  for (let i = 40; i <= 55; i++) v[i] = 45 + (i - 40) * 0.4; // rise to 51
  for (let i = 56; i <= 70; i++) v[i] = 51 - (i - 55) * 0.4; // fall to 45
  v[40] = 45; v[70] = 45.2;
  for (let i = 71; i < n; i++) v[i] = 45.2 + (i - 70) * 1.5;
  assert.equal(detectWBottom(v, 119, DEFAULT_RSI_W_OPTS), null, 'lows above ceiling 40');
  // Same shape shifted down below the ceiling ⇒ confirmable.
  const shifted = v.map(x => x - 20); // lows ~25, neckline ~31
  const w = detectWBottom(shifted, 119, DEFAULT_RSI_W_OPTS);
  assert.ok(w, 'lows below ceiling confirm');
});

// ---------------------------------------------------------------- range breakout

test('range breakout: requires prior-window high exclude and volume; first-cross only', () => {
  const n = 100;
  const high = series(n, 10), low = series(n, 9), close = series(n, 9.5);
  const vol = series(n, 100), volMa = series(n, 100);
  // Flat 60-day range: high 10, low 9. Break at i=80.
  high[80] = 11; close[80] = 10.8; vol[80] = 150;
  const r = detectRangeBreakout(high, low, close, vol, volMa, 80, DEFAULT_RANGE_BREAKOUT_OPTS);
  assert.ok(r, 'break confirmed');
  assert.equal(r.breakIndex, 80);
  assert.equal(r.priorHigh, 10, 'today excluded from the prior window');
  assert.ok(r.volRatio >= 1.2);
  // Day 81 holding above: not emitted again (first-cross).
  high[81] = 11; close[81] = 10.9;
  const r2 = detectRangeBreakout(high, low, close, vol, volMa, 81, DEFAULT_RANGE_BREAKOUT_OPTS);
  assert.equal(r2, null, 'no re-fire while holding');
  // No volume ⇒ no breakout.
  vol[80] = 110;
  assert.equal(detectRangeBreakout(high, low, close, vol, volMa, 80, DEFAULT_RANGE_BREAKOUT_OPTS), null);
});

// ---------------------------------------------------------------- pullback resume

/**
 * Goal-1106 WP1 fixture: a rising MA20 above a rising MA60, price above both,
 * a four-bar close-based pullback (bars 76–79), and a close-based reclaim at 80.
 * The low of every pullback bar is below its close and therefore below MA20, so
 * the pullback genuinely tags the average.
 */
function pullbackFixture() {
  const n = 100;
  const ma20 = [], ma60 = [], close = [], low = [];
  for (let i = 0; i < n; i++) {
    ma20[i] = 10 + 0.02 * i;
    ma60[i] = 9 + 0.01 * i;
    close[i] = ma20[i] + 0.5;
    low[i] = close[i] - 0.2;
  }
  for (let k = 76; k <= 79; k++) { close[k] = ma20[k] - 0.1; low[k] = close[k] - 0.1; }
  close[80] = ma20[80] + 0.4;
  low[80] = close[80] - 0.1;
  return { ma20, ma60, close, low };
}

test('pullback resume: a close-based reclaim after a short MA20 tag confirms once', () => {
  const { ma20, ma60, close, low } = pullbackFixture();
  const p = detectPullbackResume(close, low, ma20, ma60, 80);
  assert.ok(p, 'genuine reclaim detected');
  assert.equal(p.confirmIndex, 80);
  assert.equal(p.pullbackStartIndex, 76);
  assert.equal(p.touchIndex, 76, 'episode anchored at the first MA20 tag');
  assert.equal(p.firstObservedIndex, 76);
  // The next bar's previous close is already above MA20, so the same advance
  // can never be confirmed a second time.
  close[81] = ma20[81] + 0.6; low[81] = close[81] - 0.1;
  assert.equal(detectPullbackResume(close, low, ma20, ma60, 81), null, 'no second confirmation');
});

test('pullback resume: FORMING is observable while the pullback is still in progress', () => {
  const { ma20, ma60, close, low } = pullbackFixture();
  for (const i of [76, 78, 79]) {
    const f = detectPullbackForming(close, low, ma20, ma60, i);
    assert.ok(f, `forming at ${i}`);
    assert.equal(f.touchIndex, 76, 'dates do not wander as the pullback extends');
    assert.equal(f.firstObservedIndex, 76);
    assert.equal(f.pullbackStartIndex, 76);
  }
  // Once price is back above MA20 the forming observation ends (the resume
  // primitive takes over).
  assert.equal(detectPullbackForming(close, low, ma20, ma60, 80), null);
});

test('pullback resume: a prior close above MA20 is not a pullback reclaim', () => {
  const { ma20, ma60, close, low } = pullbackFixture();
  // No pullback at all: price stays above MA20 into the "resume" bar.
  for (let k = 76; k <= 79; k++) { close[k] = ma20[k] + 0.5; low[k] = close[k] - 0.2; }
  close[80] = ma20[80] + 0.7;
  assert.equal(detectPullbackResume(close, low, ma20, ma60, 80), null);
});

test('pullback resume: same-day MA20/MA60 alignment alone is not a pre-existing trend', () => {
  const { ma20, ma60, close, low } = pullbackFixture();
  // MA20 sits below MA60 for the whole pullback and only crosses above it on
  // the reclaim bar: that alignment did not exist when the pullback started.
  for (let i = 0; i <= 79; i++) {
    ma20[i] = 9.5 + 0.01 * i;
    ma60[i] = 10.5;
    close[i] = ma20[i] + 0.5;
    low[i] = close[i] - 0.2;
  }
  for (let k = 76; k <= 79; k++) { close[k] = ma20[k] - 0.1; low[k] = close[k] - 0.1; }
  ma20[80] = 10.6;
  ma60[80] = 10.5;
  close[80] = ma20[80] + 0.4;
  low[80] = close[80] - 0.1;
  assert.equal(detectPullbackResume(close, low, ma20, ma60, 80), null,
    'alignment must precede the pullback, not appear on the reclaim bar');
  assert.equal(detectPullbackForming(close, low, ma20, ma60, 79), null);
});

test('pullback resume: a pullback longer than the touch window is a trend break, not a setup', () => {
  const { ma20, ma60, close, low } = pullbackFixture();
  for (let k = 72; k <= 79; k++) { close[k] = ma20[k] - 0.1; low[k] = close[k] - 0.1; }
  close[80] = ma20[80] + 0.4;
  assert.equal(detectPullbackResume(close, low, ma20, ma60, 80), null);
  assert.equal(detectPullbackForming(close, low, ma20, ma60, 79), null);
});

// ---------------------------------------------------------------- RPS hold

test('rps hold: first-cross of the compound condition only', () => {
  const n = 60;
  const close = series(n, 12), ma20 = series(n, 11);
  // Rising MA20: ma20[i] = 10 + i*0.05
  for (let i = 0; i < n; i++) ma20[i] = 10 + i * 0.05;
  for (let i = 0; i < n; i++) close[i] = ma20[i] + 1;
  // Per-bar RPS: below the floor until bar 50, then 85.
  const rps = series(n, null);
  rps[50] = 85; rps[51] = 86;
  assert.equal(detectRpsHold(close, ma20, rps, 49), null, 'below floor');
  const h = detectRpsHold(close, ma20, rps, 50);
  assert.ok(h, 'floor crossed with trend intact');
  assert.equal(h.confirmIndex, 50);
  // Already holding at 51 ⇒ no second event.
  assert.equal(detectRpsHold(close, ma20, rps, 51), null, 'continuation already in force');
  // Null RPS (unavailable) ⇒ no signal.
  const rpsNull = series(n, null);
  rpsNull[50] = null;
  assert.equal(detectRpsHold(close, ma20, rpsNull, 50), null, 'unavailable rps');
});
