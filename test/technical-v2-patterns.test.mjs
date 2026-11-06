// Technical methodology V2 — family pattern detectors (goal-1102).
//
// The contract under test:
//   - confirmation is dated at the first provable bar, never the formation low;
//   - a forming observation becomes a confirmation only on later data;
//   - every detector is truncation-invariant: scanning a prefix of the series
//     equals scanning the full series and looking only at indices <= the cut.
// Fixtures are deterministic synthetic bars (no randomness), built with the
// same forward-adjusted convention used by the ingestion layer.
import assert from 'node:assert/strict';
import test from 'node:test';

const { computeIndicators } = await import('../build/ashare/indicators.js');
const { detectPullbackResume } = await import('../build/ashare/patterns.js');
const {
  PATTERN_DEFINITIONS_V2,
  detectTrendContinuation, detectPlatformBreakout, detectReversal,
  detectVolatilityExpansion, detectMeanReversion, detectAllPatterns,
} = await import('../build/ashare/technicalPatternsV2.js');

// ---------------------------------------------------------------- fixtures

/** `count` consecutive weekdays starting at `start` (YYYYMMDD). */
function weekdays(start, count) {
  const out = [];
  const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8)));
  while (out.length < count) {
    if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Bars around a deterministic close path; high/low bracket open and close. */
function makeBars(closes, { vol = null } = {}) {
  const dates = weekdays('20240101', closes.length);
  const open = closes.map((c, i) => (i === 0 ? c : closes[i - 1]));
  const high = closes.map((c, i) => Math.max(open[i], c) * 1.005);
  const low = closes.map((c, i) => Math.min(open[i], c) * 0.995);
  const volume = vol ?? closes.map(() => 100);
  return {
    dates,
    open,
    high,
    low,
    close: closes.slice(),
    vol: volume,
    amount: volume.map((v, i) => v * closes[i]),
    rawOpen: open.slice(),
    rawClose: closes.slice(),
    rawHigh: high.slice(),
    rawLow: low.slice(),
    upLimit: closes.map(c => Math.round(c * 1.1 * 100) / 100),
    downLimit: closes.map(c => Math.round(c * 0.9 * 100) / 100),
  };
}

function patternInput(bars, endIdx, regime = 'range') {
  return {
    code: 'TEST.SH',
    bars,
    x: computeIndicators(bars),
    endIdx,
    asOf: bars.dates[endIdx],
    regime,
    rps120: null,
    barsBehindAsOf: 0,
  };
}

/** Slice every price/volume series to [0, k]; indicators are recomputed. */
function truncateBars(bars, k) {
  const cut = (a) => a.slice(0, k + 1);
  return {
    dates: cut(bars.dates), open: cut(bars.open), high: cut(bars.high), low: cut(bars.low),
    close: cut(bars.close), vol: cut(bars.vol), amount: cut(bars.amount),
    rawOpen: cut(bars.rawOpen), rawClose: cut(bars.rawClose),
    rawHigh: cut(bars.rawHigh), rawLow: cut(bars.rawLow),
    upLimit: cut(bars.upLimit), downLimit: cut(bars.downLimit),
  };
}

/** 120-bar uptrend, 4-bar pullback into MA20, one resume bar. */
function pullbackBars() {
  const closes = [];
  for (let i = 0; i < 100; i++) closes.push(10 + 0.05 * i);
  closes.push(14.70, 14.45, 14.20, 13.95); // pullback: low tags MA20
  closes.push(14.80);                      // resume: close > MA20 and > prior close
  return makeBars(closes);
}

/**
 * Same advance, continued for 36 more rising bars with no new pullback, so the
 * confirmed episode's EXPIRED window actually elapses inside the series.
 */
function extendedPullbackBars() {
  const closes = [];
  for (let i = 0; i < 100; i++) closes.push(10 + 0.05 * i);
  closes.push(14.70, 14.45, 14.20, 13.95, 14.80);
  for (let i = 105; i <= 140; i++) closes.push(14.80 + 0.05 * (i - 104));
  return makeBars(closes);
}

/** The divergence fixture with a pre-confirmation close below the second low. */
function dipDivergenceBars() {
  const bars = divergenceBars();
  bars.close[120] = 11.0;
  bars.low[120] = 10.9;
  for (let i = 121; i < bars.close.length; i++) bars.close[i] = 11.8 + 0.1 * (i - 115);
  bars.rawClose = bars.close.slice();
  bars.rawLow = bars.low.slice();
  return bars;
}

/** 90 rising bars, 40 tight-range bars, then a volume-qualified breakout. */
function platformBars() {
  const closes = [];
  for (let i = 0; i < 90; i++) closes.push(10 + (8 * i) / 89);
  for (let i = 90; i < 100; i++) closes.push(18 + 0.2 * (i % 2));
  for (let i = 100; i < 110; i++) closes.push(18 + 0.4 * (i % 2));
  for (let i = 110; i < 120; i++) closes.push(18 + 0.1 * (i % 2));
  for (let i = 120; i < 130; i++) closes.push(18 + 0.02 * (i % 2));
  closes.push(18.75); // breakout close above the 30-day platform high
  const vol = closes.map((_, i) => (i === 130 ? 250 : 100));
  return makeBars(closes, { vol });
}

/** Same length, but a straight accelerating run-up — no platform. */
function runupBars() {
  return makeBars(Array.from({ length: 131 }, (_, i) => 10 * Math.pow(1.008, i)));
}

/**
 * Two descending price lows (80 and 115) with a shallower second decline, so
 * DIF at the second low is higher. Neckline is the peak at ~105; the close
 * crosses it at bar 143.
 */
function divergenceBars() {
  const n = 200;
  const closes = new Array(n).fill(0);
  for (let i = 0; i <= 75; i++) closes[i] = 20 - (7.4 * i) / 75;
  for (let i = 76; i <= 80; i++) closes[i] = 12.6 - 0.12 * (i - 75);
  for (let i = 81; i <= 85; i++) closes[i] = 12.0 + 0.12 * (i - 80);
  for (let i = 86; i <= 105; i++) closes[i] = 12.6 + (1.9 * (i - 85)) / 20;
  for (let i = 106; i <= 110; i++) closes[i] = 14.5 - 0.34 * (i - 105);
  for (let i = 111; i <= 115; i++) closes[i] = 12.8 - 0.2 * (i - 110);
  for (let i = 116; i < n; i++) closes[i] = 11.8 + 0.1 * (i - 115);
  return makeBars(closes);
}

/** Tapering oscillation (bollinger squeeze), then an upper-band break at 140. */
function squeezeBars() {
  const n = 160;
  const closes = [];
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0.002, 0.06 * (1 - i / 139));
    closes.push(10 + amp * (i % 2 === 0 ? 1 : -1));
  }
  closes[139] = 10;
  closes[140] = 10.7;
  return makeBars(closes);
}

