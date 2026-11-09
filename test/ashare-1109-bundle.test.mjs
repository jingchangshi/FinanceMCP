import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

// goal-1109 A08 / A09 / A12 / A19, on the same fixture style as
// research-snapshot-identity.test.mjs (deterministic synthetic market + portfolio DB).

const dir = mkdtempSync(join(tmpdir(), 'ashare-1109-bundle-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market-default.sqlite');
const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { DEMO_SNAPSHOT, importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount } = await import('../build/portfolio/ledger.js');
const { buildInvestmentResearchBundle, persistedSnapshotStatus } = await import('../build/portfolio/researchBundle.js');
const { runBundleRecordCommand } = await import('../build/portfolio/bundleRecordCli.js');
const { readResearchJournal } = await import('../build/portfolio/researchJournal.js');

const ACCOUNT = 'synthetic-1109-bundle';
const AS_OF = '20261020';
let seq = 0;

function fixture({ confirmed = true } = {}) {
  seq += 1;
  const marketPath = join(dir, `market-${seq}.sqlite`);
  const market = openAshareDb(marketPath);
  const dates = weekdays('20260701', 80).filter(d => d <= '20261020');
  seedMarket(market, dates);
  for (const [d, o] of [['20261020', 1], ['20261021', 1], ['20261024', 0], ['20261025', 0]]) market.prepare('INSERT OR REPLACE INTO trade_cal(cal_date,is_open) VALUES(?,?)').run(d, o);
  for (const position of DEMO_SNAPSHOT.positions) {
    upsertRows(market, 'fund_basic', ['ts_code', 'name', 'market', 'status', 'fund_type', 'invest_type'],
      [{ ts_code: position.ts_code, name: 'Synthetic ETF', market: 'E', status: 'L', fund_type: '股票型', invest_type: '被动指数型' }]);
    for (const date of dates) {
      const code = position.ts_code;
      upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
        [{ ts_code: code, trade_date: date, open: 1, high: 1, low: 1, close: 1, pre_close: 1, pct_chg: 0, vol: 1000, amount: 10000 }]);
      upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: code, trade_date: date, adj_factor: 1 }]);
      upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], [{ ts_code: code, trade_date: date, fd_share: 100000 }]);
    }
  }
  const portfolioPath = join(dir, `portfolio-${seq}.sqlite`);
  const p = openPortfolioDb(portfolioPath, { marketPath: join(dir, `unrelated-${seq}.sqlite`) });
  const id = `synthetic-baseline-${seq}`;
  importSnapshot(p, { ...DEMO_SNAPSHOT, snapshot_id: id, as_of: '2026-10-16', source: 'synthetic-test' });
  initBaseline(p, ACCOUNT, { asOf: '20261016', snapshotId: id });
  markSnapshotCurrent(p, id, { confirmedBy: 'fixture' });
  if (confirmed) confirmRealAccount(p, ACCOUNT, { confirm: true });
  const reportPath = join(dir, `report-${seq}.json`);
  const writeReport = watchlistCount => writeFileSync(reportPath, JSON.stringify({ report_id: `synthetic-market-report-${seq}`, as_of_trade_date: AS_OF, status: 'READY', versions: { score: 'frozen-test' },
    market: { regime: 'range', regime_label: 'synthetic', breadth: {}, indices: [], judgement: [] }, sectors: { top: [], bottom: [], all: [] },
    watchlist: { count: watchlistCount, members: [], added: [], removed: [], track_record: { mean_excess_pct: -1.68, hit_rate: 0.217 } }, signals: { market_summary: [] } }));
  writeReport(40);
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run(`synthetic-market-report-${seq}`, AS_OF, 'READY', '2026-10-20T13:10:00Z', reportPath, 'live');
  return { market, p, marketPath, portfolioPath, writeReport };
}

function build(f, extra = {}) {
  return buildInvestmentResearchBundle({ portfolioDb: f.p, marketDb: f.market, now: new Date('2026-10-21T01:00:00Z'), asOfTradeDate: AS_OF, ...extra });
}

