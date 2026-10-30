// goal-1030 WP0: executable reproduction of the 2026-10-29 production defects.
//
// Every assertion below runs on the frozen real-data sample
// (test/fixtures/hotspot-20261029) and on the production modules imported from
// build/. Nothing here is synthetic: the numbers are exactly what the live
// service returned on 2026-10-29.
//
// These tests document the *current* behaviour so the defects are reproducible;
// WP1 converts each DEFECT-xx expectation into the corrected contract and keeps
// the data-driven parts (counts, replay equivalence) unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AS_OF, loadFixture, focusCandidates, candidateByCode, candidateByName,
  replayStock, dateIndex,
} from './hotspot-20261029-fixture.mjs';

const fixture = loadFixture();
const { snapshot, meta, bars } = fixture;
const focus = focusCandidates(snapshot);
const allSignals = focus.flatMap(c => c.signals ?? []);

test('WP0: frozen sample is the production 2026-10-29 snapshot', () => {
  assert.equal(snapshot.as_of, AS_OF);
  assert.equal(meta.as_of, AS_OF);
  assert.equal(meta.exported_from.snapshot_content_hash,
    'sha256:f67dbb648caf5257f5245ca5c01fb3da284153f4d412621375feb5374c41636b');
  assert.deepEqual(snapshot.counts,
    { etf_candidates: 9, excluded: 31, focus_pool: 40, raw_pool: 40, with_signals: 70 });
  assert.equal(focus.length, 40);
  assert.equal(allSignals.length, 335);
});

test('WP0: no signal was confirmed on the as-of day itself', () => {
  const todays = allSignals.filter(s => s.confirmed_on === AS_OF);
  assert.equal(todays.length, 0);
});

test('WP0: replaying the production window reproduces every stored signal and risk event', async () => {
  for (const c of focus) {
    const { scan } = await replayStock(c.ts_code, fixture);
    // tc_rps_hold needs the full-market RPS120 cross-section, which is not in
    // the offline fixture; it is asserted structurally elsewhere.
    const stored = c.signals.filter(s => s.strategy_id !== 'tc_rps_hold')
      .map(s => `${s.strategy_id}@${s.confirmed_on}#${s.status}`);
    const replayed = scan.events.filter(e => e.strategy_id !== 'tc_rps_hold')
      .map(e => `${e.strategy_id}@${e.confirmed_on}#${e.status}`);
    assert.deepEqual(replayed, stored, `${c.name} signals`);
    assert.deepEqual(scan.risk_events.map(r => `${r.id}@${r.on}`),
      c.risk_events.map(r => `${r.id}@${r.on}`), `${c.name} risk events`);
  }
});

// ---------------------------------------------------------------- DEFECT-01
// Historical signals are never re-evaluated. 325 of 335 signals are 'active';
// the only state transition ever produced is the W-bottom invalidation.
test('DEFECT-01: signal statuses are frozen at confirmation (325 active / 10 invalidated)', () => {
  const status = {};
  for (const s of allSignals) status[s.status] = (status[s.status] ?? 0) + 1;
  assert.deepEqual(status, { active: 325, invalidated: 10 });
  const byStrategy = new Set(allSignals.filter(s => s.status === 'invalidated').map(s => s.strategy_id));
  assert.deepEqual([...byStrategy], ['rv_macd_w_bottom']);
});

test('DEFECT-01: 61% of all signals are older than 120 calendar days', () => {
  const asOf = new Date('2026-10-29T00:00:00Z');
  const ages = allSignals.map(s => (asOf - new Date(
    `${s.confirmed_on.slice(0, 4)}-${s.confirmed_on.slice(4, 6)}-${s.confirmed_on.slice(6)}T00:00:00Z`)) / 86400000);
  ages.sort((a, b) => a - b);
  assert.ok(ages[Math.floor(ages.length / 2)] > 300, `median age ${ages[Math.floor(ages.length / 2)]}d`);
  assert.ok(ages.filter(a => a > 120).length >= 200, `${ages.filter(a => a > 120).length} older than 120d`);
  // No age field is even carried on the wire.
  assert.equal(allSignals.filter(s => 'signal_age_trade_days' in s).length, 0);
});

test('DEFECT-01: a strategy emits at most once per 330-bar window, so re-confirmation is impossible', () => {
  for (const c of focus) {
    const ids = c.signals.map(s => s.strategy_id);
    assert.equal(new Set(ids).size, ids.length, `${c.name} has a duplicate strategy_id`);
  }
});