/** Steady uptrend, then accelerated bars that ride the upper band from 192. */
function rideBars() {
  const n = 200;
  const closes = [];
  for (let i = 0; i < n; i++) closes.push(10 * Math.pow(1.006, i));
  for (let i = 190; i < n; i++) closes[i] = closes[189] * Math.pow(1.02, i - 189);
  return makeBars(closes);
}

/** Wide range, one lower-band dip at 141, re-entry above the lower band at 142. */
function reversionBars() {
  const n = 160;
  const closes = [];
  for (let i = 0; i < 141; i++) closes.push(10 + 0.2 * (i % 2 === 0 ? 1 : -1));
  closes[141] = 9.2;
  closes[142] = 9.9;
  closes[143] = 9.95;
  for (let i = 144; i < n; i++) closes.push(10 + 0.2 * (i % 2 === 0 ? 1 : -1));
  return makeBars(closes);
}

/** Persistent decline (close < MA60, falling MA20) with oversold RSI. */
function downtrendBars() {
  const n = 180;
  const closes = Array.from({ length: n }, (_, i) => 20 - (10 * i) / (n - 1));
  closes[n - 1] = closes[n - 2] * 0.96;
  return makeBars(closes);
}

/**
 * Pullback that closes below MA60 while the setup is still forming, then puts a
 * valid reclaim (10.70 > MA60 ≈ 10.34) inside the 5-bar window at bar 102. The
 * first event decides: the instance died at 101 and the reclaim cannot revive it.
 */
function breachedPullbackBars() {
  const closes = [];
  for (let i = 0; i < 100; i++) closes.push(10 + 0.005 * i);
  closes.push(10.40); // touch: below MA20, still above MA60 ⇒ FORMING
  closes.push(9.00);  // close below MA60 ⇒ the setup fails before confirming
  closes.push(10.70); // a reclaim inside the window that must not confirm it
  return makeBars(closes);
}

/**
 * DIF W bottom that breaches inside its 40-bar instance window and then rallies
 * so hard the DIF crosses the neckline later. The failed instance must stay
 * failed: a later cross is not evidence that the earlier breach never happened.
 */
function breachThenCrossWBars() {
  const closes = [];
  const push = (from, to, at) => { for (let i = from; i <= to; i++) closes.push(at(i)); };
  push(0, 60, i => 20 - (8 * i) / 60);              // decline: first DIF low
  push(61, 75, i => 12 + (1.8 * (i - 60)) / 15);    // rebound
  push(76, 95, i => 13.8 - (2.2 * (i - 75)) / 20);  // second, lower price low
  push(96, 110, i => 11.6 + (2.0 * (i - 95)) / 15); // rebound through the neckline
  push(111, 127, i => 13.6 - (3.0 * (i - 110)) / 17); // decline: the W instance
  push(128, 133, i => 10.6 + (1.2 * (i - 127)) / 6);  // bounce: instance becomes visible
  push(134, 138, i => 11.8 - (3.5 * (i - 133)) / 5);  // breach: DIF back below the low
  push(139, 184, i => 8.3 + 0.25 * (i - 138));        // rally: DIF ends above the neckline
  return makeBars(closes);
}

/**
 * The same W formation, but the DIF never crosses the neckline inside the
 * 40-bar window; it drifts near zero instead. The instance therefore expires at
 * the first elapsed bar. Only afterwards (bars 183+) does a crash push the DIF
 * well below both lows: the late breach must not re-date the episode as FAILED.
 */
function expiredThenBreachWBars() {
  const closes = [];
  const push = (from, to, at) => { for (let i = from; i <= to; i++) closes.push(at(i)); };
  push(0, 60, i => 20 - (8 * i) / 60);
  push(61, 75, i => 12 + (1.8 * (i - 60)) / 15);
  push(76, 95, i => 13.8 - (2.2 * (i - 75)) / 20);
  push(96, 110, i => 11.6 + (2.0 * (i - 95)) / 15);
  push(111, 127, i => 13.6 - (3.0 * (i - 110)) / 17);
  push(128, 133, i => 10.6 + (1.2 * (i - 127)) / 6);  // instance becomes provable at 133
  push(134, 182, i => 11.8 + 0.02 * (i - 133));       // sideways drift: no neckline cross
  push(183, 187, i => 11.8 + 0.02 * 49 - (8 * (i - 182)) / 5); // post-expiry crash
  return makeBars(closes);
}

