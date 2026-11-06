import test from 'node:test';
import assert from 'node:assert/strict';

const fw = await import('../build/ashare/technicalFrameworkV2.js');
const { snapshotContentHash } = await import('../build/ashare/hotspotSnapshots.js');

const barsOf = (o, h, l, c, extra = {}) => ({
  dates: ['20261102'], open: [o], high: [h], low: [l], close: [c],
  rawOpen: [o], rawHigh: [h], rawLow: [l], rawClose: [c],
  vol: [1000], upLimit: [11], downLimit: [9], ...extra,
});

test('one-price limit-down is a hard research blocker, not an improved entry', () => {
  const bars = barsOf(9, 9, 9, 9);
  const verdict = fw.tradingVerdict({ bars, endIdx: 0, suspendedOnAsOf: false, barsBehindAsOf: 0 });
  assert.equal(verdict.status, 'ONE_PRICE_LIMIT_DOWN');
  assert.ok(verdict.tags.includes('ONE_PRICE_LIMIT_DOWN'));
  const ready = fw.researchReadiness('CONFIRMED', verdict.status);
  assert.equal(ready.ready, false);
  assert.ok(ready.blockers.includes('ONE_PRICE_LIMIT_DOWN'));
});

test('stage gate: only a live confirmation on a tradable name is research-ready', () => {
  assert.equal(fw.researchReadiness('CONFIRMED', 'TRADABLE').ready, true);
  assert.equal(fw.researchReadiness('FOLLOW_THROUGH', 'TRADABLE').ready, true);
  assert.equal(fw.researchReadiness('FORMING', 'TRADABLE').ready, false);
  assert.equal(fw.researchReadiness('CONFIRMED', 'SUSPENDED').ready, false);
  assert.equal(fw.researchReadiness('CONFIRMED', 'NO_BAR').ready, false);
  assert.equal(fw.researchReadiness('CONFIRMED', 'LIMIT_UNKNOWN').ready, false);
});

test('suspended names never trade, even with an otherwise clean bar', () => {
  const bars = barsOf(10, 10.2, 9.9, 10.1);
  const verdict = fw.tradingVerdict({ bars, endIdx: 0, suspendedOnAsOf: true, barsBehindAsOf: 1 });
  assert.equal(verdict.status, 'SUSPENDED');
  assert.ok(verdict.blockers.includes('SUSPENDED'));
});

test('a stale bar is labeled but does not silently borrow the as-of date', () => {
  const bars = barsOf(10, 10.2, 9.9, 10.1);
  const verdict = fw.tradingVerdict({ bars, endIdx: 0, suspendedOnAsOf: false, barsBehindAsOf: 1 });
  assert.equal(verdict.status, 'TRADABLE');
  assert.ok(verdict.tags.includes('STALE_BAR'));
  assert.ok(verdict.blockers.includes('NO_BAR_ON_AS_OF'));
});

test('content identity covers the V2 view, the fingerprint and the data state, and excludes generated_at', () => {
  const body = {
    as_of: '20261102',
    framework: 'V2_ONLY',
    framework_version: fw.TECHNICAL_FRAMEWORK_VERSION,
    implementation_fingerprint: 'sha256:impl',
    config_version: 'cfg',
    sectors: { selected: [], sectors: [], coverage: [] },
    technical_view: { status: 'OK', as_of: '20261102', families: [], research_universe: { counts: {}, stocks: [] } },
    coverage: [],
    data_state: { version: 'data-1', as_of: '20261102', fingerprint: 'fp', readiness: 'READY' },
  };
  const base = snapshotContentHash(body);
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  // `generated_at` is not part of the payload the hash reads; adding it changes nothing.
  assert.equal(snapshotContentHash({ ...body, generated_at: '2026-11-02T13:00:00Z' }), base);

  const changedView = snapshotContentHash({ ...body, technical_view: { ...body.technical_view, families: [{ family: 'REVERSAL' }] } });
  assert.notEqual(changedView, base, 'the technical view is part of the identity');

  const changedImpl = snapshotContentHash({ ...body, implementation_fingerprint: 'sha256:other' });
  assert.notEqual(changedImpl, base, 'the compiled-module fingerprint is part of the identity');

  const changedData = snapshotContentHash({ ...body, data_state: { ...body.data_state, fingerprint: 'fp2' } });
  assert.notEqual(changedData, base, 'the data fingerprint is part of the identity');

  // Key order must never matter: the hash is stable JSON, not source order.
  const reordered = snapshotContentHash({
    data_state: body.data_state, coverage: body.coverage, technical_view: body.technical_view,
    sectors: body.sectors, config_version: body.config_version,
    implementation_fingerprint: body.implementation_fingerprint,
    framework_version: body.framework_version, framework: body.framework, as_of: body.as_of,
  });
  assert.equal(reordered, base);
});

test('family list is fixed and ordered; no cross-family score exists', () => {
  assert.deepEqual([...fw.TECHNICAL_FAMILIES], [
    'TREND_CONTINUATION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'VOLATILITY_EXPANSION', 'MEAN_REVERSION',
  ]);
  assert.equal(fw.TECHNICAL_FRAMEWORK_VERSION, 'technical-v2.1.0');
  assert.equal('compareCandidates' in fw, true);
  assert.equal('researchReadiness' in fw, true);
});

test('price position: adjusted basis, ATR extension threshold, RSI6 and RSI14 kept apart', () => {
  assert.equal(fw.PRICE_EXTENSION_ATR_THRESHOLD, 3.0);
  const n = 7;
  const x = {
    ma20: [9.5, 9.5, 9.6, 9.7, 9.8, 9.9, 10],
    ma60: new Array(n).fill(9),
    atr14: new Array(n).fill(0.5),
    rsi6: new Array(n).fill(90),
    rsi14: new Array(n).fill(75),
  };
  const base = { close: 11.5, x, endIdx: 6, confirmedIdx: 4, referencePrice: 10, referenceKind: 'ma20_reclaim', invalidationLevel: 9 };
  const p = fw.buildPricePosition(base);
  assert.equal(p.basis, 'adjusted_close');
  assert.equal(p.ma20, 10);
  assert.equal(p.close_vs_ma20_atr, 3, '(close-ma20)/atr14');
  assert.equal(p.price_extension, true, '3.0 ATR is the fixed hypothesis threshold');
  assert.match(p.price_extension_basis.join(' '), /threshold 3/);
  assert.equal(p.rsi6, 90);
  assert.equal(p.rsi14, 75);
  assert.notEqual(p.rsi6, p.rsi14, 'RSI6 and RSI14 are separate facts');
  assert.equal(p.ma20_above_ma60, true);
  assert.equal(p.ma20_rising, true);
  assert.equal(p.reference_kind, 'ma20_reclaim');
  assert.equal(p.reference_distance_atr, 3);
  assert.equal(p.bars_since_confirmation, 2);
  assert.equal(p.invalidation_distance_atr, 5);

  const below = fw.buildPricePosition({ ...base, close: 11.4 });
  assert.ok(below.close_vs_ma20_atr < 3);
  assert.equal(below.price_extension, false, 'no extension below the threshold');

  // A missing ATR is reported as uncomputable, never guessed.
  const noAtr = fw.buildPricePosition({ ...base, x: { ...x, atr14: new Array(n).fill(null) } });
  assert.equal(noAtr.close_vs_ma20_atr, null);
  assert.equal(noAtr.price_extension, false);
});
