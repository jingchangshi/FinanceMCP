import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-refresh-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_FETCH_MAX_RETRIES = '0';
process.env.ASHARE_TDX_HOSTS = '127.0.0.1:1';

const { openAshareDb, upsertRows, closeAshareDb } = await import('../build/ashare/db.js');
const { syncTradeDate, checkQuality, syncTradeCal, syncStockBasic, syncFinaIndicator } = await import('../build/ashare/ingest.js');
const { syncRange } = await import('../build/ashare/sync.js');
const { generateReport, latestReportMeta } = await import('../build/ashare/report.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { clearFreeProviderCache } = await import('../build/ashare/providers/freeProviderRouter.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');

const TABLES = ['daily', 'daily_basic', 'adj_factor', 'stk_limit'];
const originalFetch = globalThis.fetch;

function toTencentLine(r) {
  const [code, suffix] = r.ts_code.split('.');
  const sym = `${suffix.toLowerCase()}${code}`;
  const f = new Array(55).fill('0');
  f[1] = r.name ?? `股${code}`;
  f[2] = code;
  f[3] = String(r.close);
  f[4] = String(r.pre_close ?? r.close);
  f[5] = String(r.open ?? r.close);
  f[6] = String(r.vol ?? 100);
  f[30] = `${r.trade_date}150000`;
  f[31] = '0';
  f[32] = String(r.pct_chg ?? 0);
  f[33] = String(r.high ?? r.close);
  f[34] = String(r.low ?? r.close);
  const amtYuan = (r.amount ?? 100) * 1000;
  f[35] = `${r.close}/${r.vol ?? 100}/${amtYuan}`;
  f[37] = String((amtYuan / 10000).toFixed(2));
  f[38] = String(r.turnover_rate ?? 1);
  f[39] = '10';
  f[44] = '100';
  f[45] = '100';
  f[46] = '1.5';
  f[47] = String(r.up_limit ?? 11);
  f[48] = String(r.down_limit ?? 9);
  f[49] = '1.0';
  return `v_${sym}="${f.join('~')}";`;
}

/**
 * 免费数据源 HTTP mock：
 * - `rowsByReq` 可以是数组、`() => rows | 'error'`，或 `{ rows, fina? }`；
 * - 清空 `freeProviderRouter` 内存缓存以保证每次刷新都真实命中 mock。
 */
function mockFreeHttp(handler) {
  clearFreeProviderCache();
  globalThis.fetch = async url => {
    const u = String(url);
    const out = typeof handler === 'function' ? handler(u) : handler;
    if (out === 'error') return new Response('upstream unavailable', { status: 500 });
    if (Array.isArray(out)) {
      const rows = out;
      if (u.startsWith('https://push2.eastmoney.com/api/qt/clist/get')) {
        const pn = Number(new URL(u).searchParams.get('pn') || '1');
        const slice = rows.slice((pn - 1) * 100, pn * 100).map(r => {
          const [code, suffix] = r.ts_code.split('.');
          const tsSec = Math.floor(Date.parse(`${r.trade_date.slice(0, 4)}-${r.trade_date.slice(4, 6)}-${r.trade_date.slice(6, 8)}T15:00:00+08:00`) / 1000);
          return {
            f2: r.close, f3: r.pct_chg ?? 0, f4: 0, f5: r.vol ?? 100, f6: (r.amount ?? 100) * 1000,
            f8: r.turnover_rate ?? 1, f10: 1, f12: code, f13: suffix === 'SH' ? 1 : 0, f14: r.name ?? `股${code}`,
            f15: r.high ?? r.close, f16: r.low ?? r.close, f17: r.open ?? r.close, f18: r.pre_close ?? r.close,
            f20: 1e10, f21: 1e10, f23: 1.5, f26: 20200101, f100: '行业', f115: 10, f124: tsSec, f130: 1,
          };
        });
        return new Response(JSON.stringify({ data: { total: rows.length, diff: slice } }), { status: 200 });
      }
      if (u.startsWith('https://qt.gtimg.cn/q=')) {
        const syms = new Set(u.slice('https://qt.gtimg.cn/q='.length).split(','));
        const body = rows.filter(r => {
          const [code, suffix] = r.ts_code.split('.');
          return syms.has(`${suffix.toLowerCase()}${code}`);
        }).map(toTencentLine).join('\n');
        return new Response(body, { status: 200 });
      }
      if (u.startsWith('https://push2his.eastmoney.com/api/qt/stock/kline/get')) {
        return new Response(JSON.stringify({ data: { klines: [] } }), { status: 200 });
      }
      if (u.startsWith('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get')) {
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------- sync level, real-size counts

const P = '20261015';
const D = '20261016';
const quotes = (date, n, offset = 0, close = () => 10) => Array.from({ length: n }, (_, idx) => {
  const i = idx + offset;
  const ts_code = i < 2000
    ? `${600000 + i}.SH`
    : i < 4000
      ? `${String(i - 2000).padStart(6, '0')}.SZ`
      : `${300000 + (i - 4000)}.SZ`;
  return {
    ts_code, trade_date: date, open: 10, high: 10, low: 10, close: close(idx), pre_close: 10,
    pct_chg: 0, vol: 100, amount: 100, adj_factor: 1, up_limit: 11, down_limit: 9, turnover_rate: 1,
  };
});

function freshSyncDb() {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: P, is_open: 1 }, { cal_date: D, is_open: 1, pretrade_date: P }]);
  for (const t of TABLES) upsertRows(db, t, ['ts_code', 'trade_date'], quotes(P, 5500));
  return db;
}

async function refresh(db, rows) {
  mockFreeHttp(() => rows);
  return syncTradeDate(db, D, 'refresh');
}

const log = (db, t = 'daily') => db.prepare('SELECT * FROM sync_log WHERE dataset = ? AND key = ?').get(t, D);
const count = (db, t = 'daily') => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE trade_date = ?`).get(D).n;

test('A: 5500 then 3000 keeps the complete snapshot and records the refresh as incomplete', async () => {
  const db = freshSyncDb();
  try {
    const first = await refresh(db, quotes(D, 5500));
    assert.equal(first.daily.refresh_status, 'REFRESH_OK');
    // The short answer also carries a revised close for stock 0: it must not be mixed into the kept snapshot.
    const second = await refresh(db, quotes(D, 3000, 0, i => (i === 0 ? 99 : 10)));
    assert.equal(count(db), 5500, 'no data lost');
    assert.equal(db.prepare("SELECT close FROM daily WHERE ts_code = '000000.SZ' AND trade_date = ?").get(D).close, 10, 'no partial update mixed in');
    assert.equal(second.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.equal(second.daily.write, 'kept');
    assert.deepEqual([second.daily.fetched_rows, second.daily.before_rows, second.daily.rows], [3000, 5500, 5500]);
    const l = log(db);
    assert.equal(l.refresh_status, 'REFRESH_INCOMPLETE', 'not recorded as a successful refresh');
    assert.equal(l.status, 'ok', 'cache state is still complete');
    assert.deepEqual([l.rows, l.before_rows, l.after_rows, l.write_mode], [3000, 5500, 5500, 'kept']);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('B: 3000 then 5500 completes the cache', async () => {
  const db = freshSyncDb();
  try {
    const first = await refresh(db, quotes(D, 3000));
    assert.equal(first.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.equal(first.daily.write, 'merged', 'an incomplete cache still takes the valid rows');
    assert.equal(log(db).status, 'partial');
    const second = await refresh(db, quotes(D, 5500));
    assert.equal(second.daily.refresh_status, 'REFRESH_OK');
    assert.equal(second.daily.write, 'replaced');
    assert.equal(count(db), 5500);
    assert.equal(log(db).status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('C: 5500 then 5490 with withdrawn rows is an atomic replace', async () => {
  const db = freshSyncDb();
  try {
    await refresh(db, quotes(D, 5500));
    const second = await refresh(db, quotes(D, 5490)); // stocks 5490..5499 withdrawn upstream
    assert.equal(second.daily.refresh_status, 'REFRESH_OK');
    assert.equal(second.daily.write, 'replaced');
    assert.equal(count(db), 5490);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM daily WHERE trade_date = ? AND ts_code >= '301490.SZ' AND ts_code <= '301499.SZ'").get(D).n, 0, 'withdrawn rows gone');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('D: an upstream error keeps the complete cache and marks refresh incomplete/failed', async () => {
  const db = freshSyncDb();
  try {
    await refresh(db, quotes(D, 5500));
    mockFreeHttp('error');
    const result = await syncTradeDate(db, D, 'refresh');
    assert.equal(result.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.equal(result.daily.write, 'kept');
    assert.equal(count(db), 5500);
    const l = log(db);
    assert.equal(l.refresh_status, 'REFRESH_INCOMPLETE');
    const history = db.prepare("SELECT refresh_status FROM sync_history WHERE dataset = 'daily' AND key = ? ORDER BY synced_at, rowid").all(D).map(r => r.refresh_status);
    assert.deepEqual(history, ['REFRESH_OK', 'REFRESH_INCOMPLETE']);
  } finally {
    clearFreeProviderCache();
    globalThis.fetch = originalFetch;
    db.close();
  }
});

// ---------------------------------------------------------------- report level on the synthetic market

test('A/D/E: the report and MCP status show a bad refresh as DEGRADED, and recover after a good one', async () => {
  const live = openAshareDb();
  const dates = weekdays('20260105', 150);
  const day = dates.at(-1);
  seedMarket(live, dates);
  const goodDaily = live.prepare('SELECT * FROM daily WHERE trade_date = ?').all(day);
  const counts = () => TABLES.map(t => live.prepare(`SELECT COUNT(*) n FROM ${t} WHERE trade_date = ?`).get(day).n);
  const watchlistRows = () => live.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(day).n;
  const status = async () => {
    closeAshareDb();
    return (await runAshareTool('ashare_data_status', { date: day })).content[0].text;
  };
  try {
    mockFreeHttp(() => goodDaily);
    await syncTradeDate(live, day, 'refresh');
    const r1 = generateReport(live, day, 'live').report;
    assert.equal(r1.status, 'READY');
    const baseline = counts();

    // A: the 21:10 refresh returns only 55% of the market (short snapshot).
    mockFreeHttp(u => {
      if (u.startsWith('https://qt.gtimg.cn/q=')) {
        const subset = goodDaily.slice(0, 33);
        const syms = new Set(u.slice('https://qt.gtimg.cn/q='.length).split(','));
        return new Response(subset.filter(r => {
          const [code, suffix] = r.ts_code.split('.');
          return syms.has(`${suffix.toLowerCase()}${code}`);
        }).map(toTencentLine).join('\n'), { status: 200 });
      }
      if (u.startsWith('https://push2.eastmoney.com/api/qt/clist/get')) {
        return new Response(JSON.stringify({ data: { total: 0, diff: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { klines: [] } }), { status: 200 });
    });
    await syncTradeDate(live, day, 'refresh');
    assert.deepEqual(counts(), baseline);
    const q = checkQuality(live, day, false);
    assert.equal(q.cache_status, 'READY');
    assert.equal(q.status, 'DEGRADED', 'never an unqualified READY after a short refresh');
    assert.ok(q.reasons.some(r => /最新一次刷新 daily 不完整（返回 33 条，沿用上一次有效快照 60 条/.test(r)), q.reasons.join('|'));
    const r2 = generateReport(live, day, 'live').report;
    assert.equal(r2.status, 'DEGRADED');
    assert.equal(r2.data.quality.refresh.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.ok(r2.risks.some(r => /数据降级：最新一次刷新 daily 不完整/.test(r)));
    assert.match(await status(), /DEGRADED[\s\S]*最新一次刷新 daily 不完整/);
    closeAshareDb();
    const md = (await runAshareTool('ashare_daily_report', { date: day })).content[0].text;
    assert.match(md, /（DEGRADED）[\s\S]*最新一次刷新 daily 不完整/);

    // D: upstream outage yields empty refresh (kept complete cache, marked DEGRADED).
    mockFreeHttp('error');
    await syncTradeDate(live, day, 'refresh');
    assert.deepEqual(counts(), baseline);
    const r3 = generateReport(live, day, 'live').report;
    assert.equal(r3.status, 'DEGRADED');
    assert.ok(r3.data.quality.reasons.some(r => /daily 不完整/.test(r)));

    // E: a good refresh clears the anomaly; the same-day watchlist is rebuilt, not duplicated.
    mockFreeHttp(() => goodDaily);
    await syncTradeDate(live, day, 'refresh');
    const r4 = generateReport(live, day, 'live');
    assert.equal(r4.report.status, 'READY');
    assert.deepEqual(r4.report.data.quality.reasons, []);
    assert.deepEqual(counts(), baseline);
    assert.equal(watchlistRows(), r1.watchlist.count);
    assert.equal(r4.report.watchlist.count, r1.watchlist.count);
    assert.equal(latestReportMeta(live, day).report_id, r4.meta.report_id);
    assert.match(await status(), /数据质量：\*\*READY\*\*/);
  } finally {
    clearFreeProviderCache();
    globalThis.fetch = originalFetch;
    closeAshareDb();
    live.close();
  }
});

test('B (report level): an incomplete first run is NOT_READY, the completed second run READY', async () => {
  const db = openAshareDb(':memory:');
  const dates = weekdays('20260105', 150);
  const day = dates.at(-1);
  seedMarket(db, dates);
  const goodDaily = db.prepare('SELECT * FROM daily WHERE trade_date = ?').all(day);
  for (const t of TABLES) db.prepare(`DELETE FROM ${t} WHERE trade_date = ?`).run(day);
  try {
    mockFreeHttp(u => {
      if (u.startsWith('https://qt.gtimg.cn/q=')) {
        const subset = goodDaily.slice(0, 33);
        const syms = new Set(u.slice('https://qt.gtimg.cn/q='.length).split(','));
        return new Response(subset.filter(r => {
          const [code, suffix] = r.ts_code.split('.');
          return syms.has(`${suffix.toLowerCase()}${code}`);
        }).map(toTencentLine).join('\n'), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { total: 0, diff: [], klines: [] } }), { status: 200 });
    });
    await syncTradeDate(db, day, 'refresh');
    const q = checkQuality(db, day, false);
    assert.equal(q.status, 'NOT_READY');
    assert.equal(q.cache_status, 'NOT_READY');
    mockFreeHttp(() => goodDaily);
    await syncTradeDate(db, day, 'refresh');
    assert.equal(checkQuality(db, day, false).status, 'READY');
  } finally {
    clearFreeProviderCache();
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('fault tolerance: free trade_cal / stock_basic degrade gracefully without crashing on upstream error', async () => {
  const empty = openAshareDb(':memory:');
  const seeded = freshSyncDb();
  upsertRows(seeded, 'stock_basic', ['ts_code', 'name'], [{ ts_code: '000001.SZ', name: '平安银行' }]);
  try {
    mockFreeHttp('error');
    const calRows = await syncTradeCal(empty, P, D);
    assert.ok(calRows >= 0);
    assert.equal(await syncStockBasic(empty), 0);
    assert.ok((await syncTradeCal(seeded, P, D)) >= 0);
    assert.equal(await syncStockBasic(seeded), 1);
  } finally {
    clearFreeProviderCache();
    globalThis.fetch = originalFetch;
    empty.close();
    seeded.close();
  }
});

test('fault tolerance: syncFinaIndicator isolates per-period failures and syncRange skips fina_indicator_vip when daily has 0 rows', async () => {
  const db = freshSyncDb();
  upsertRows(db, 'stock_basic', ['ts_code', 'name'], [{ ts_code: '000001.SZ', name: '平安银行' }]);
  try {
    mockFreeHttp(u => {
      if (u.includes('RPT_LICO_FN_CPD') && u.includes('2026-06-30')) {
        return new Response('err', { status: 500 });
      }
      if (u.includes('RPT_LICO_FN_CPD') && u.includes('2026-09-30')) {
        return new Response(JSON.stringify({
          result: {
            pages: 1,
            data: [{
              SECUCODE: '000001.SZ', NOTICE_DATE: '2026-10-15', REPORTDATE: '2026-09-30',
              BASIC_EPS: 1.0, WEIGHTAVG_ROE: 12.3, YSTZ: 5, SJLTZ: 4, XSMLL: 20, MGJYXJJE: 1.2, PARENT_NETPROFIT: 100,
            }],
          },
        }), { status: 200 });
      }
      if (u.includes('RPT_DMSK_FN_BALANCE') || u.includes('RPT_DMSK_FN_CASHFLOW')) {
        return new Response(JSON.stringify({ result: { pages: 1, data: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { total: 0, diff: [], klines: [] } }), { status: 200 });
    });
    const finaRes = await syncFinaIndicator(db, D, 2, 2);
    assert.equal(finaRes['20260930'], 1);
    assert.equal(finaRes['20260630'], 0);

    const calledUrls = [];
    mockFreeHttp(u => {
      calledUrls.push(u);
      return 'error';
    });
    const summary = await syncRange(db, D, D, { refreshFrom: D, skipCalendar: true });
    assert.equal(calledUrls.some(u => u.includes('datacenter-web.eastmoney.com')), false);
    assert.deepEqual(summary.fina, {});
  } finally {
    clearFreeProviderCache();
    globalThis.fetch = originalFetch;
    db.close();
  }
});