const byId = (observations, id) => observations.find(o => o.strategy_id === id);

// ---------------------------------------------------------------- A. trend

test('trend continuation: a genuine close-based reclaim confirms, FORMING precedes it', () => {
  const bars = pullbackBars();
  const dates = bars.dates;

  // The pullback is provable as FORMING from its first MA20 tag, three bars
  // before the reclaim. This is an independent date, not the confirmation date.
  for (const k of [101, 102, 103]) {
    const f = byId(detectTrendContinuation(patternInput(bars, k)), 'tc_v2_pullback_resume');
    assert.ok(f, `forming observation at bar ${k}`);
    assert.equal(f.stage, 'FORMING');
    assert.equal(f.stage_detail, 'PULLBACK_TO_MA20');
    assert.equal(f.confirmed_on, null, 'nothing has confirmed yet');
    assert.equal(f.formed_on, dates[101], 'episode anchored at the first MA20 tag');
    assert.equal(f.pattern_event_date, dates[101]);
    assert.equal(f.first_observed_date, dates[101], 'first provable bar, never backfilled');
  }

  const resume = byId(detectTrendContinuation(patternInput(bars, 104)), 'tc_v2_pullback_resume');
  assert.ok(resume, 'resume observation exists');
  assert.equal(resume.stage, 'CONFIRMED');
  assert.equal(resume.stage_detail, 'PULLBACK_RESUME');
  assert.equal(resume.formed_on, dates[101], 'formation is the MA20 touch date');
  assert.equal(resume.confirmed_on, dates[104], 'confirmation is the reclaim date, not the touch');
  assert.ok(resume.formed_on < resume.confirmed_on, 'formation always precedes confirmation');
  assert.equal(resume.evidence.touch_date, dates[101]);
  assert.equal(resume.evidence.rps_background_only, true, 'RPS is background only');
});

test('trend continuation: one advance is confirmed once; later bars are follow-through', () => {
  const bars = extendedPullbackBars();
  const dates = bars.dates;
  const confirmedDates = new Set();
  let sawConfirmed = false;
  for (let k = 104; k < bars.dates.length; k++) {
    const o = byId(detectTrendContinuation(patternInput(bars, k)), 'tc_v2_pullback_resume');
    if (!o) continue;
    if (o.stage === 'CONFIRMED') sawConfirmed = true;
    if (o.confirmed_on) confirmedDates.add(o.confirmed_on);
  }
  assert.equal(sawConfirmed, true);
  assert.deepEqual([...confirmedDates], [dates[104]],
    'the sustained advance cannot be re-confirmed on a later bar');
});

test('trend continuation: MA20/MA60 alignment alone is background, never a confirmation', () => {
  // 120 bars of steady rise: close > MA20 > MA60 the whole way, but the close
  // never falls to MA20, so there is no pullback and no reclaim to confirm.
  const bars = makeBars(Array.from({ length: 120 }, (_, i) => 10 + 0.05 * i));
  const obs = detectTrendContinuation(patternInput(bars, 119));
  assert.equal(obs.some(o => o.stage === 'CONFIRMED' || o.stage === 'FOLLOW_THROUGH'), false,
    'MA20 > MA60 is context; confirmation needs the pullback reclaim');
  assert.equal(obs.some(o => o.stage === 'FORMING'), false, 'no pullback ⇒ nothing is forming');
  assert.equal(obs.some(o => o.strategy_id === 'tc_v2_trend_established'), false,
    'there is no standalone trend-established signal');
});

test('trend continuation: a close below MA60 before the reclaim fails the setup unconfirmed', () => {
  const bars = breachedPullbackBars();
  const dates = bars.dates;

  const forming = byId(detectTrendContinuation(patternInput(bars, 100)), 'tc_v2_pullback_resume');
  assert.ok(forming);
  assert.equal(forming.stage, 'FORMING', 'the touch is the formation event');

  // Bar 101 closes at 9.00, well below MA60: the first event is a failure.
  for (const k of [101, 102]) {
    const o = byId(detectTrendContinuation(patternInput(bars, k)), 'tc_v2_pullback_resume');
    assert.ok(o, `instance reported at bar ${k}`);
    assert.equal(o.stage, 'FAILED');
    assert.equal(o.stage_detail, 'PULLBACK_RESUME');
    assert.equal(o.confirmed_on, null,
      `a breached setup can never carry a confirmation (bar ${k})`);
    assert.equal(o.invalidated_at, dates[101], `invalidation is the first breach bar (${k})`);
    assert.equal(o.formed_on, dates[100], 'the instance keeps its formation date');
    assert.ok(o.invalidated_at >= (o.confirmed_on ?? o.invalidated_at),
      'invalidated_at >= confirmed_on or confirmed_on === null');
  }

  // The reclaim at 102 is a genuinely detectable resume for THIS instance: it
  // clears MA20 after a pre-pullback advance above it, with the same pullback
  // start and touch. Before the fix that meant confirmed_on = dates[102] was
  // spread into the FAILED branch, giving invalidated_at < confirmed_on.
  const x = computeIndicators(bars);
  const touchIdx = dates.indexOf(forming.pattern_event_date);
  const resume = detectPullbackResume(bars.close, bars.low, x.ma20, x.ma60, 102);
  assert.ok(resume, 'the reclaim at 102 is detected, so the branch is genuinely exercised');
  assert.equal(resume.pullbackStartIndex, touchIdx, 'same pullback start as the episode');
  assert.equal(resume.touchIndex, touchIdx, 'same touch as the episode');
  assert.ok(bars.close[102] > x.ma60[102], 'the reclaim also clears MA60');

  // No later bar may resurrect the instance or re-date the failure.
  for (let k = 102; k < bars.dates.length; k++) {
    const o = byId(detectTrendContinuation(patternInput(bars, k)), 'tc_v2_pullback_resume');
    assert.ok(o, `instance reported at bar ${k}`);
    assert.equal(o.stage, 'FAILED', `the breached instance cannot confirm at bar ${k}`);
    assert.equal(o.confirmed_on, null, `confirmed_on stays null at bar ${k}`);
    assert.equal(o.invalidated_at, dates[101], `invalidated_at is not re-dated at bar ${k}`);
  }
});

