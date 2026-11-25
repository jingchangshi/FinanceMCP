import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-test-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'test.sqlite');
process.env.ASHARE_FETCH_MAX_RETRIES = '0';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { fundamentalsAsOf } = await import('../build/ashare/fundamentals.js');
const { updateWatchlist, WATCHLIST_RULES } = await import('../build/ashare/watchlist.js');
const { generateReport } = await import('../build/ashare/report.js');
const { checkQuality } = await import('../build/ashare/ingest.js');
const { fetchAll } = await import('../build/ashare/fetch.js');

function freshDb() {
  return openAshareDb(':memory:');
}

function seedCalendar(db, dates) {
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], dates.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: dates[i - 1] ?? null })));
}

test('financial indicators respect announcement dates (no look-ahead)', () => {
  const db = freshDb();
  const cols = ['ts_code', 'end_date', 'ann_date', 'roe'];
  upsertRows(db, 'fina_indicator', cols, [
    { ts_code: '600000.SH', end_date: '20260331', ann_date: '20260428', roe: 2.1 },
    { ts_code: '600000.SH', end_date: '20260630', ann_date: '20260829', roe: 4.5 },
    // A restatement of Q1 announced later must not be visible before its announcement.
    { ts_code: '600000.SH', end_date: '20260331', ann_date: '20260901', roe: 1.0 },
  ]);
  assert.equal(fundamentalsAsOf(db, '20260827').get('600000.SH').roe, 2.1);
  assert.equal(fundamentalsAsOf(db, '20260829').get('600000.SH').roe, 4.5);
  assert.equal(fundamentalsAsOf(db, '20260427').get('600000.SH'), undefined);
});

function scanRow(code, rank, industry, eligible = true) {
  return {
    ts_code: code, name: `S${code}`, industry, close: 10, pct_chg: 0, amount20_yi: 5, circ_mv_yi: 100,
    pe_ttm: 10, pb: 1, turnover_rate: 1, state: {}, signals: [], risk_flags: [],
    eligible, ineligible_reason: eligible ? undefined : 'ST/退市风险', score: 100 - rank / 10, rank,
  };
}

test('watchlist builds 30~50 names, caps industries and resists small rank moves', () => {
  const db = freshDb();
  const dates = ['20260105', '20260106', '20260107', '20260108', '20260109', '20260112', '20260113', '20260114'];
  seedCalendar(db, dates);
  const industries = Array.from({ length: 20 }, (_, i) => `IND${i}`);
  const rows = Array.from({ length: 300 }, (_, i) => scanRow(String(100000 + i), i + 1, industries[i % 20]));

  const first = updateWatchlist(db, { trade_date: dates[0], rows });
  assert.equal(first.members.length, WATCHLIST_RULES.target);
  for (const count of Object.values(first.industry_distribution)) assert.ok(count <= WATCHLIST_RULES.industry_cap);

  // Small reshuffle: members drift to ranks 41~120 — nobody should be replaced.
  const shuffled = rows.map(r => ({ ...r, rank: r.rank <= 40 ? r.rank + 80 : r.rank - 40 }));
  const second = updateWatchlist(db, { trade_date: dates[1], rows: shuffled });
  assert.equal(second.changes.filter(c => c.action === 'remove').length, 0);
  assert.equal(second.members.length, WATCHLIST_RULES.target);

  // A member that becomes ineligible is removed immediately, regardless of holding period.
  const victim = first.members[0].ts_code;
  const third = updateWatchlist(db, { trade_date: dates[2], rows: shuffled.map(r => r.ts_code === victim ? { ...r, eligible: false } : r) });
  assert.ok(third.changes.some(c => c.ts_code === victim && c.action === 'remove'));
  assert.ok(third.changes.filter(c => c.action === 'add').length <= WATCHLIST_RULES.max_adds_per_day);
  assert.ok(third.members.length >= WATCHLIST_RULES.min && third.members.length <= WATCHLIST_RULES.max);

  // Rank beyond the exit threshold removes a member only after the minimum holding period.
  const far = rows.map(r => ({ ...r, rank: r.rank <= 40 ? r.rank + 200 : r.rank - 40 }));
  const early = updateWatchlist(db, { trade_date: dates[3], rows: far });
  assert.equal(early.changes.filter(c => c.action === 'remove' && /排名降至/.test(c.reason)).length, 0);
  const late = updateWatchlist(db, { trade_date: dates[6], rows: far });
  assert.ok(late.changes.some(c => c.action === 'remove' && /排名降至/.test(c.reason)));
  // Every member fell out together: the list refills to the minimum at once, then grows by the daily add limit.
  assert.equal(late.members.length, WATCHLIST_RULES.min);
  const next = updateWatchlist(db, { trade_date: dates[7], rows: far });
  assert.equal(next.members.length, WATCHLIST_RULES.min + WATCHLIST_RULES.max_adds_per_day);
});