function persist(f) {
  const out = [];
  const args = { db: f.portfolioPath, 'market-db': f.marketPath, date: AS_OF, 'output-dir': mkdtempSync(join(dir, 'vps-out-')) };
  runBundleRecordCommand({ arg: key => args[key], flag: () => false, ymd: () => undefined, print: value => out.push(value) });
  assert.equal(out.length, 1);
  return out[0];
}

const isV2State = v => ['FOCUS', 'WATCH', 'EXTENDED', 'DETERIORATING', 'BLOCKED', 'INVALIDATED'].includes(v);
function fullError() { const e = new Error('database or disk is full'); e.code = 'SQLITE_FULL'; e.errcode = 28; e.errno = 28; return e; }
const badDb = { prepare() { throw fullError(); } };

test('A08: identity consistent across modules (as-of, snapshot identity, hash)', () => {
  const f = fixture({ confirmed: true });
  try {
    const saved = persist(f);
    const bundle = build(f, { accountId: ACCOUNT });
    // live bundle identity == persisted identity
    assert.equal(bundle.report_id, saved.bundle_id);
    assert.equal(bundle.as_of_trade_date, AS_OF);
    assert.equal(saved.as_of_trade_date, AS_OF);
    const snapId = bundle.data_lineage?.ledger_cutoff?.snapshot_id;
    assert.ok(snapId, 'bundle pins account snapshot id via data_lineage');
    const record = readResearchJournal(f.p, saved.record_id);
    assert.equal(record.bundle_id, saved.bundle_id);
    assert.equal(record.as_of_trade_date, AS_OF);
    // persisted payload is the bundle: its pinned snapshot id matches the live bundle's
    assert.equal(record.payload.data_lineage.ledger_cutoff.snapshot_id, snapId);
    assert.equal(record.payload.report_id, bundle.report_id);
    // persisted_snapshot status is PERSISTED with a real hash
    assert.equal(bundle.persisted_snapshot.status, 'PERSISTED');
    assert.match(bundle.persisted_snapshot.content_hash, /^[0-9a-f]{64}$/);
    // research_tracking is outside identity: two builds with different journal history
    // (here: same state) share report_id; the field exists in the return but not in facts.
    const again = build(f);
    assert.equal(again.report_id, bundle.report_id);
    assert.ok('research_tracking' in bundle);
    assert.ok('research_stance' in bundle);
    assert.ok('execution_eligibility' in bundle);
    // persistedSnapshotStatus READ_ERROR on DB fault (P0-3 tie-in)
    const bad = persistedSnapshotStatus(badDb, ACCOUNT, AS_OF, bundle.report_id);
    assert.equal(bad.status, 'READ_ERROR');
    assert.equal(bad.error_code, 'SQLITE_FULL');
  } finally { f.market.close(); f.p.close(); }
});

test('A09: unreconciled (unconfirmed) account: reference conclusions only, can_quote_quantity false', () => {
  const f = fixture({ confirmed: false });
  try {
    const bundle = build(f, { accountId: ACCOUNT });
    assert.equal(bundle.account_status, 'REAL_ACCOUNT_PENDING');
    assert.equal(bundle.execution_eligibility.can_quote_quantity, false);
    assert.ok(bundle.execution_eligibility.blocked_by.length > 0, 'unverified account must name blockers');
    // all decision options are non-executable (research comparison, never order quantities)
    const opts = bundle.portfolio?.decision_comparison?.options ?? bundle.portfolio?.options ?? [];
    for (const o of opts) assert.equal(o.executable, false, `option ${o.action} must not be executable`);
    // research conclusion is still produced and labelled as stand-alone judgement
    assert.ok(['HOLD_OBSERVE', 'INSUFFICIENT_EVIDENCE', 'RELATIVE_ADVANTAGE'].includes(bundle.research_stance));
    // derivation is reproducible from the bundle's own fields
    const recomputed = bundle.portfolio?.decision_tracks?.risk_track?.gates_satisfied === true
      && bundle.account_verification?.summary_status === 'VERIFIED';
    assert.equal(bundle.execution_eligibility.can_quote_quantity, recomputed);
  } finally { f.market.close(); f.p.close(); }
});