// ---------------------------------------------------------------- B. platform

test('platform breakout: tight base confirms on the volume breakout; a run-up never does', () => {
  const bars = platformBars();
  const dates = bars.dates;

  const forming = detectPlatformBreakout(patternInput(bars, 129));
  assert.equal(forming.length, 1);
  assert.equal(forming[0].stage, 'FORMING');
  assert.equal(forming[0].stage_detail, 'PLATFORM_FORMING');
  const formationIdx = dates.indexOf(forming[0].pattern_event_date);
  assert.ok(formationIdx < 129, 'the platform is dated at its first provable bar, not the evaluation bar');
  assert.equal(forming[0].formed_on, dates[formationIdx - 30],
    'the anchor is the first bar of the platform window at the formation bar');
  assert.equal(forming[0].confirmed_on, null);

  const confirmed = detectPlatformBreakout(patternInput(bars, 130));
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].stage, 'CONFIRMED');
  assert.equal(confirmed[0].stage_detail, 'BREAKOUT_CONFIRMED');
  assert.equal(confirmed[0].confirmed_on, dates[130], 'breakout bar date');
  assert.equal(confirmed[0].formed_on, forming[0].formed_on,
    'the platform anchor does not roll forward when the as-of advances');
  assert.equal(confirmed[0].pattern_event_date, forming[0].pattern_event_date);
  assert.ok(confirmed[0].evidence.range_width <= 0.15);
  assert.ok(confirmed[0].evidence.volume_ratio >= 1.2);
  assert.ok(confirmed[0].key_levels.platform_high > 0);
  assert.ok(confirmed[0].key_levels.platform_low > 0);

  const runup = detectPlatformBreakout(patternInput(runupBars(), 130));
  assert.equal(runup.some(o => o.strategy_id === 'pb_v2_platform_breakout' && o.stage === 'CONFIRMED'), false,
    'a new high after a fast run-up is not a platform breakout');
});

test('platform breakout: falling back through the breakout level fails the episode, date kept', () => {
  // Same platform and breakout at 130, then two bars back down through
  // platform_high × 0.97 with a sharp drop.
  const closes = platformBars().close.concat([18.2, 17.5]);
  const bars = makeBars(closes, { vol: closes.map((_, i) => (i === 130 ? 250 : 100)) });
  const failed = detectPlatformBreakout(patternInput(bars, 132));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stage, 'FAILED');
  assert.equal(failed[0].stage_detail, 'PLATFORM_BREAKOUT_FAILED');
  assert.equal(failed[0].confirmed_on, bars.dates[130], 'the historical breakout date is kept');
  assert.equal(failed[0].invalidated_at, bars.dates[132]);
  assert.equal(failed[0].evidence.invalidation_close, 17.5);
});

// ---------------------------------------------------------------- C. reversal

test('MACD divergence: forming before the neckline, confirmed on the cross, truncation-invariant', () => {
  const bars = divergenceBars();
  const dates = bars.dates;

  const forming = byId(detectReversal(patternInput(bars, 142)), 'rv_v2_macd_dif_divergence');
  assert.ok(forming);
  assert.equal(forming.stage, 'FORMING');
  assert.equal(forming.stage_detail, 'DIVERGENCE_FORMING');
  assert.equal(forming.formed_on, dates[118], 'formed only after the right-side confirmation bars');
  assert.equal(forming.confirmed_on, null);

  const confirmed = byId(detectReversal(patternInput(bars, 143)), 'rv_v2_macd_dif_divergence');
  assert.ok(confirmed);
  assert.equal(confirmed.stage, 'CONFIRMED');
  assert.equal(confirmed.stage_detail, 'DIF_DIVERGENCE_CONFIRMED');
  assert.equal(confirmed.formed_on, dates[118]);
  assert.equal(confirmed.confirmed_on, dates[143], 'first close above the neckline');
  assert.ok(confirmed.evidence.second_low < confirmed.evidence.first_low, 'lower price low');
  assert.ok(confirmed.evidence.dif_second_low > confirmed.evidence.dif_first_low, 'higher DIF low');
  assert.ok(confirmed.evidence.dif_second_low < 0, 'second DIF low is still below zero');

  // Same formation and confirmation dates when the series is physically cut.
  for (const k of [142, 143]) {
    const full = byId(detectReversal(patternInput(bars, k)), 'rv_v2_macd_dif_divergence');
    const cut = byId(detectReversal(patternInput(truncateBars(bars, k), k)), 'rv_v2_macd_dif_divergence');
    assert.ok(full && cut);
    assert.equal(cut.formed_on, full.formed_on, `formed_on stable at ${k}`);
    if (full.confirmed_on !== null) assert.equal(cut.confirmed_on, full.confirmed_on, `confirmed_on stable at ${k}`);
  }
});

