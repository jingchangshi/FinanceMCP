// goal-1030 WP3: candidate classes and the independent entry ranking.
//
// The two questions must not collapse into one list: research value keeps the
// legacy priority order (FOCUS semantics untouched), entry timing is a separate,
// gated ranking that may legitimately be empty.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEntryView, classifyCandidate, RANKING_RULES_VERSION } from '../build/ashare/entryRanking.js';

function cand(over = {}) {
  return {
    as_of: '20261029', ts_code: '600000.SH', name: '测试',
    instrument_type: 'STOCK', primary_sector: null, sectors: [], etf_sources: [], multi_etf: false,
    leaderships: [], leader_evidence: [], signals: [], risk_events: [],
    trade_permission: 'EXECUTABLE', trade_permission_reason: 'MAINBOARD_OK',
    pool: 'FOCUS', inclusion_reason: 'x', priority: 50, priority_reason: 'p',
    research_score: 0.5, data_quality: 'OK',
    entry_stage: null, entry_eligibility: false, entry_score: null,
    entry_assessments: [], entry_rejection_reasons: [],
    ...over,
  };
}

const cls = (over) => classifyCandidate(cand(over)).candidate_class;

test('ranking: every stage maps to exactly one research class', () => {
  assert.equal(cls({}), 'RESEARCH_ONLY', 'no entry evidence');
  assert.equal(cls({ entry_stage: 'PREPARING' }), 'PREPARING');
  assert.equal(cls({ entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true }), 'NEW_ENTRY');
  assert.equal(cls({ entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: false }), 'RISK_REJECTED');
  assert.equal(cls({ entry_stage: 'PULLBACK_READY', entry_eligibility: true }), 'PULLBACK_WAIT');
  assert.equal(cls({ entry_stage: 'EXTENDED' }), 'PULLBACK_WAIT');
  assert.equal(cls({ entry_stage: 'RISK_BLOCKED' }), 'RISK_REJECTED');
  assert.equal(cls({ entry_stage: 'INVALIDATED' }), 'RISK_REJECTED');
  assert.equal(cls({ entry_stage: 'EXPIRED' }), 'RISK_REJECTED');
  assert.equal(cls({ entry_stage: 'INSUFFICIENT_DATA' }), 'INSUFFICIENT_DATA');
  assert.equal(cls({ data_quality: 'UNAVAILABLE', entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true }),
    'INSUFFICIENT_DATA', 'unknown data outranks a good-looking stage');
});

test('ranking: permission and instrument type are class boundaries', () => {
  const none = classifyCandidate(cand({ trade_permission: 'RESEARCH_ONLY', trade_permission_reason: 'CHINEXT_RESEARCH_ONLY' }));
  assert.equal(none.candidate_class, 'RESEARCH_ONLY');
  assert.equal(none.entry_eligibility, false);
  assert.ok(none.eligibility_reasons.includes('RESEARCH_ONLY_PERMISSION'));

  const etf = classifyCandidate(cand({ instrument_type: 'ETF', trade_permission: 'EXECUTABLE', entry_rejection_reasons: ['ETF_NO_ENTRY_MODEL'] }));
  assert.equal(etf.candidate_class, 'RESEARCH_ONLY');
  assert.equal(etf.entry_eligibility, false);
});

test('ranking: PREPARING is watchable but never listed as an entry candidate', () => {
  const view = buildEntryView([cand({
    entry_stage: 'PREPARING', entry_score: 85, entry_rejection_reasons: ['NOT_CONFIRMED'],
  })], '20261029');
  assert.equal(view.entry_top10.length, 0, 'a watch list is not an entry list');
  assert.equal(view.preparing_top.length, 1);
  assert.equal(view.counts.PREPARING, 1);
  assert.equal(view.rules_version, RANKING_RULES_VERSION);
});

