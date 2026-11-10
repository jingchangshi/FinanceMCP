import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const { buildResearchCases, RESEARCH_CASE_SCHEMA } = await import('../build/portfolio/researchCase.js');

const AS_OF = '20261109';

function stock(code, state = 'WATCH', overrides = {}) {
  return {
    ts_code: code, name: code, as_of_trade_date: AS_OF, trade_date: AS_OF, bars_behind_as_of: 0,
    research_state: state, research_state_label: state, primary_family: null, primary_pattern: null,
    price_position: null, signals: [], decisive_reasons: [], conflicting_evidence: [],
    counter_evidence: ['technical counter'], watch_conditions: ['review close'], trading_constraints: [],
    trading_status: 'NORMAL', price_volume_tags: [], sectors: [], market_regime: 'UNKNOWN', rps120: null,
    research_ready: true, evidence_level: 'RESEARCH_ONLY', trade_permission: 'RESEARCH_ONLY',
    trade_permission_reason: 'research only', ...overrides,
  };
}

test('ResearchCase keeps every holding and distinguishes missing evidence from negative evidence', () => {
  const result = buildResearchCases({ asOf: AS_OF, holdings: [{ ts_code: '159558.SZ', name: 'ETF', research: null }] });
  assert.equal(result.length, 1);
  assert.equal(result[0].schema, RESEARCH_CASE_SCHEMA);
  assert.equal(result[0].role, 'HOLDING');
  assert.equal(result[0].technical.status, 'UNAVAILABLE');
  assert.equal(result[0].fundamentals.status, 'UNAVAILABLE');
  // 缺失证据单独列入 evidence_gaps；不得伪装成 counter_thesis 里的负面证据。
  assert.ok(result[0].evidence_gaps.some(text => /数据缺口|未提供/.test(text)));
  assert.doesNotMatch(result[0].counter_thesis.join(' '), /数据缺口/);
  assert.match(result[0].limitations.join(' '), /不构成交易指令/);
});

test('ResearchCase enriches stock candidates with point-in-time facts and prioritizes account overlap', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fina_indicator (
    ts_code TEXT, end_date TEXT, ann_date TEXT, roe REAL, netprofit_yoy REAL, or_yoy REAL,
    grossprofit_margin REAL, debt_to_assets REAL, ocf_to_profit REAL, eps REAL
  );
  CREATE TABLE daily_basic (ts_code TEXT, trade_date TEXT, pe_ttm REAL, pb REAL, ps_ttm REAL, dv_ttm REAL, total_mv REAL);
  INSERT INTO fina_indicator VALUES ('600001.SH','20260930','20261020',8,12,15,30,42,90,1.2);
  INSERT INTO daily_basic VALUES ('600001.SH','${AS_OF}',18,2,3,1.5,100000);`);
  try {
    const result = buildResearchCases({
      asOf: AS_OF, marketDb: db, limitCandidates: 1,
      highlights: [stock('600002.SH', 'FOCUS')],
      watch: [stock('600001.SH', 'WATCH', { sectors: ['banking'] })],
      deteriorating: [stock('600003.SH', 'DETERIORATING')],
      priorityCandidateCodes: ['600001.SH'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].ts_code, '600001.SH');
    assert.equal(result[0].fundamentals.status, 'AVAILABLE');
    assert.equal(result[0].fundamentals.value.latest.ann_date, '20261020');
    assert.equal(result[0].valuation.value.trade_date, AS_OF);
    assert.deepEqual(result[0].counter_thesis, ['technical counter']);
    assert.match(result[0].limitations.join(' '), /研究对象/);
  } finally { db.close(); }
});

test('ResearchCase does not use a financial record announced after as-of', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fina_indicator (
    ts_code TEXT, end_date TEXT, ann_date TEXT, roe REAL, netprofit_yoy REAL, or_yoy REAL,
    grossprofit_margin REAL, debt_to_assets REAL, ocf_to_profit REAL, eps REAL
  );
  CREATE TABLE daily_basic (ts_code TEXT, trade_date TEXT, pe_ttm REAL, pb REAL, ps_ttm REAL, dv_ttm REAL, total_mv REAL);
  INSERT INTO fina_indicator VALUES ('600001.SH','20260930','20261120',8,12,15,30,42,90,1.2);`);
  try {
    const result = buildResearchCases({ asOf: AS_OF, marketDb: db, watch: [stock('600001.SH')], limitCandidates: 1 });
    assert.equal(result.length, 1);
    assert.equal(result[0].fundamentals.status, 'UNAVAILABLE');
    assert.match(result[0].fundamentals.gap, /公告日约束/);
  } finally { db.close(); }
});