test('MACD divergence: a failure before confirmation can never be confirmed later', () => {
  const bars = dipDivergenceBars();
  const dates = bars.dates;
  // Close below the second price low on 120 while the neckline is still above.
  const failed = byId(detectReversal(patternInput(bars, 120)), 'rv_v2_macd_dif_divergence');
  assert.ok(failed);
  assert.equal(failed.stage, 'FAILED');
  assert.equal(failed.confirmed_on, null, 'failed before it ever confirmed');
  assert.equal(failed.invalidated_at, dates[120]);
  assert.ok(failed.invalidated_at > failed.formed_on);
  // Scanning later bars never resurrects this instance as confirmed.
  for (let k = 120; k < 160; k++) {
    const o = byId(detectReversal(patternInput(bars, k)), 'rv_v2_macd_dif_divergence');
    if (!o || o.formed_on !== dates[118]) continue;
    assert.equal(o.confirmed_on, null, `instance must stay unconfirmed at bar ${k}`);
  }
  // The lower low sits on the very bar that killed the instance, so it cannot
  // open a new episode (a new formation's event bar must be strictly after the
  // previous terminal). The walk keeps reporting the failed instance, and it
  // is never revived as confirmed.
  const later = byId(detectReversal(patternInput(bars, 150)), 'rv_v2_macd_dif_divergence');
  assert.ok(later);
  assert.equal(later.stage, 'FAILED');
  assert.equal(later.formed_on, dates[118], 'the failed instance keeps its dates');
  assert.equal(later.confirmed_on, null);
});

test('MACD W bottom: a breach inside the window cannot be revived by a later neckline cross', () => {
  const bars = breachThenCrossWBars();
  const dates = bars.dates;
  const at = (k) => byId(detectReversal(patternInput(bars, k)), 'rv_v2_macd_w_bottom');

  // The instance is provable from bar 133 and is still forming at 136.
  const forming = at(133);
  assert.ok(forming);
  assert.equal(forming.stage, 'FORMING');
  assert.equal(forming.pattern_event_date, dates[128], 'the second DIF low is the event');
  assert.equal(forming.formed_on, dates[133]);
  for (const k of [134, 135, 136]) {
    const o = at(k);
    assert.ok(o);
    assert.equal(o.stage, 'FORMING', `still forming at bar ${k}`);
    assert.equal(o.confirmed_on, null);
  }

  // Bar 137 breaches the second DIF low before any neckline cross: first event decides.
  const failed = at(137);
  assert.ok(failed);
  assert.equal(failed.stage, 'FAILED');
  assert.equal(failed.confirmed_on, null, 'the instance died before confirming');
  assert.equal(failed.invalidated_at, dates[137]);
  assert.equal(failed.formed_on, dates[133], 'the instance keeps its formation date');
  const neckline = failed.evidence.neckline;
  assert.ok(Number.isFinite(neckline));

  // The rally really does push DIF through the neckline later in the series.
  const difEnd = computeIndicators(bars).dif[bars.dates.length - 1];
  assert.ok(difEnd > neckline, `the later cross is real (DIF ${difEnd} > neckline ${neckline})`);

  // Every later as-of keeps reporting the same failed instance: no revival,
  // no re-dated invalidation, no confirmation appearing from nowhere.
  for (let k = 137; k < bars.dates.length; k++) {
    const o = at(k);
    assert.ok(o, `instance reported at bar ${k}`);
    assert.equal(o.stage, 'FAILED', `a later neckline cross cannot confirm the dead instance (bar ${k})`);
    assert.equal(o.confirmed_on, null, `confirmed_on stays null at bar ${k}`);
    assert.equal(o.invalidated_at, dates[137], `invalidated_at is not re-dated at bar ${k}`);
    assert.equal(o.expires_at, null, `a failed instance does not also expire (bar ${k})`);
    assert.equal(o.pattern_event_date, dates[128], `episode identity is stable at bar ${k}`);
  }
});

test('MACD W bottom: a breach after the window elapses keeps EXPIRED, never a late FAILED', () => {
  const bars = expiredThenBreachWBars();
  const dates = bars.dates;
  const at = (k) => byId(detectReversal(patternInput(bars, k)), 'rv_v2_macd_w_bottom');

  const forming = at(133);
  assert.ok(forming);
  assert.equal(forming.stage, 'FORMING');
  const formationIdx = dates.indexOf(forming.formed_on);
  const expiresIdx = formationIdx + 41; // first bar the 40-bar window elapsed
  assert.equal(formationIdx, 133);

  // Inside the window the instance is forming, with no confirmation and no breach.
  const lastInside = at(expiresIdx - 1);
  assert.ok(lastInside);
  assert.equal(lastInside.stage, 'FORMING', 'still forming before the window elapses');
  assert.equal(lastInside.confirmed_on, null);

  // The window elapses with no neckline cross: EXPIRED at that exact bar.
  const expired = at(expiresIdx);
  assert.ok(expired);
  assert.equal(expired.stage, 'EXPIRED');
  assert.equal(expired.expires_at, dates[expiresIdx]);
  assert.equal(expired.invalidated_at, null, 'an elapsed window is not an invalidation');
  assert.equal(expired.confirmed_on, null);
  assert.equal(expired.formed_on, forming.formed_on, 'the instance keeps its formation date');
  assert.equal(expired.pattern_event_date, forming.pattern_event_date, 'episode identity is stable');

  // The crash really does push DIF below both W lows — but only after expiry.
  const x = computeIndicators(bars);
  const lastDif = x.dif[bars.dates.length - 1];
  const below = Math.min(expired.evidence.first_low, expired.evidence.second_low);
  assert.ok(lastDif < below,
    `the late breach is real (DIF ${lastDif.toFixed(4)} < low ${below.toFixed(4)})`);
  assert.ok(lastDif < expired.evidence.neckline, 'and it is not a neckline cross');

  // Every later as-of keeps the same EXPIRED episode: the post-window breach
  // must not turn it into FAILED with a new invalidation date.
  for (let k = expiresIdx; k < bars.dates.length; k++) {
    const o = at(k);
    assert.ok(o, `instance reported at bar ${k}`);
    assert.equal(o.stage, 'EXPIRED', `a post-window breach cannot fail it (bar ${k})`);
    assert.equal(o.expires_at, dates[expiresIdx], `expires_at is not re-dated at bar ${k}`);
    assert.equal(o.invalidated_at, null, `no invalidation appears at bar ${k}`);
    assert.equal(o.confirmed_on, null, `no confirmation appears at bar ${k}`);
  }
});

