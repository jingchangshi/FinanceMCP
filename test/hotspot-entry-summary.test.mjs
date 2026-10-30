// goal-1030 WP5.2: the private research bundle's `hotspot_research.entry_summary`.
//
// The entry summary is what a private caller (ChatGPT on the OAuth endpoint)
// reads instead of enumerating every candidate. Its failure modes are all
// disclosure failures — a stale snapshot silently treated as "nothing to report",
// an unmapped holding treated as "no overlap", a running invalidation total
// reported as today's — so each of those is asserted here rather than assumed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildHotspotState } from '../build/portfolio/researchBundle.js';
import { openAshareDb } from '../build/ashare/db.js';

const AS_OF = '20261029';

function candidate(over = {}) {
  const stage = over.entry_stage ?? 'NEWLY_CONFIRMED';
  const eligible = over.entry_eligibility ?? (stage === 'NEWLY_CONFIRMED');
  const score = over.entry_score ?? (eligible ? 90 : null);
  return {
    ts_code: '600000.SH', name: '测试', instrument_type: 'STOCK', pool: 'FOCUS',
    primary_sector: 'SW2021:801780.SI', sectors: ['SW2021:801780.SI'],
    trade_permission: 'EXECUTABLE', data_quality: 'OK', priority: 70,
    entry_stage: stage, entry_eligibility: eligible, entry_score: score,
    entry_rejection_reasons: over.entry_rejection_reasons ?? [],
    signals: over.signals ?? [],
    entry_assessments: eligible || over.with_assessment ? [{
      strategy_family: 'BREAKOUT', entry_stage: stage, entry_eligibility: eligible,
      entry_score: score, confirmed_on: '20261029', signal_age_trade_days: 0,
      entry_distance: { atr: 0.2 }, objective_risk_distance: { pct: 0.02 },
      reward_estimate: { pct: 0.05 }, risk_reward: 2.5, risk_reward_uncertainty: 'MEDIUM',
      invalidation_condition: { description: 'close < MA60' },
      hard_invalidations: [], soft_risk_warnings: [], rejection_reasons: over.entry_rejection_reasons ?? [],
    }] : [],
    ...over,
  };
}

function withSnapshot(payload, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'entry-summary-'));
  const path = join(dir, 'ashare.sqlite');
  const writable = openAshareDb(path);
  writable.exec(`CREATE TABLE IF NOT EXISTS hotspot_snapshot (
    as_of TEXT NOT NULL, config_version TEXT NOT NULL, strategy_set_version TEXT,
    payload TEXT NOT NULL, content_hash TEXT, generated_at TEXT NOT NULL, coverage TEXT,
    PRIMARY KEY (as_of, config_version));`);
  if (payload) {
    writable.prepare(`INSERT INTO hotspot_snapshot
      (as_of, config_version, strategy_set_version, payload, content_hash, generated_at, coverage)
      VALUES (?,?,?,?,?,?,?)`).run(
      AS_OF, payload.config_version, payload.strategy_set_version, JSON.stringify(payload),
      payload.content_hash, '2026-10-29T15:00:00Z', '{}');
  }
  writable.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function payload(candidates, over = {}) {
  return {
    as_of: AS_OF, config_version: 'hotspot-config-1.0.0', strategy_set_version: 'strategies-hs-1.0',
    content_hash: 'sha256:test', research_only: true,
    counts: { raw_pool: candidates.length, focus_pool: candidates.length, excluded: 0, etf_candidates: 0, with_signals: 0 },
    sectors: { selected: [], sectors: [] },
    candidates,
    ...over,
  };
}

// ---------------------------------------------------------------- 1

test('entry_summary counts and ranks only what the entry view in the snapshot says', () => {
  const candidates = [
    candidate({ ts_code: '600001.SH', entry_score: 94 }),
    candidate({ ts_code: '600002.SH', entry_score: 99 }),
    candidate({ ts_code: '600003.SH', entry_stage: 'PREPARING', entry_eligibility: false, entry_score: 20, with_assessment: true }),
    candidate({ ts_code: '600004.SH', entry_stage: 'INVALIDATED', entry_eligibility: false, entry_rejection_reasons: ['SIGNAL_INVALIDATED'] }),
    candidate({ ts_code: '688001.SH', trade_permission: 'RESEARCH_ONLY', entry_eligibility: false }),
  ];
  withSnapshot(payload(candidates, {
    entry_view: { rules_version: 'ranking-rules-1.0.0', counts: {}, entry_top10: [], preparing_top: [], rejected_high_rank: [], research_top10: [], definition_note: 'x' },
  }), db => {
    const state = buildHotspotState({ db, asOf: AS_OF });
    assert.equal(state.status, 'OK');
    assert.equal(state.research_only, true);
    const s = state.entry_summary;
    assert.ok(s, 'a snapshot with an entry view must produce an entry summary');
    assert.equal(s.maturity, 'ENTRY_VIEW_PRESENT');
    assert.equal(s.rules_version, 'ranking-rules-1.0.0');
    assert.equal(s.counts.eligible, 2);
    assert.deepEqual(s.key_candidates.map(c => c.ts_code), ['600002.SH', '600001.SH'],
      'eligible candidates are ranked by entry score, highest first');
    assert.equal(s.counts.preparing, 1);
    assert.equal(s.counts.risk_rejected, 1);
    assert.equal(s.counts.research_only, 1);
    assert.deepEqual(s.rejected_candidates.map(c => c.ts_code), ['600004.SH']);
    assert.deepEqual(s.data_gaps, [], 'nothing is missing, so nothing may be disclosed as missing');
  });
});

