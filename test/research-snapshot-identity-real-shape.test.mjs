import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

// Real-shape fixture for the 2026-10-23 production case: account "real-main", trade date 20261023, the scheduled
// snapshot persisted with no account argument, then a live read with account_id="real-main" and an append on
// 2026-10-24. Same account id, trade date and write path as production; only the market and portfolio rows are synthetic.
const dir = mkdtempSync(join(tmpdir(), 'snapshot-identity-real-shape-'));
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
const { readResearchJournal } = await import('../build/portfolio/researchJournal.js');

const ACCOUNT = 'real-main';
const AS_OF = '20261023';
const NOW = Date.parse('2026-10-24T10:00:00+08:00');
let seq = 0;

function fixture() {
  seq += 1;
  const marketPath = join(dir, `market-${seq}.sqlite`);
  const market = openAshareDb(marketPath);
  const dates = weekdays('20260701', 90).filter(d => d <= AS_OF);
  assert.ok(dates.includes(AS_OF), 'fixture market must contain the 20261023 trade date');
  seedMarket(market, dates);
  for (const [d, o] of [[AS_OF, 1], ['20261024', 0], ['20261025', 0], ['20261026', 1]]) market.prepare('INSERT OR REPLACE INTO trade_cal(cal_date,is_open) VALUES(?,?)').run(d, o);
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
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run(`synthetic-market-report-${seq}`, AS_OF, 'READY', '2026-10-23T10:10:00Z', reportPath, 'live');
  return { market, p, marketPath, portfolioPath };
}

function build(f, extra = {}) {
  return buildInvestmentResearchBundle({ portfolioDb: f.p, marketDb: f.market, now: new Date('2026-10-24T01:00:00Z'), asOfTradeDate: AS_OF, ...extra });
}

// The scheduled job persists with no account argument, so the account is resolved by default.
function persist(f) {
  const out = [];
  const args = { db: f.portfolioPath, 'market-db': f.marketPath, date: AS_OF, 'output-dir': mkdtempSync(join(dir, 'vps-out-')) };
  runBundleRecordCommand({ arg: key => args[key], flag: () => false, ymd: () => undefined, print: value => out.push(value) });
  assert.equal(out.length, 1);
  return out[0];
}

const judgement = (reportId, extra = {}) => ({
  report_id: reportId, as_of_trade_date: AS_OF, independent_judgement: '独立判断：维持观察。', final_conclusion: '维持观察，不构成交易建议。',
  additional_evidence: [{ claim: '央行公开市场操作净投放', kind: 'macro', source_url: 'https://example.com/a', published_at: '2026-10-22' }],
  counter_evidence: [], ...extra,
});

test('the live explicit read and the scheduled default read report the same 20261023 identity', () => {
  const f = fixture();
  try {
    const saved = persist(f);
    const explicit = build(f, { accountId: ACCOUNT });
    const omitted = build(f);
    assert.equal(explicit.portfolio.account_id_source, 'explicit');
    assert.equal(omitted.portfolio.account_id_source, 'default');
    assert.equal(explicit.report_id, omitted.report_id);
    assert.equal(explicit.report_id, saved.bundle_id);
    assert.equal(explicit.persisted_snapshot.status, 'PERSISTED');
    assert.deepEqual(explicit.persisted_snapshot.record_ids, [saved.record_id]);
  } finally { f.market.close(); f.p.close(); }
});

test('append on 2026-10-24 for the persisted 20261023 snapshot links, classifies as retrospective, and replays', () => {
  const f = fixture();
  try {
    const saved = persist(f);
    const live = build(f, { accountId: ACCOUNT });
    const first = appendChatgptResearchRecord(f.p, ACCOUNT, judgement(live.report_id), NOW);
    assert.equal(first.created, true);
    // Judgement written the day after its trade date: recorded after as_of, so it is not forward evidence.
    assert.equal(first.evidence_class, 'RETROSPECTIVE_RECORD');
    const stored = readResearchJournal(f.p, first.record_id);
    assert.deepEqual(stored.parent_record_ids, [saved.record_id]);
    const replay = appendChatgptResearchRecord(f.p, ACCOUNT, judgement(live.report_id), NOW);
    assert.equal(replay.created, false);
    assert.equal(replay.record_id, first.record_id);
  } finally { f.market.close(); f.p.close(); }
});

test('a wrong report_id for the same account and date is refused before any write, and the count is unchanged', () => {
  const f = fixture();
  try {
    persist(f);
    const count = () => f.p.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt'").get().n;
    const before = count();
    assert.throws(() => appendChatgptResearchRecord(f.p, ACCOUNT, judgement('BUNDLE-20261023-00000000000000000000'), NOW), /bundle_identity_mismatch/);
    assert.equal(count(), before);
  } finally { f.market.close(); f.p.close(); }
});