// ---------------------------------------------------------------- D. volatility

test('BOLL squeeze: breakout confirms on the upper-band cross', () => {
  const bars = squeezeBars();
  const dates = bars.dates;

  const forming = byId(detectVolatilityExpansion(patternInput(bars, 138)), 've_v2_boll_squeeze_breakout');
  assert.ok(forming);
  assert.equal(forming.stage, 'FORMING');
  assert.equal(forming.stage_detail, 'SQUEEZE_FORMING');

  const confirmed = byId(detectVolatilityExpansion(patternInput(bars, 140)), 've_v2_boll_squeeze_breakout');
  assert.ok(confirmed);
  assert.equal(confirmed.stage, 'CONFIRMED');
  assert.equal(confirmed.stage_detail, 'SQUEEZE_BREAKOUT');
  assert.equal(confirmed.confirmed_on, dates[140], 'upper-band cross date');
});

test('BOLL upper ride: touching the upper band is an observation, not a sell; ids are distinct', () => {
  const bars = rideBars();
  const dates = bars.dates;

  const obs = detectVolatilityExpansion(patternInput(bars, 192));
  const ride = byId(obs, 've_v2_boll_upper_ride');
  assert.ok(ride, 'upper-band ride detected');
  assert.equal(ride.stage, 'CONFIRMED');
  assert.equal(ride.stage_detail, 'UPPER_BAND_RIDE');
  assert.equal(ride.confirmed_on, dates[192]);
  assert.ok(ride.evidence.upper_band_touches >= 3);
  assert.equal(ride.evidence.touching_upper_band_is_not_a_sell_signal, true);

  const later = byId(detectVolatilityExpansion(patternInput(bars, 193)), 've_v2_boll_upper_ride');
  assert.equal(later.stage, 'FOLLOW_THROUGH');

  const squeeze = byId(obs, 've_v2_boll_squeeze_breakout');
  assert.ok(squeeze, 'the older squeeze episode is still reported (expired)');
  assert.notEqual(squeeze.strategy_id, ride.strategy_id, 'squeeze breakout and ride are separate strategies');
});

// ---------------------------------------------------------------- E. mean reversion

test('mean reversion in a range: lower-band dip then re-entry confirms', () => {
  const bars = reversionBars();
  const dates = bars.dates;

  const forming = detectMeanReversion(patternInput(bars, 141, 'range'));
  assert.equal(forming.length, 1);
  assert.equal(forming[0].stage, 'FORMING');
  assert.equal(forming[0].stage_detail, 'OVERSOLD_OBSERVATION');
  assert.equal(forming[0].formed_on, dates[141]);

  const confirmed = detectMeanReversion(patternInput(bars, 142, 'range'));
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].stage, 'CONFIRMED');
  assert.equal(confirmed[0].stage_detail, 'BAND_REENTRY_CONFIRMED');
  assert.equal(confirmed[0].formed_on, dates[141], 'formation is the oversold bar');
  assert.equal(confirmed[0].confirmed_on, dates[142], 'confirmation is the re-entry bar');

  const follow = detectMeanReversion(patternInput(bars, 148, 'range'));
  assert.equal(follow[0].stage, 'FOLLOW_THROUGH');
  assert.equal(follow[0].stage_detail, 'REVERSION_FOLLOW_THROUGH');
});

test('mean reversion in a downtrend never reaches CONFIRMED', () => {
  const bars = downtrendBars();
  for (let k = 120; k < bars.dates.length; k++) {
    const obs = detectMeanReversion(patternInput(bars, k, 'downtrend'));
    assert.equal(obs.some(o => o.stage === 'CONFIRMED'), false, `no confirmation at ${k}`);
  }
  for (const k of [170, 179]) {
    const obs = detectMeanReversion(patternInput(bars, k, 'downtrend'));
    assert.equal(obs.length, 1);
    assert.equal(obs[0].stage, 'FORMING');
    assert.equal(obs[0].stage_detail, 'OVERSOLD_IN_DOWNTREND');
    assert.equal(obs[0].evidence.counter_trend_observation, true);
  }
});

// ---------------------------------------------------------------- episode model

// The forward walk (goal-1106 WP2): once an episode is observed its dates are a
// pure function of the bars up to its own event, and a live/forming episode is
// never replaced by a newer structure. These tests replay every fixture one bar
// at a time and assert the contract directly, not just on hand-picked bars.
const EPISODE_FIXTURES = {
  pullback: () => pullbackBars(),
  extendedPullback: () => extendedPullbackBars(),
  platform: () => platformBars(),
  divergence: () => divergenceBars(),
  dipDivergence: () => dipDivergenceBars(),
  squeeze: () => squeezeBars(),
  ride: () => rideBars(),
  reversion: () => reversionBars(),
  downtrend: () => downtrendBars(),
  breachedPullback: () => breachedPullbackBars(),
  breachThenCrossW: () => breachThenCrossWBars(),
  expiredThenBreachW: () => expiredThenBreachWBars(),
};

