// goal-1030 WP1: executable contract for the signal lifecycle engine.
//
// Every case below drives `detectStrategyEvents` with hand-built bars and
// indicators so the state machine — not the market — is the variable. The
// production numbers are covered separately by hotspot-20261029-baseline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStrategyEvents } from '../build/ashare/strategies.js';

const N = (n, v = Number.NaN) => new Array(n).fill(v);

/** Weekday date strings; the engine only needs strictly increasing ids. */
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

function mkBars(n, opts = {}) {
  const arr = (v, d) => (Array.isArray(v) ? v.slice() : N(n, v ?? d));
  const close = arr(opts.close, 100);
  const open = arr(opts.open, close);
  const high = Array.isArray(opts.high) ? opts.high.slice() : close.map(c => c + 0.5);
  const low = Array.isArray(opts.low) ? opts.low.slice() : close.map(c => c - 0.5);
  const vol = arr(opts.vol, 100000);
  return {
    dates: opts.dates ?? dates(n), open, high, low, close, vol,
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

const last = (events, sid) => [...events].reverse().find(e => e.strategy_id === sid);

// ---------------------------------------------------------------- re-confirmation

test('lifecycle: re-confirmation after invalidation gets a new identity; the old one never revives', () => {
  const n = 130;
  const datesArr = dates(n);
  const close = N(n, 101);
  const open = N(n, 101);
  const low = N(n, 101.5);          // no MA20 touch by default
  const ma20 = N(n, 100);
  const ma60 = N(n, 90);

  // cycle 1: touch 64..68, resume 69, invalidate at 75 (close 85 < MA60).
  for (let i = 64; i <= 68; i++) low[i] = 100.5;
  close[69] = 102;
  for (let i = 76; i <= 79; i++) close[i] = [86, 95, 101, 101][i - 76];
  close[75] = 85;

  // cycle 2: touch 80..84, resume 85.
  for (let i = 80; i <= 84; i++) low[i] = 100.5;
  close[85] = 102;
  for (let i = 86; i < n; i++) close[i] = 102;

  const b = mkBars(n, { dates: datesArr, close, open, low });
  const x = mkX(n, { ma20, ma60 });

  const at74 = detectStrategyEvents('600000.SH', b, x, new Map(), 74);
  const firstAt74 = at74.events.find(e => e.strategy_id === 'tc_pullback_resume');
  assert.ok(firstAt74, 'cycle 1 confirmed');
  assert.equal(firstAt74.confirmed_on, datesArr[69]);
  assert.equal(firstAt74.status, 'active');
  assert.equal(firstAt74.signal_age_trade_days, 5);

  const scan = detectStrategyEvents('600000.SH', b, x, new Map(), 90);
  const pulls = scan.events.filter(e => e.strategy_id === 'tc_pullback_resume');
  assert.equal(pulls.length, 2, 'two distinct identities, not two entries of one signal');
  const [c1, c2] = pulls;
  assert.equal(c1.signal_id, `600000.SH:tc_pullback_resume:${datesArr[69]}`);
  assert.equal(c1.status, 'invalidated');
  assert.equal(c1.invalidated_on, datesArr[75]);
  assert.equal(c1.invalidation_reason, 'close_below_ma60');
  assert.equal(c1.signal_age_trade_days, 6, 'age freezes at the invalidation bar');
  assert.equal(c2.confirmed_on, datesArr[85]);
  assert.equal(c2.status, 'active');
  assert.equal(c2.signal_age_trade_days, 5);
  assert.notEqual(c1.signal_id, c2.signal_id);
  assert.equal(pulls.filter(e => e.status === 'active').length, 1, 'one open signal per strategy');
});

// ---------------------------------------------------------------- expiry

test('lifecycle: a signal expires at its frozen window and is not invalidation', () => {
  const n = 100;
  const d = dates(n);
  const high = N(n, 100.5);
  const close = N(n, 100);
  const vol = N(n, 100000);
  high[70] = 103; close[70] = 103; vol[70] = 200000;   // breakout on volume
  for (let i = 71; i < n; i++) close[i] = 102.5;        // stays above the level

  const b = mkBars(n, { dates: d, high, close, vol });
  const x = mkX(n);

  const at90 = detectStrategyEvents('600001.SH', b, x, new Map(), 90);
  const r90 = last(at90.events, 'bo_range');
  assert.equal(r90.confirmed_on, d[70]);
  assert.equal(r90.status, 'active');
  assert.equal(r90.signal_age_trade_days, 20, 'age 20 is still inside the window');
  assert.equal(r90.max_age_trade_days, 20);

  const at95 = detectStrategyEvents('600001.SH', b, x, new Map(), 95);
  const r95 = last(at95.events, 'bo_range');
  assert.equal(r95.status, 'expired');
  assert.equal(r95.expired_on, d[91], 'expires on the first bar past the window');
  assert.equal(r95.signal_age_trade_days, 21);
  assert.equal(r95.invalidated_on, null, 'expiry is a different state from invalidation');
  assert.equal(r95.invalidation_reason, 'max_age_exceeded');
  assert.equal(r95.last_validated_on, d[91], 'last validation stays on the closing bar');
});

// ---------------------------------------------------------------- insufficient data

test('lifecycle: a missing required input degrades to insufficient_data, never to active', () => {
  const n = 100;
  const d = dates(n);
  const close = N(n, 101);
  const open = N(n, 101);
  const low = N(n, 101.5);
  for (let i = 64; i <= 68; i++) low[i] = 100.5;
  close[69] = 102;
  const ma20 = N(n, 100);
  const ma60 = N(n, 90);
  ma60[70] = Number.NaN; // the as-of bar cannot be validated

  const b = mkBars(n, { dates: d, close, open, low });
  const x = mkX(n, { ma20, ma60 });
  const scan = detectStrategyEvents('600002.SH', b, x, new Map(), 70);
  const ev = last(scan.events, 'tc_pullback_resume');
  assert.ok(ev);
  assert.equal(ev.confirmed_on, d[69]);
  assert.equal(ev.status, 'insufficient_data');
  assert.equal(ev.last_validated_on, d[70]);
});

// ---------------------------------------------------------------- risk episodes

test('lifecycle: consecutive risk firings collapse into one episode; a gap starts a new one', () => {
  const n = 140;
  const d = dates(n);
  const high = N(n, 100);
  const open = N(n, 101);
  const close = N(n, 100);
  const dif = N(n, 0);

  // reference high with a very high DIF 20–60 bars back
  high[60] = 105; dif[60] = 5;
  // three candidate bars: two fire, the middle one's DIF invalidates the test
  high[100] = 106; dif[100] = -1;
  high[101] = 107; dif[101] = -1.1;
  high[102] = 108; dif[102] = 10;   // > past DIF ⇒ no divergence here
  // after the 10-bar recent window, a fresh high fires again
  high[113] = 120; dif[113] = -2;

  const b = mkBars(n, { dates: d, high, open, close });
  const x = mkX(n, { dif });
  const scan = detectStrategyEvents('600003.SH', b, x, new Map(), 113);

  const div = scan.risk_events.filter(r => r.id === 'macd_bear_divergence');
  assert.equal(div.length, 2, 'two episodes, not four firings');
  assert.deepEqual(div[0], { id: 'macd_bear_divergence', on: d[100], last_on: d[101], bars: 2 });
  assert.deepEqual(div[1], { id: 'macd_bear_divergence', on: d[113], last_on: d[113], bars: 1 });
  assert.equal(scan.risk_firings.length, 3, 'the raw firing trail is preserved');
  assert.equal(div.reduce((s, r) => s + r.bars, 0), scan.risk_firings.length);
});

// ---------------------------------------------------------------- forming

test('lifecycle: a pattern that never confirms stops being PREPARING after its window', () => {
  const n = 140;
  const d = dates(n);
  const dif = N(n, 0);
  for (let i = 0; i <= 40; i++) dif[i] = -(i / 40);              // low A @40 (-1.0)
  for (let i = 41; i <= 55; i++) dif[i] = -1 + 1.2 * ((i - 40) / 15); // neckline 0.2 @55
  for (let i = 56; i <= 70; i++) dif[i] = 0.2 - 1.1 * ((i - 55) / 15); // low B @70 (-0.9)
  for (let i = 71; i < n; i++) dif[i] = -0.5 - (i - 70) * 0.01;  // never crosses the neckline

  const b = mkBars(n);
  const x = mkX(n, { dif });

  const at90 = detectStrategyEvents('600004.SH', b, x, new Map(), 90);
  const w90 = at90.forming.find(f => f.strategy_id === 'rv_macd_w_bottom');
  assert.ok(w90, 'still within 40 bars of the second low ⇒ PREPARING');
  assert.equal(w90.since, d[70]);

  const at120 = detectStrategyEvents('600004.SH', b, x, new Map(), 120);
  assert.equal(at120.forming.some(f => f.strategy_id === 'rv_macd_w_bottom'), false,
    'a 50-bar-old formation is no longer current evidence');
});

// ---------------------------------------------------------------- replay/leakage

test('lifecycle: replaying any historical day reproduces only what was visible then', () => {
  const n = 130;
  const d = dates(n);
  const close = N(n, 101);
  const open = N(n, 101);
  const low = N(n, 101.5);
  for (let i = 64; i <= 68; i++) low[i] = 100.5;
  close[69] = 102;
  close[75] = 85;
  for (let i = 76; i <= 79; i++) close[i] = [86, 95, 101, 101][i - 76];
  for (let i = 80; i <= 84; i++) low[i] = 100.5;
  close[85] = 102;
  for (let i = 86; i < n; i++) close[i] = 102;

  const b = mkBars(n, { dates: d, close, open, low });
  const x = mkX(n, { ma20: N(n, 100), ma60: N(n, 90) });

  const early = detectStrategyEvents('600005.SH', b, x, new Map(), 70);
  const late = detectStrategyEvents('600005.SH', b, x, new Map(), 110);
  const visibleEarly = early.events.map(e => e.signal_id).sort();
  const visibleLate = late.events
    .filter(e => e.confirmed_on <= d[70])
    .map(e => e.signal_id).sort();
  assert.deepEqual(visibleLate, visibleEarly, 'later bars must not invent earlier signals');

  // Determinism: the same input twice is byte-identical.
  const again = detectStrategyEvents('600005.SH', b, x, new Map(), 110);
  assert.deepEqual(again.events, late.events);
  assert.deepEqual(again.risk_events, late.risk_events);
  assert.deepEqual(again.forming, late.forming);
});