// ---------------------------------------------------------------- 2

test('a pre-WP3 snapshot is reported as such, not as "no opportunities"', () => {
  const candidates = [candidate({ ts_code: '600001.SH', entry_stage: null, entry_eligibility: false, entry_score: null })];
  withSnapshot(payload(candidates), db => {
    const s = buildHotspotState({ db, asOf: AS_OF }).entry_summary;
    assert.ok(s, 'the summary still exists; it just cannot rank');
    assert.equal(s.maturity, 'SNAPSHOT_WITHOUT_ENTRY_VIEW');
    assert.equal(s.rules_version, null);
    assert.ok(s.data_gaps.some(g => g.startsWith('SNAPSHOT_WITHOUT_ENTRY_VIEW')),
      'the missing entry view must be disclosed by name');
    assert.equal(s.counts.eligible, 0);
    assert.deepEqual(s.key_candidates, []);
  });
});

// ---------------------------------------------------------------- 3

test("today's invalidations are counted by date, never as a running total", () => {
  const signals = [
    { strategy_id: 'bo_volume_20d', confirmed_on: '20260901', status: 'invalidated', invalidated_on: AS_OF },
    { strategy_id: 'tc_ma_trend', confirmed_on: '20260902', status: 'invalidated', invalidated_on: AS_OF },
    { strategy_id: 'rv_macd_w_bottom', confirmed_on: '20260801', status: 'invalidated', invalidated_on: '20261020' },
    { strategy_id: 'tc_pullback_resume', confirmed_on: '20260903', status: 'active', invalidated_on: null },
  ];
  const candidates = [candidate({ ts_code: '600001.SH', signals })];
  withSnapshot(payload(candidates, {
    entry_view: { rules_version: 'ranking-rules-1.0.0', counts: {}, entry_top10: [], preparing_top: [], rejected_high_rank: [], research_top10: [], definition_note: 'x' },
  }), db => {
    const s = buildHotspotState({ db, asOf: AS_OF }).entry_summary;
    assert.equal(s.counts.invalidated_signals_today, 2,
      'only the two signals invalidated on the as-of date count; the older one and the live one do not');
  });
});

// ---------------------------------------------------------------- 4

test('an unmappable holding is disclosed, never treated as "no overlap"', () => {
  const candidates = [candidate({ ts_code: '600001.SH' })];
  const view = { rules_version: 'ranking-rules-1.0.0', counts: {}, entry_top10: [], preparing_top: [], rejected_high_rank: [], research_top10: [], definition_note: 'x' };
  withSnapshot(payload(candidates, { entry_view: view }), db => {
    // One holding that is a candidate (mappable) and one that is not.
    const s = buildHotspotState({
      db, asOf: AS_OF,
      holdings: [{ ts_code: '600001.SH', name: '可映射' }, { ts_code: '600999.SH', name: '无映射' }],
    }).entry_summary;
    assert.deepEqual(s.holdings_without_sector_mapping, ['600999.SH']);
    assert.ok(s.data_gaps.some(g => g.startsWith('HOLDING_SECTOR_UNMAPPED')));
    assert.equal(s.holdings_checked, 1);
    assert.equal(s.overlap_with_holdings.length, 1);
    assert.deepEqual(s.overlap_with_holdings[0].candidates, ['600001.SH'],
      'the held sector is reported together with the eligible candidate sitting in it');
    assert.ok(s.portfolio_risk_impact);
    assert.equal(s.portfolio_risk_impact.candidates_in_held_sectors, 1);
    // No sizing, no correlation, no weights: only counts and a note.
    assert.deepEqual(Object.keys(s.portfolio_risk_impact).sort(),
      ['candidates_in_held_sectors', 'candidates_in_other_sectors', 'note', 'sectors_affected']);
  });

  // Nothing mappable at all: the overlap section must be withheld, with a reason.
  withSnapshot(payload(candidates, { entry_view: view }), db => {
    const s = buildHotspotState({ db, asOf: AS_OF, holdings: [{ ts_code: '600999.SH' }] }).entry_summary;
    assert.equal(s.overlap_with_holdings, null);
    assert.equal(s.portfolio_risk_impact, null);
    assert.ok(s.data_gaps.some(g => g.startsWith('HOLDING_OVERLAP_UNCOMPUTABLE')));
  });
});

// ---------------------------------------------------------------- 5

test('no snapshot at all degrades to NOT_READY instead of an empty entry summary', () => {
  withSnapshot(null, db => {
    const state = buildHotspotState({ db, asOf: AS_OF });
    assert.equal(state.status, 'NOT_READY');
    assert.equal(state.entry_summary, null);
    assert.equal(state.research_only, true);
    assert.ok(state.gaps.some(g => g.reason === 'hotspot_snapshot_not_generated'));
  });
  const noDb = buildHotspotState({ db: null, asOf: AS_OF });
  assert.equal(noDb.status, 'UNAVAILABLE');
  assert.equal(noDb.entry_summary, null);
});