test('episode model: a one-bar advance never changes an existing episode\'s dates', () => {
  for (const [name, make] of Object.entries(EPISODE_FIXTURES)) {
    const bars = make();
    for (let k = 60; k + 1 < bars.dates.length; k++) {
      const before = detectAllPatterns(patternInput(bars, k));
      const after = detectAllPatterns(patternInput(bars, k + 1));
      for (const old of before) {
        const now = after.find(o => o.strategy_id === old.strategy_id
          && o.pattern_event_date === old.pattern_event_date);
        if (!now) continue;
        for (const f of ['pattern_event_date', 'first_observed_date', 'formed_on']) {
          assert.equal(now[f], old[f], `${name} ${old.strategy_id} ${f} stable at ${k}->${k + 1}`);
        }
        for (const f of ['confirmed_on', 'invalidated_at', 'expires_at']) {
          if (old[f] !== null) {
            assert.equal(now[f], old[f], `${name} ${old.strategy_id} ${f} must not be re-dated at ${k}->${k + 1}`);
          }
        }
      }
    }
  }
});

test('episode model: a live or forming episode is never replaced by a new structure', () => {
  for (const [name, make] of Object.entries(EPISODE_FIXTURES)) {
    const bars = make();
    for (let k = 60; k + 1 < bars.dates.length; k++) {
      const before = detectAllPatterns(patternInput(bars, k));
      const after = detectAllPatterns(patternInput(bars, k + 1));
      for (const old of before) {
        if (!['FORMING', 'CONFIRMED', 'FOLLOW_THROUGH'].includes(old.stage)) continue;
        const same = after.find(o => o.strategy_id === old.strategy_id
          && o.pattern_event_date === old.pattern_event_date);
        assert.ok(same, `${name} ${old.strategy_id} live episode ${old.pattern_event_date} survived ${k}->${k + 1}`);
        assert.ok(['FORMING', 'CONFIRMED', 'FOLLOW_THROUGH', 'FAILED', 'EXPIRED'].includes(same.stage));
      }
    }
  }
});

test('episode model: a second re-entry/breakout/reclaim bar never re-confirms', () => {
  // Trend: the reclaim at 104 is the only confirmation in the whole advance.
  const pull = extendedPullbackBars();
  for (const k of [105, 106, 107]) {
    const o = byId(detectTrendContinuation(patternInput(pull, k)), 'tc_v2_pullback_resume');
    assert.equal(o.confirmed_on, pull.dates[104], `trend confirmation stays at 104, not ${k}`);
    assert.equal(o.stage, 'FOLLOW_THROUGH');
  }
  // Mean reversion: the re-entry at 142 is the confirmation; the next bar does
  // not confirm again even though it is also above the lower band.
  const rev = reversionBars();
  for (const k of [143, 144]) {
    const o = detectMeanReversion(patternInput(rev, k))[0];
    assert.equal(o.confirmed_on, rev.dates[142], `reversion confirmation stays at 142, not ${k}`);
    assert.equal(o.stage, 'FOLLOW_THROUGH');
  }
  // Squeeze: the upper-band cross at 140 confirms once.
  const sq = squeezeBars();
  for (const k of [141, 142, 145]) {
    const o = byId(detectVolatilityExpansion(patternInput(sq, k)), 've_v2_boll_squeeze_breakout');
    assert.ok(o);
    assert.equal(o.confirmed_on, sq.dates[140], `squeeze confirmation stays at 140, not ${k}`);
  }
  // Platform: the breakout at 130 confirms once.
  const pb = platformBars();
  for (const k of [131, 132]) {
    const o = detectPlatformBreakout(patternInput(pb, k))[0];
    assert.ok(o);
    assert.equal(o.confirmed_on, pb.dates[130], `breakout confirmation stays at 130, not ${k}`);
  }
});

// ---------------------------------------------------------------- no future data

test('no-future: every family is truncation-invariant', () => {
  const cases = [
    { det: detectTrendContinuation, bars: pullbackBars(), at: [90, 100, 102, 103, 104] },
    { det: detectTrendContinuation, bars: extendedPullbackBars(), at: [110, 114, 115, 116, 130] },
    { det: detectPlatformBreakout, bars: platformBars(), at: [100, 128, 129, 130, 131] },
    { det: detectReversal, bars: divergenceBars(), at: [100, 115, 118, 130, 142, 143, 184, 185] },
    { det: detectReversal, bars: dipDivergenceBars(), at: [119, 120, 122, 130, 150] },
    { det: detectVolatilityExpansion, bars: squeezeBars(), at: [121, 130, 138, 140, 145] },
    { det: detectVolatilityExpansion, bars: rideBars(), at: [185, 190, 192, 193, 199] },
    { det: detectMeanReversion, bars: reversionBars(), at: [135, 141, 142, 145, 153] },
  ];
  const pick = (o) => ({
    strategy_id: o.strategy_id, family: o.family, stage: o.stage, stage_detail: o.stage_detail,
    pattern_event_date: o.pattern_event_date, first_observed_date: o.first_observed_date,
    formed_on: o.formed_on, confirmed_on: o.confirmed_on,
    invalidated_at: o.invalidated_at, expires_at: o.expires_at,
    invalidation: o.invalidation, price_position: o.price_position,
    last_evaluated_on: o.last_evaluated_on,
  });
  for (const { det, bars, at } of cases) {
    for (const k of at) {
      const full = det(patternInput(bars, k)).map(pick);
      const cut = det(patternInput(truncateBars(bars, k), k)).map(pick);
      assert.deepEqual(cut, full, `truncation mismatch at bar ${k}`);
    }
  }
});