test('ranking: entry top-10 is ordered by entry score, never by signal count', () => {
  const manyStaleSignals = cand({
    ts_code: '600001.SH', name: '多旧信号', priority: 99,
    signals: new Array(6).fill({ strategy_id: 'x', family: 'TREND_CONTINUATION', direction: 'bullish', confirmed_on: '20250102', invalidation: '', status: 'expired' }),
    entry_stage: 'EXTENDED', entry_eligibility: false, entry_score: 70,
    entry_rejection_reasons: ['STAGE_EXTENDED'],
  });
  const fresh = cand({
    ts_code: '600002.SH', name: '新入场', priority: 40,
    entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true, entry_score: 88,
    entry_assessments: [{ confirmed_on: '20261028', risk_reward: 2.1 }],
  });
  const view = buildEntryView([manyStaleSignals, fresh], '20261029');
  assert.deepEqual(view.entry_top10.map(e => e.ts_code), ['600002.SH']);
  assert.equal(view.entry_top10[0].confirmed_on, '20261028');
  assert.equal(view.entry_top10[0].risk_reward, 2.1);
  // The stale-signal name is research top-1 and rejected for entry, with reasons.
  assert.deepEqual(view.research_top10.map(e => e.ts_code), ['600001.SH', '600002.SH']);
  assert.deepEqual(view.rejected_high_rank.map(e => e.ts_code), ['600001.SH']);
  assert.deepEqual(view.rejected_high_rank[0].rejection_reasons, ['STAGE_EXTENDED']);
});

test('ranking: entry ranking ties break by code, so the list is reproducible', () => {
  const mk = (code, score) => cand({
    ts_code: code, entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true, entry_score: score,
  });
  const view = buildEntryView([mk('600003.SH', 80), mk('600001.SH', 80), mk('600002.SH', 91)], '20261029');
  assert.deepEqual(view.entry_top10.map(e => e.ts_code), ['600002.SH', '600001.SH', '600003.SH']);
  assert.deepEqual(buildEntryView([mk('600002.SH', 91), mk('600001.SH', 80), mk('600003.SH', 80)], '20261029'),
    view, 'input order never changes the view');
});

test('ranking: research top-10 keeps the legacy priority order and ignores entry fields', () => {
  const base = [
    cand({ ts_code: '600010.SH', priority: 70 }),
    cand({ ts_code: '600011.SH', priority: 82 }),
    cand({ ts_code: '600012.SH', priority: 61 }),
  ];
  const withEntry = base.map(c => ({ ...c, entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true, entry_score: 95 }));
  const a = buildEntryView(base, '20261029').research_top10.map(e => e.ts_code);
  const b = buildEntryView(withEntry, '20261029').research_top10.map(e => e.ts_code);
  assert.deepEqual(a, ['600011.SH', '600010.SH', '600012.SH']);
  assert.deepEqual(b, a, 'entry evidence does not reorder the research list');
});

test('ranking: zero eligible candidates is a valid answer, not an error', () => {
  const view = buildEntryView([
    cand({ ts_code: '600001.SH', entry_stage: 'EXTENDED', entry_score: 70 }),
    cand({ ts_code: '600002.SH', entry_stage: 'RISK_BLOCKED', entry_score: 40 }),
  ], '20261029');
  assert.equal(view.entry_top10.length, 0);
  assert.equal(view.counts.NEW_ENTRY, 0);
  assert.equal(view.counts.PULLBACK_WAIT, 1);
  assert.equal(view.counts.RISK_REJECTED, 1);
  assert.ok(view.definition_note.length > 0, 'the view explains what each list means');
});

test('ranking: counts cover every stock candidate exactly once', () => {
  const list = [
    cand({ ts_code: '600001.SH', entry_stage: 'NEWLY_CONFIRMED', entry_eligibility: true, entry_score: 90 }),
    cand({ ts_code: '600002.SH', entry_stage: 'PREPARING', entry_score: 85 }),
    cand({ ts_code: '600003.SH', entry_stage: 'RISK_BLOCKED' }),
    cand({ ts_code: '600004.SH', data_quality: 'UNAVAILABLE' }),
    cand({ ts_code: '600005.SH' }),
    cand({ ts_code: '600006.SH', trade_permission: 'RESEARCH_ONLY' }),
    cand({ ts_code: '510300.SH', instrument_type: 'ETF', trade_permission: 'EXECUTABLE' }),
  ];
  const view = buildEntryView(list, '20261029');
  const total = Object.values(view.counts).reduce((s, n) => s + n, 0);
  assert.equal(total, 6, 'ETFs are vehicles, not entry candidates');
});