// ---------------------------------------------------------------- DEFECT-02
// A signal's own declared invalidation condition has already fired, but the
// signal stays 'active' because no code path evaluates it.
test('DEFECT-02: 平安银行 tc_ma_trend stays active although its stated invalidation fired 3 times', async () => {
  const c = candidateByCode(snapshot, '000001.SZ');
  const sig = c.signals.find(s => s.strategy_id === 'tc_ma_trend');
  assert.equal(sig.confirmed_on, '20251114');
  assert.equal(sig.status, 'active');
  assert.match(sig.invalidation, /trend_breakdown on any later bar/);

  const { bars: b, scan } = await replayStock('000001.SZ', fixture);
  const breakdowns = scan.risk_events.filter(r => r.id === 'trend_breakdown').map(r => r.on);
  for (const d of ['20260108', '20261022', '20261028']) {
    assert.ok(breakdowns.includes(d), `${d} breakdown missing`);
    assert.ok(d > sig.confirmed_on, `${d} is after confirmation`);
  }
  assert.equal(sig.status, 'active', 'DEFECT: invalidation predicate fired but status never changed');
  void b;
});

test('DEFECT-02: 平安银行 tc_pullback_resume survives closes below MA60 since 20251209', async () => {
  const c = candidateByCode(snapshot, '000001.SZ');
  const sig = c.signals.find(s => s.strategy_id === 'tc_pullback_resume');
  assert.equal(sig.confirmed_on, '20251114');
  assert.match(sig.invalidation, /close < MA60/);
  const { bars: b, indicators: x } = await replayStock('000001.SZ', fixture);
  const i = dateIndex(b).get('20251209');
  assert.ok(b.close[i] < x.ma60[i], 'close below MA60 on 20251209');
  assert.equal(sig.status, 'active');
});

test('DEFECT-02: 113 provably-stale active signals across the focus pool', async () => {
  // Evaluate exactly the predicate each strategy declares, over the same bars
  // the engine used. Anything that fired after confirmation should have turned
  // the signal invalid; none did.
  const { detectSignals } = await import('../build/ashare/signals.js');
  const stats = { tc_ma_trend: [0, 0], tc_pullback_resume: [0, 0], bo_squeeze: [0, 0] };
  for (const c of focus) {
    const { bars: b, indicators: x } = await replayStock(c.ts_code, fixture);
    const di = dateIndex(b);
    for (const s of c.signals) {
      if (!(s.strategy_id in stats) || s.status !== 'active') continue;
      const ci = di.get(s.confirmed_on);
      if (ci === undefined) continue;
      stats[s.strategy_id][1]++;
      for (let i = ci + 1; i < b.dates.length; i++) {
        const fired = s.strategy_id === 'tc_ma_trend'
          ? detectSignals(b, x, i).includes('trend_breakdown')
          : s.strategy_id === 'tc_pullback_resume' ? b.close[i] < x.ma60[i] : b.close[i] < x.bollMid[i];
        if (fired) { stats[s.strategy_id][0]++; break; }
      }
    }
  }
  assert.deepEqual(stats.tc_ma_trend, [36, 40]);
  assert.deepEqual(stats.tc_pullback_resume, [40, 40]);
  assert.deepEqual(stats.bo_squeeze, [37, 40]);
});

// ---------------------------------------------------------------- DEFECT-03
// Recent risk events coexist with old bullish signals in the same candidate,
// with no linkage in either direction.
test('DEFECT-03: 平安银行 old trend signal sits beside 2026-10-22 and 2026-10-28 breakdowns', () => {
  const c = candidateByCode(snapshot, '000001.SZ');
  const tb = c.risk_events.filter(r => r.id === 'trend_breakdown').map(r => r.on);
  assert.ok(tb.includes('20261022'));
  assert.ok(tb.includes('20261028'));
  assert.equal(c.signals.find(s => s.strategy_id === 'tc_ma_trend').confirmed_on, '20251114');
  // Nothing on the signal or the candidate says the two conflict.
  for (const s of c.signals) assert.equal('conflicting_risks' in s, false);
});

test('DEFECT-03: 杭州银行 MACD bear divergence and 广汇能源 2026-10-27 bear divergence', () => {
  const hz = candidateByCode(snapshot, '600926.SH');
  assert.ok(hz.risk_events.some(r => r.id === 'macd_bear_divergence' && r.on === '20261028'));
  assert.equal(hz.signals.find(s => s.strategy_id === 'rv_macd_divergence').status, 'active');

  const gh = candidateByCode(snapshot, '600256.SH');
  assert.ok(gh.risk_events.some(r => r.id === 'macd_bear_divergence' && r.on === '20261027'));
  assert.ok(gh.priority > 80, `广汇能源 priority ${gh.priority} despite the 10-27 bear divergence`);
});