test('A12: V2-only — no V1 fields, no score stacking, no research_state on ETF holdings', () => {
  const f = fixture({ confirmed: true });
  try {
    const bundle = build(f, { accountId: ACCOUNT });
    const json = JSON.stringify(bundle);
    for (const v1 of ['entry_score', 'v1_pool', '"priority"', 'top10']) {
      assert.ok(!json.includes(v1), `V1 field present: ${v1}`);
    }
    const etfCodes = new Set(DEMO_SNAPSHOT.positions.map(p => p.ts_code));
    const hs = bundle.hotspot_research ?? {};
    if (hs.research_state_counts != null) {
      const six = new Set(['FOCUS', 'WATCH', 'EXTENDED', 'DETERIORATING', 'BLOCKED', 'INVALIDATED']);
      for (const k of Object.keys(hs.research_state_counts)) assert.ok(six.has(k), `unknown state ${k}`);
    }
    for (const row of [...(hs.daily_highlights ?? []), ...(hs.watch ?? []), ...(hs.deteriorating ?? [])]) {
      assert.ok(!etfCodes.has(row.ts_code), `ETF ${row.ts_code} carries stock research_state`);
      assert.ok(isV2State(row.research_state), `non-V2 state on ${row.ts_code}`);
    }
    // ETF candidates carry no research_state either
    for (const c of bundle.etf_candidates?.candidates ?? []) assert.ok(!('research_state' in c), 'ETF candidate must not carry research_state');
  } finally { f.market.close(); f.p.close(); }
});

test('A19: claims traceable to bundle facts; counter-evidence / gaps present', () => {
  const f = fixture({ confirmed: true });
  try {
    const bundle = build(f, { accountId: ACCOUNT });
    // markdown summary references the bundle's own identity fields (no free-floating numbers)
    assert.ok(bundle.markdown_summary.includes(bundle.report_id), 'summary must cite report_id');
    assert.ok(bundle.markdown_summary.includes(bundle.status) || (bundle.status === 'DEGRADED' && bundle.markdown_summary.includes('DEGRADED')), 'summary must cite status');
    // every gap is a structured, checkable claim (module + reason)
    assert.ok(Array.isArray(bundle.evidence_gaps));
    for (const g of bundle.evidence_gaps) {
      assert.ok(g.module && g.reason, `gap missing module/reason: ${JSON.stringify(g)}`);
    }
    // counter-evidence must be visible somewhere: gaps or deteriorating stocks or account narrative risk
    const hasCounter = bundle.evidence_gaps.length > 0
      || (bundle.hotspot_research?.deteriorating?.length ?? 0) > 0
      || /风险|回撤|UNCONFIRMED/.test(bundle.account_narrative ?? '');
    assert.ok(hasCounter, 'bundle must surface counter-evidence or gaps, not only positives');
    // stance derivation reproducible: INSUFFICIENT_EVIDENCE iff core not ready or gaps >= 2
    assert.ok(bundle.research_stance, 'stance present');
    if (bundle.research_stance === 'INSUFFICIENT_EVIDENCE') {
      assert.ok(bundle.status === 'DATA_INSUFFICIENT' || bundle.evidence_gaps.length >= 2, 'INSUFFICIENT_EVIDENCE needs a real evidence-gap cause');
    }
    assert.ok(['HOLD_OBSERVE', 'INSUFFICIENT_EVIDENCE', 'RELATIVE_ADVANTAGE'].includes(bundle.research_stance));
    // no fabricated win-rate / target language in markdown
    assert.doesNotMatch(bundle.markdown_summary, /胜率|目标收益|必然/);
  } finally { f.market.close(); f.p.close(); }
});