// ---------------------------------------------------------------- lifecycle invariants

test('lifecycle: formation precedes confirmation; invalidation only follows a valid confirmation', () => {
  const fixtures = [
    pullbackBars(), extendedPullbackBars(), platformBars(), runupBars(),
    divergenceBars(), dipDivergenceBars(), squeezeBars(), rideBars(), reversionBars(), downtrendBars(),
    breachedPullbackBars(), breachThenCrossWBars(), expiredThenBreachWBars(),
  ];
  for (const bars of fixtures) {
    for (let k = 0; k < bars.dates.length; k++) {
      const asOf = bars.dates[k];
      for (const o of detectAllPatterns(patternInput(bars, k))) {
        const where = `${o.strategy_id} at ${asOf}`;
        if (o.pattern_event_date) assert.ok(o.pattern_event_date <= asOf, `${where}: event date in the future`);
        if (o.first_observed_date !== null) assert.ok(o.first_observed_date <= asOf, `${where}: observed date in the future`);
        if (o.confirmed_on) {
          assert.ok(o.confirmed_on <= asOf, `${where}: confirmation date in the future`);
          if (o.formed_on) assert.ok(o.formed_on <= o.confirmed_on, `${where}: formation after confirmation`);
        }
        if (o.stage === 'FORMING') assert.equal(o.confirmed_on, null, `${where}: FORMING cannot carry a confirmation`);
        if (o.invalidated_at) {
          assert.ok(o.invalidated_at <= asOf, `${where}: invalidation date in the future`);
          if (o.confirmed_on) assert.ok(o.invalidated_at > o.confirmed_on,
            `${where}: an instance may fail only after its confirmation`);
          if (o.formed_on) assert.ok(o.invalidated_at >= o.formed_on, `${where}: invalidation before formation`);
        }
        if (o.stage === 'FAILED') assert.ok(o.invalidated_at, `${where}: FAILED needs an invalidation date`);
        if (o.expires_at) assert.ok(o.expires_at <= asOf, `${where}: expiry date in the future`);
        if (o.stage === 'EXPIRED') assert.ok(o.expires_at, `${where}: EXPIRED needs an expiry date`);
        // No inverted lifecycle: a signal never claims to have confirmed after
        // the bar that killed it (WP2/H05). This covers the fail-before-confirm
        // branches of both the trend and W-bottom episodes.
        assert.ok(o.confirmed_on === null || o.invalidated_at === null
          || o.invalidated_at > o.confirmed_on,
        `${where}: invalidated_at (${o.invalidated_at}) must be after confirmed_on (${o.confirmed_on})`);
      }
    }
  }
});

test('lifecycle: EXPIRED means the first expiry bar and never re-dates on later replays', () => {
  const cases = [
    {
      bars: extendedPullbackBars(), sid: 'tc_v2_pullback_resume', det: detectTrendContinuation,
      confirmedIdx: 104, window: 10,
    },
    {
      bars: divergenceBars(), sid: 'rv_v2_macd_dif_divergence', det: detectReversal,
      confirmedIdx: 143, window: 40,
    },
  ];
  for (const { bars, sid, det, confirmedIdx, window } of cases) {
    const expiryIdx = confirmedIdx + window + 1; // first bar with `i - confirmed > window`
    const dates = bars.dates;
    const at = (k) => byId(det(patternInput(bars, k)), sid);
    const before = at(expiryIdx - 1);
    assert.ok(before && before.stage !== 'EXPIRED', `${sid}: not expired before its window elapses`);
    const first = at(expiryIdx);
    assert.ok(first, `${sid}: instance exists at the first expiry bar`);
    assert.equal(first.stage, 'EXPIRED');
    assert.equal(first.expires_at, dates[expiryIdx], `${sid}: expiry is the first elapsed bar`);
    assert.equal(first.confirmed_on, dates[confirmedIdx]);
    for (const off of [1, 5, 20]) {
      const replay = at(expiryIdx + off);
      assert.ok(replay, `${sid}: instance still reported at +${off}`);
      assert.equal(replay.stage, 'EXPIRED', `${sid}: stays expired at +${off}`);
      assert.equal(replay.expires_at, dates[expiryIdx], `${sid}: expires_at identical at +${off}`);
      assert.equal(replay.confirmed_on, dates[confirmedIdx], `${sid}: instance identity stable at +${off}`);
    }
  }
});

test('aggregate: output is deterministic on repeated evaluation', () => {
  for (const bars of [pullbackBars(), divergenceBars(), squeezeBars(), reversionBars()]) {
    const k = bars.dates.length - 1;
    assert.deepEqual(detectAllPatterns(patternInput(bars, k)), detectAllPatterns(patternInput(bars, k)));
  }
});

test('aggregate: definitions cover all five families and detectAllPatterns concatenates them', () => {
  assert.deepEqual(Object.keys(PATTERN_DEFINITIONS_V2).sort(), [
    'MEAN_REVERSION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'TREND_CONTINUATION', 'VOLATILITY_EXPANSION',
  ]);
  const bars = pullbackBars();
  const input = patternInput(bars, 104);
  const combined = detectAllPatterns(input);
  const expected = [
    ...detectTrendContinuation(input), ...detectPlatformBreakout(input),
    ...detectReversal(input), ...detectVolatilityExpansion(input), ...detectMeanReversion(input),
  ];
  assert.deepEqual(combined, expected);
});
