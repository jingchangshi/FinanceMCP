import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const {
  buildDailyBrief, DAILY_BRIEF_SCHEMA, dailyBriefPath, latestDailyBriefDate, readDailyBrief, writeDailyBrief,
} = await import('../build/portfolio/dailyBrief.js');

test('daily brief projects actionable fields and drops heavy research arrays', () => {
  const report = {
    schema: 'ashare-daily-action-report/1.0',
    report_id: 'R-1',
    as_of_trade_date: '20261124',
    expected_next_trade_date: '20261125',
    status: 'ACTIONABLE',
    actionable: true,
    timestamps: { generated_at: '2026-11-24T11:40:00.000Z' },
    account_id: 'real-main',
    account_id_source: 'default',
    account_status: 'REAL_ACCOUNT_VERIFIED',
    first_section: { heading: 'h', count: 1, actions: [{ code: 'A' }], no_action_reason: null, observation_triggers: [] },
    execution_plan: { count: 1, actions: [{ code: 'A' }] },
    v3_cockpit: { schema: 'v3-offensive-cockpit/1.0' },
    holdings: [{ ts_code: '159558.SZ' }],
    data_quality: { status: 'OK' },
    candidate_vs_cash: { huge: 'x'.repeat(10_000) },
    evidence_register: { huge: 'y'.repeat(10_000) },
  };
  const brief = buildDailyBrief(report);
  assert.equal(brief.schema, DAILY_BRIEF_SCHEMA);
  assert.equal(brief.report_id, 'R-1');
  assert.equal(brief.as_of_trade_date, '20261124');
  assert.equal(brief.generated_at, '2026-11-24T11:40:00.000Z');
  assert.equal(brief.first_section.count, 1);
  assert.equal(brief.execution_plan.count, 1);
  assert.equal(brief.candidate_vs_cash, undefined);
  assert.equal(brief.evidence_register, undefined);
  assert.ok(JSON.stringify(brief).length < 5_000);
});

test('daily brief cache is 0600, round-trips, and reports the latest date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-brief-'));
  const dbPath = join(dir, 'portfolio.sqlite');
  const first = { schema: DAILY_BRIEF_SCHEMA, as_of_trade_date: '20261123', status: 'PASS', first_section: { count: 0, actions: [] } };
  const second = { schema: DAILY_BRIEF_SCHEMA, as_of_trade_date: '20261124', status: 'PASS', first_section: { count: 0, actions: [] } };
  const p23 = dailyBriefPath('20261123', dbPath);
  const p24 = dailyBriefPath('20261124', dbPath);
  writeDailyBrief(p23, first);
  writeDailyBrief(p24, second);
  assert.equal(statSync(p23).mode & 0o777, 0o600);
  assert.deepEqual(readDailyBrief(p23), first);
  assert.deepEqual(readDailyBrief(p24), second);
  assert.equal(latestDailyBriefDate(dbPath), '20261124');
  assert.equal(readDailyBrief(join(dir, 'missing.json')), null);
});