test('missing core data produces a NOT_READY report without watchlist or signals', () => {
  const db = openAshareDb();
  seedCalendar(db, ['20261015', '20261016']);
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pct_chg', 'vol', 'amount'],
    Array.from({ length: 100 }, (_, i) => ({ ts_code: `${600000 + i}.SH`, trade_date: '20261015', open: 1, high: 1, low: 1, close: 1, pct_chg: 0, vol: 1, amount: 1 })));
  const q = checkQuality(db, '20261016');
  assert.equal(q.status, 'NOT_READY');
  assert.ok(q.reasons.some(r => /日线缺失/.test(r)));
  const { meta, report } = generateReport(db, '20261016', 'live');
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.watchlist, undefined);
  assert.equal(report.signals, undefined);
  assert.match(report.not_ready.policy, /不使用前一交易日数据替代/);
  assert.match(meta.report_id, /^ASR-20261016-\d{14}-[0-9a-f]{6}$/);
  assert.ok(existsSync(meta.path));
  db.close();
});

test('batch fetch uses free router and slices offset/limit cleanly across cashflow retries', async () => {
  const originalFetch = globalThis.fetch;
  const prevHosts = process.env.ASHARE_TDX_HOSTS;
  process.env.ASHARE_TDX_HOSTS = '127.0.0.1:1';
  const calls = [];
  let failCashflowOnce = true;
  globalThis.fetch = async url => {
    const u = String(url);
    calls.push(u);
    if (u.includes('RPT_LICO_FN_CPD')) {
      return new Response(JSON.stringify({
        result: {
          pages: 1,
          data: [0, 1, 2, 3, 4].map(i => ({
            SECUCODE: `60000${i}.SH`, NOTICE_DATE: '2026-10-24', REPORTDATE: '2026-09-30',
            BASIC_EPS: 1, WEIGHTAVG_ROE: 10, YSTZ: 5, SJLTZ: 5, XSMLL: 20, MGJYXJJE: 1, PARENT_NETPROFIT: 100,
          })),
        },
      }), { status: 200 });
    }
    if (u.includes('RPT_DMSK_FN_BALANCE')) {
      return new Response(JSON.stringify({ result: { pages: 1, data: [] } }), { status: 200 });
    }
    if (u.includes('RPT_DMSK_FN_CASHFLOW')) {
      if (failCashflowOnce) {
        failCashflowOnce = false;
        throw new Error('socket hang up');
      }
      return new Response(JSON.stringify({ result: { pages: 1, data: [] } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };
  try {
    const { clearFreeProviderCache } = await import('../build/ashare/providers/freeProviderRouter.js');
    clearFreeProviderCache();
    const rows = await fetchAll('fina_indicator_vip', { period: '20260930', offset: 1, limit: 3 }, 'ts_code,ann_date,end_date');
    assert.deepEqual(rows.map(r => r.ts_code), ['600001.SH', '600002.SH', '600003.SH']);
    assert.ok(calls.filter(u => u.includes('RPT_DMSK_FN_CASHFLOW')).length >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevHosts === undefined) delete process.env.ASHARE_TDX_HOSTS;
    else process.env.ASHARE_TDX_HOSTS = prevHosts;
  }
});
