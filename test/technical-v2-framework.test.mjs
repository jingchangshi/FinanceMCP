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

test('technical_view_v2 joins the content identity only when present', () => {
  const body = {
    as_of: '20261102',
    config_version: 'cfg',
    strategy_set_version: 'strat',
    sectors: [],
    candidates: [],
    counts: {},
    coverage: [],
    entry_view: null,
    data_state: {
      version: 'data-1', as_of: '20261102', fingerprint: 'fp',
      entry_identity: null, checked_at: '2026-11-02T13:00:00Z',
    },
  };
  const without = snapshotContentHash(body, { basis: 'v2' });
  const explicitUndefined = snapshotContentHash({ ...body, technical_view_v2: undefined }, { basis: 'v2' });
  const withV2 = snapshotContentHash({ ...body, technical_view_v2: { status: 'OK', families: [] } }, { basis: 'v2' });
  assert.equal(explicitUndefined, without, 'an absent/undefined V2 field must not change a legacy hash');
  assert.notEqual(withV2, without, 'a real V2 payload must be part of the identity');
});

test('family list is fixed and ordered; no cross-family score exists', () => {
  assert.deepEqual([...fw.TECHNICAL_FAMILIES], [
    'TREND_CONTINUATION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'VOLATILITY_EXPANSION', 'MEAN_REVERSION',
  ]);
  assert.equal(fw.TECHNICAL_FRAMEWORK_VERSION.startsWith('technical-v2.'), true);
  assert.equal('compareCandidates' in fw, true);
  assert.equal('researchReadiness' in fw, true);
});
