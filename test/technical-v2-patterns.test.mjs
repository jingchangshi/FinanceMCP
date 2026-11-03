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

const byId = (observations, id) => observations.find(o => o.strategy_id === id);

// ---------------------------------------------------------------- A. trend

test('trend continuation: MA20 pullback resumes on the confirmation bar (no backfill)', () => {
  const bars = pullbackBars();
  const dates = bars.dates;

  const before = detectTrendContinuation(patternInput(bars, 103));
  const pullBefore = before.filter(o => o.strategy_id === 'tc_v2_pullback_resume');
  assert.equal(pullBefore.some(o => o.stage === 'CONFIRMED'), false,
    'the day before the resume cannot carry a confirmation');
  assert.equal(pullBefore.some(o => o.confirmed_on === dates[104]), false,
    'future resume date is invisible at the prior bar');

  const resume = byId(detectTrendContinuation(patternInput(bars, 104)), 'tc_v2_pullback_resume');
  assert.ok(resume, 'resume observation exists');
  assert.equal(resume.stage, 'CONFIRMED');
  assert.equal(resume.stage_detail, 'PULLBACK_RESUME');
  assert.equal(resume.formed_on, dates[103], 'formation is the MA20 touch date');
  assert.equal(resume.confirmed_on, dates[104], 'confirmation is the resume date, not the touch');
  assert.equal(resume.evidence.rps_background_only, true, 'RPS is background only');
});

test('trend continuation: bullish alignment alone is background, never a confirmation', () => {
  // 120 bars of steady rise: close > MA20 > MA60 the whole way, but the low
  // never touches MA20, so there is no pullback and no resume to confirm.
  const bars = makeBars(Array.from({ length: 120 }, (_, i) => 10 + 0.05 * i));
  const obs = detectTrendContinuation(patternInput(bars, 119));
  assert.equal(obs.some(o => o.stage === 'CONFIRMED' || o.stage === 'FOLLOW_THROUGH'), false,
    'MA20 > MA60 is context; confirmation needs the pullback resume');
  assert.equal(obs.some(o => o.strategy_id === 'tc_v2_trend_established'), false,
    'there is no standalone trend-established signal');
});

// ---------------------------------------------------------------- B. platform

test('platform breakout: tight base confirms on the volume breakout; a run-up never does', () => {
  const bars = platformBars();
  const dates = bars.dates;

  const forming = detectPlatformBreakout(patternInput(bars, 129));
  assert.equal(forming.length, 1);
  assert.equal(forming[0].stage, 'FORMING');
  assert.equal(forming[0].stage_detail, 'PLATFORM_FORMING');
  assert.equal(forming[0].formed_on, dates[99], 'platform window starts 30 bars before the evaluation bar');
  assert.equal(forming[0].confirmed_on, null);

  const confirmed = detectPlatformBreakout(patternInput(bars, 130));
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].stage, 'CONFIRMED');
  assert.equal(confirmed[0].stage_detail, 'BREAKOUT_CONFIRMED');
  assert.equal(confirmed[0].confirmed_on, dates[130], 'breakout bar date');
  assert.equal(confirmed[0].formed_on, dates[100]);
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

// ---------------------------------------------------------------- no future data

test('no-future: every family is truncation-invariant', () => {
  const cases = [
    { det: detectTrendContinuation, bars: pullbackBars(), at: [90, 100, 102, 103, 104] },
    { det: detectPlatformBreakout, bars: platformBars(), at: [100, 128, 129, 130, 131] },
    { det: detectReversal, bars: divergenceBars(), at: [100, 115, 118, 130, 142, 143] },
    { det: detectVolatilityExpansion, bars: squeezeBars(), at: [121, 130, 138, 140, 145] },
    { det: detectVolatilityExpansion, bars: rideBars(), at: [185, 190, 192, 193, 199] },
    { det: detectMeanReversion, bars: reversionBars(), at: [135, 141, 142, 145, 153] },
  ];
  const pick = (o) => ({
    strategy_id: o.strategy_id, family: o.family, stage: o.stage, stage_detail: o.stage_detail,
    formed_on: o.formed_on, confirmed_on: o.confirmed_on,
    invalidation: o.invalidation, last_evaluated_on: o.last_evaluated_on,
  });
  for (const { det, bars, at } of cases) {
    for (const k of at) {
      const full = det(patternInput(bars, k)).map(pick);
      const cut = det(patternInput(truncateBars(bars, k), k)).map(pick);
      assert.deepEqual(cut, full, `truncation mismatch at bar ${k}`);
    }
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