test('DEFECT-03: 五洲医疗 ranks 85 with a 2026-10-29 bear divergence and CHINEXT restriction', () => {
  const c = candidateByCode(snapshot, '301234.SZ');
  assert.equal(c.priority, 85);
  assert.equal(c.trade_permission, 'RESEARCH_ONLY');
  assert.equal(c.trade_permission_reason, 'CHINEXT_RESEARCH_ONLY');
  assert.ok(c.risk_events.some(r => r.id === 'macd_bear_divergence' && r.on === '20261029'));
  // Newest bullish signal here is from 2026-08-07, 83 calendar days stale.
  assert.ok(c.signals.every(s => s.confirmed_on < '20260830'));
});

test('DEFECT-03: 艾艾精工 keeps 7 old bullish signals after its W-bottom was invalidated', () => {
  const c = candidateByCode(snapshot, '603580.SH');
  const w = c.signals.find(s => s.strategy_id === 'rv_macd_w_bottom');
  assert.equal(w.status, 'invalidated');
  assert.equal(w.invalidation, '20251216:series fell below -0.0543 (both lows)');
  const active = c.signals.filter(s => s.status === 'active');
  assert.equal(active.length, 7);
  // The candidate still ranks 84.99 on those stale signals.
  assert.equal(c.priority, 84.99);
});

// ---------------------------------------------------------------- DEFECT-04
// priority_reason is a rendering string, not the formula that produced priority.
test('DEFECT-04: the printed formula cannot reproduce 平安银行 priority 82.31', () => {
  const c = candidateByCode(snapshot, '000001.SZ');
  assert.equal(c.priority, 82.31);
  const m = /^score\(([\d.]+)\)\*0\.5 \+ rps120\(([\d.]+)\)\*0\.35 \+ signals\((\d+)\)\*5 - risk\((\d+)\)\*5$/
    .exec(c.priority_reason);
  assert.ok(m, c.priority_reason);
  const [score, rps, sig, risk] = m.slice(1).map(Number);
  const printed = score * 0.5 + rps * 0.35 + sig * 5 - risk * 5;
  assert.ok(Math.abs(printed - -11.59) < 0.01, `printed formula ${printed}`); // what the printed formula yields
  assert.notEqual(Math.round(printed * 100) / 100, c.priority);                // what the engine returned
  // The engine's real formula, applied to the printed components, does match —
  // but only because `score` is on a 0-100 scale and gets multiplied by 100
  // again, so the clamp pins every candidate's score contribution to 50.
  const actual = Math.round(Math.max(0,
    Math.max(0, Math.min(100, score * 100)) * 0.5
    + rps * 0.35 + Math.min(15, sig * 5) - Math.min(15, risk * 5)) * 100) / 100;
  assert.equal(actual, c.priority);
});

test('DEFECT-04: the score component is a constant 50, so priority === 50 + 0.35·RPS120 for all 40', () => {
  const rows = focus.filter(c => c.priority !== null).map(c => {
    const m = /^score\(([\d.]+)\)\*0\.5 \+ rps120\(([\d.]+)\)/.exec(c.priority_reason);
    return { code: c.ts_code, priority: c.priority, score: Number(m[1]), rps: Number(m[2]) };
  });
  assert.equal(rows.length, 40);
  for (const r of rows) {
    assert.ok(r.score * 100 >= 100, `${r.code} score ${r.score} not clamped`);
    const collapsed = Math.round((50 + r.rps * 0.35) * 100) / 100;
    assert.equal(r.priority, collapsed, `${r.code}: priority is not pure RPS120`);
  }
});

test('DEFECT-04: signal and risk terms always cancel (both caps already saturated)', () => {
  for (const c of focus.filter(x => x.priority !== null)) {
    const sigCount = c.signals.filter(s => s.status === 'active').length;
    assert.ok(sigCount >= 3, `${c.name} signals ${sigCount}`);
    assert.ok((c.risk_events ?? []).length >= 3, `${c.name} risks ${(c.risk_events ?? []).length}`);
  }
});

test('DEFECT-05: the risk overlay records one event per firing bar, not per episode', () => {
  const c = candidateByCode(snapshot, '000001.SZ');
  const div = c.risk_events.filter(r => r.id === 'macd_bear_divergence');
  assert.equal(div.length, 22);
  // 22 dates, but the reason prints risk(26) — the counts are also intransparent.
  assert.ok(c.priority_reason.endsWith('risk(26)*5'));
});

test('DEFECT-06: the wire carries no lifecycle identity at all', () => {
  const required = ['signal_id', 'last_validated_on', 'invalidated_on', 'invalidation_reason',
    'signal_age_trade_days', 'conflicting_risks', 'source_data_as_of', 'strategy_version'];
  for (const s of allSignals) {
    for (const k of required) assert.equal(k in s, false, `${k} unexpectedly present`);
  }
});
