import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

// Regression for the 2026-10-23 production failure: a live read with account_id="real-main" reported
// BUNDLE-20261023-e7f99535..., while the scheduled VPS snapshot (read without account_id) was
// BUNDLE-20261023-89c7364f..., so append correctly refused with bundle_not_found. Root cause: the bundle
// identity hashed `portfolio.account_id_source` ("explicit" vs "default"), which describes how the caller
// named the account, not the account state. Same account, same data, different request shape → different ID.
const dir = mkdtempSync(join(tmpdir(), 'snapshot-identity-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market-default.sqlite');
const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { DEMO_SNAPSHOT, importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount } = await import('../build/portfolio/ledger.js');
const { buildInvestmentResearchBundle } = await import('../build/portfolio/researchBundle.js');
const { runBundleRecordCommand } = await import('../build/portfolio/bundleRecordCli.js');
const { appendChatgptResearchRecord } = await import('../build/portfolio/chatgptIntake.js');

const ACCOUNT = 'synthetic-account';
const AS_OF = '20261020';
const NOW = Date.parse('2026-10-24T10:00:00+08:00');
let seq = 0;

function fixture() {
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
  const privateDir = mkdtempSync(join(dir, 'account-'));
  const portfolioPath = join(privateDir, 'portfolio.sqlite');
  const p = openPortfolioDb(portfolioPath, { marketPath: join(dir, `unrelated-${seq}.sqlite`) });
  const id = `synthetic-baseline-${seq}`;
  importSnapshot(p, { ...DEMO_SNAPSHOT, snapshot_id: id, as_of: '2026-10-16', source: 'synthetic-test' });
  initBaseline(p, ACCOUNT, { asOf: '20261016', snapshotId: id });
  markSnapshotCurrent(p, id, { confirmedBy: 'fixture' });
  confirmRealAccount(p, ACCOUNT, { confirm: true });
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

// Persist exactly the way the scheduled job does: no account argument, so the account is resolved by default.
function persist(f) {
  const out = [];
  const args = { db: f.portfolioPath, 'market-db': f.marketPath, date: AS_OF, 'output-dir': mkdtempSync(join(dir, 'vps-out-')) };
  runBundleRecordCommand({ arg: key => args[key], flag: () => false, ymd: () => undefined, print: value => out.push(value) });
  assert.equal(out.length, 1);
  return out[0];
}

const evidence = [{ claim: '央行公开市场操作净投放', kind: 'macro', source_url: 'https://example.com/a', published_at: '2026-10-20' }];
const judgement = (reportId, extra = {}) => ({
  report_id: reportId, as_of_trade_date: AS_OF, independent_judgement: '独立判断：维持观察。', final_conclusion: '维持观察，不构成交易建议。',
  additional_evidence: evidence, counter_evidence: [], ...extra,
});

test('identity does not depend on how the account was named in the request', () => {
  const f = fixture();
  try {
    const explicit = build(f, { accountId: ACCOUNT });
    const omitted = build(f);
    assert.equal(explicit.portfolio.account_id_source, 'explicit');
    assert.equal(omitted.portfolio.account_id_source, 'default');
    assert.equal(explicit.report_id, omitted.report_id);
  } finally { f.market.close(); f.p.close(); }
});

test('identity is stable across read times for the same state', () => {
  const f = fixture();
  try {
    const early = build(f, { now: new Date('2026-10-21T01:00:00Z') });
    const late = build(f, { now: new Date('2026-10-23T09:30:00Z') });
    assert.equal(early.report_id, late.report_id);
    assert.notEqual(early.generated_at, late.generated_at);
  } finally { f.market.close(); f.p.close(); }
});

test('a bundle reports SNAPSHOT_NOT_FOUND and creates no journal table when nothing is persisted', () => {
  const f = fixture();
  try {
    const live = build(f, { accountId: ACCOUNT });
    assert.deepEqual(live.persisted_snapshot, { status: 'SNAPSHOT_NOT_FOUND', record_ids: [], content_hash: null, recorded_at: null });
    assert.equal(f.p.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='research_journal'").get().n, 0);
  } finally { f.market.close(); f.p.close(); }
});

test('the id a live explicit-account read reports is the id the scheduled snapshot was stored under', () => {
  const f = fixture();
  try {
    const saved = persist(f);
    assert.equal(saved.bundle_id, saved.record_id.replace(/^VPS-/, ''));
    const live = build(f, { accountId: ACCOUNT });
    assert.equal(live.report_id, saved.bundle_id);
    assert.equal(live.persisted_snapshot.status, 'PERSISTED');
    assert.deepEqual(live.persisted_snapshot.record_ids, [saved.record_id]);
    assert.match(live.persisted_snapshot.content_hash, /^[0-9a-f]{64}$/);
  } finally { f.market.close(); f.p.close(); }
});

test('changed upstream state gets a new identity and is not matched to the old snapshot', () => {
  const f = fixture();
  try {
    const saved = persist(f);
    f.writeReport(41);
    const changed = build(f, { accountId: ACCOUNT });
    assert.notEqual(changed.report_id, saved.bundle_id);
    assert.equal(changed.persisted_snapshot.status, 'SNAPSHOT_NOT_FOUND');
    assert.throws(() => appendChatgptResearchRecord(f.p, ACCOUNT, judgement(changed.report_id), NOW), /bundle_identity_mismatch/);
  } finally { f.market.close(); f.p.close(); }
});

test('append links to the persisted snapshot and names the precise reason when it cannot', () => {
  const f = fixture();
  try {
    const saved = persist(f);
    assert.throws(() => appendChatgptResearchRecord(f.p, ACCOUNT, judgement('BUNDLE-20261020-deadbeefdeadbeefdead'), NOW), /bundle_identity_mismatch/);
    assert.throws(() => appendChatgptResearchRecord(f.p, ACCOUNT, judgement(saved.bundle_id, { as_of_trade_date: '20261019' }), NOW), /trade_date_mismatch/);
    assert.throws(() => appendChatgptResearchRecord(f.p, 'other-account', judgement(saved.bundle_id), NOW), /account_mismatch/);
    assert.throws(() => appendChatgptResearchRecord(f.p, ACCOUNT, judgement('BUNDLE-20261019-deadbeefdeadbeefdead', { as_of_trade_date: '20261019' }), NOW), /bundle_not_found/);
    const ok = appendChatgptResearchRecord(f.p, ACCOUNT, judgement(saved.bundle_id), NOW);
    assert.equal(ok.created, true);
    // 20261020 is before the 20261022 freeze date, so the record is historical and never forward evidence.
    assert.equal(ok.evidence_class, 'PRE_FORWARD_HISTORICAL');
  } finally { f.market.close(); f.p.close(); }
});
