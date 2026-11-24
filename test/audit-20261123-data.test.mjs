// Audit 2026-11-23 workstream C: data-source findings P1-4, P1-5, P2-1, P2-3, P2-4, P2-5, P3-1.
// All upstream I/O is mocked: no live network, no production DB.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { checkDataReadiness } = await import('../build/ashare/dataReadiness.js');
const { scanMarket } = await import('../build/ashare/analysis.js');
const { evaluateMarketRegime } = await import('../build/ashare/marketRegime.js');
const { financialsAsOf } = await import('../build/ashare/data.js');
const { generateReport } = await import('../build/ashare/report.js');
const { isRateLimit } = await import('../build/ashare/fetch.js');
const { TdxSession } = await import('../build/ashare/providers/tdxClient.js');
const { fetchTencentDailyBars, parseTencentQuoteLine } = await import('../build/ashare/providers/tencentClient.js');
const { clearFreeProviderCache, fetchFreeDataset, isFinalAshareClose } = await import('../build/ashare/providers/freeProviderRouter.js');
const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const { weekdays, seedMarket } = await import('./ashare-fixture.mjs');

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------- fixtures / mocks

function encodeTdxVarint(val) {
  const neg = val < 0;
  let u = Math.abs(val);
  const bytes = [];
  let first = u & 0x3f;
  u >>>= 6;
  if (neg) first |= 0x40;
  if (u > 0) first |= 0x80;
  bytes.push(first);
  while (u > 0) {
    let b = u & 0x7f;
    u >>>= 7;
    if (u > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function tdxFrame(payload) {
  const z = deflateSync(payload);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(0x01, 0);
  hdr.writeUInt16LE(z.length, 12);
  hdr.writeUInt16LE(payload.length, 14);
  return Buffer.concat([hdr, z]);
}

// 2^19 in TDX's custom float: logpoint 73, mantissa bytes zero (2 * 73 - 127 = 19).
const TDX_VOL_2POW19 = 0x49000000;
const TDX_AMOUNT_2POW19 = 0x49000000;

function encodeBarsPayload(rows) {
  const head = Buffer.alloc(2);
  head.writeUInt16LE(rows.length, 0);
  const parts = [head];
  let prevBase = 0;
  for (const r of rows) {
    const dt = Buffer.alloc(4);
    dt.writeUInt32LE(Number(r.date), 0);
    const open = Math.round(r.open * 1000);
    const close = Math.round(r.close * 1000);
    const high = Math.round(r.high * 1000);
    const low = Math.round(r.low * 1000);
    const vol = Buffer.alloc(4);
    vol.writeUInt32LE(TDX_VOL_2POW19, 0);
    const amount = Buffer.alloc(4);
    amount.writeUInt32LE(TDX_AMOUNT_2POW19, 0);
    parts.push(
      dt,
      encodeTdxVarint(open - prevBase),
      encodeTdxVarint(close - open),
      encodeTdxVarint(high - open),
      encodeTdxVarint(low - open),
      vol,
      amount,
    );
    prevBase = close;
  }
  return Buffer.concat(parts);
}

function encodeXdxrPayload(events) {
  const buf = Buffer.alloc(11 + events.length * 29);
  buf.writeUInt16LE(events.length, 9);
  events.forEach((e, i) => {
    const base = 11 + i * 29;
    buf.writeUInt8(0, base);
    Buffer.from(e.code, 'ascii').copy(buf, base + 1);
    buf.writeUInt32LE(Number(e.date), base + 8);
    buf.writeUInt8(e.category ?? 1, base + 12);
    buf.writeFloatLE(e.fenhong ?? 0, base + 13);
    buf.writeFloatLE(e.peigujia ?? 0, base + 17);
    buf.writeFloatLE(e.songzhuangu ?? 0, base + 21);
    buf.writeFloatLE(e.peigu ?? 0, base + 25);
  });
  return buf;
}

/** Minimal TDX TCP server: answers HELLO, security count/list, bars and xdxr. */
function startTdxServer({ barsByCode = {}, xdxrByCode = {}, silentCommands = [] } = {}) {
  const srv = net.createServer(sock => {
    sock.on('data', chunk => {
      if (chunk.length === 13 && chunk[10] === 0x0d) {
        sock.write(tdxFrame(Buffer.from('ok')));
        return;
      }
      const cmd = chunk.readUInt16LE(10);
      if (silentCommands.includes(cmd)) return; // never answer -> client must time out
      if (cmd === 0x044e || cmd === 0x0450) {
        const out = Buffer.alloc(2);
        out.writeUInt16LE(0, 0);
        sock.write(tdxFrame(out));
        return;
      }
      if (cmd === 0x052d) {
        const code = chunk.subarray(14, 20).toString('ascii');
        sock.write(tdxFrame(encodeBarsPayload(barsByCode[code] ?? [])));
        return;
      }
      if (cmd === 0x000f) {
        const code = chunk.subarray(15, 21).toString('ascii');
        sock.write(tdxFrame(encodeXdxrPayload(xdxrByCode[code] ?? [])));
        return;
      }
      sock.write(tdxFrame(Buffer.alloc(4)));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function tencentQuoteLine({ symbol, code, name = '测试', date, open, close, high, low, pre, vol, amtYuan = null, circYi = 10 }) {
  const f = new Array(55).fill('0');
  f[1] = name;
  f[2] = code;
  f[3] = String(close);
  f[4] = String(pre);
  f[5] = String(open);
  f[6] = String(vol);
  f[30] = `${date}150000`;
  f[31] = String((close - pre).toFixed(3));
  f[32] = pre > 0 ? String((((close - pre) / pre) * 100).toFixed(2)) : '0';
  f[33] = String(high);
  f[34] = String(low);
  f[35] = amtYuan === null ? '' : `${close}/${vol}/${amtYuan}`;
  f[37] = amtYuan === null ? '' : String((amtYuan / 10000).toFixed(2));
  f[38] = '1.2';
  f[39] = '12.5';
  f[44] = String(circYi);
  f[45] = String(circYi);
  f[46] = '1.5';
  f[47] = String((pre * 1.1).toFixed(2));
  f[48] = String((pre * 0.9).toFixed(2));
  f[49] = '1.1';
  return `v_${symbol}="${f.join('~')}";`;
}

function installFetchMock(handlers) {
  globalThis.fetch = async url => {
    const u = String(url);
    for (const [prefix, fn] of handlers) {
      if (u.startsWith(prefix)) return fn(u);
    }
    throw new Error(`Unexpected fetch in audit-20261123 test: ${u}`);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const DAILY_COLS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'];

// ---------------------------------------------------------------- P1-4 ex-right factor jumps

test('P1-4: TDX historical/repair path derives a real adj_factor jump on ex-right dates (10送10 / 10派5)', async () => {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'daily', DAILY_COLS, [
    { ts_code: '600001.SH', trade_date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 1000, amount: 1000 },
    { ts_code: '600002.SH', trade_date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 1000, amount: 1000 },
    { ts_code: '600003.SH', trade_date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 1000, amount: 1000 },
  ]);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [
    { ts_code: '600001.SH', trade_date: '20261117', adj_factor: 1 },
    { ts_code: '600002.SH', trade_date: '20261117', adj_factor: 1 },
    { ts_code: '600003.SH', trade_date: '20261117', adj_factor: 1 },
  ]);

  const bars = [
    { date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10 },
    { date: '20261118', open: 5.2, high: 5.3, low: 5.1, close: 5.2 },
  ];
  const srv = await startTdxServer({
    barsByCode: { '600001': bars, '600002': bars, '600003': bars },
    xdxrByCode: {
      // 10送10: reference = (10*10)/(10+10) = 5.00 -> factor x2
      '600001': [{ code: '600001', date: '20261118', category: 1, songzhuangu: 10 }],
      // 10派5: reference = (10*10-5)/10 = 9.50 -> factor 10/9.5
      '600002': [{ code: '600002', date: '20261118', category: 1, fenhong: 5 }],
      // 600003: no event at all -> a raw 48% gap must NOT fabricate a factor.
      '600003': [],
    },
  });
  const port = srv.address().port;
  try {
    await withEnv({ ASHARE_DATA_PROVIDER: 'free', ASHARE_TDX_HOSTS: `127.0.0.1:${port}` }, async () => {
      clearFreeProviderCache();
      const factorOf = async code => {
        const rows = await fetchFreeDataset('adj_factor', { ts_code: code, start_date: '20261118', end_date: '20261118' }, db);
        assert.equal(rows.length, 1);
        return rows[0].adj_factor;
      };
      assert.equal(await factorOf('600001.SH'), 2, '10送10 must double the chained factor');
      assert.equal(await factorOf('600002.SH'), 1.0526, '10派5 must chain 10/9.5');
      assert.equal(await factorOf('600003.SH'), 1, 'no xdxr event -> no fabricated factor');

      // The daily bar itself now carries the exchange reference price on the ex-date.
      const daily = await fetchFreeDataset('daily', { ts_code: '600001.SH', start_date: '20261118', end_date: '20261118' }, db);
      assert.equal(daily.length, 1);
      assert.equal(daily[0].pre_close, 5, 'ex-date pre_close is the ex-right reference price');
      assert.equal(daily[0].pct_chg, 4, '(5.2-5)/5 = +4%, not +52% of the raw prior close');
    });
  } finally {
    clearFreeProviderCache();
    restoreFetch();
    await new Promise(resolve => srv.close(resolve));
    db.close();
  }
});

test('P1-4: historical backfill snapshot writes the corrected pre_close and factor jump', async () => {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'], [
    { ts_code: '600001.SH', symbol: '600001', name: '测试送转', list_date: '20000101', list_status: 'L' },
  ]);
  upsertRows(db, 'daily', DAILY_COLS, [
    { ts_code: '600001.SH', trade_date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 1000, amount: 1000 },
  ]);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [
    { ts_code: '600001.SH', trade_date: '20261117', adj_factor: 1 },
  ]);

  const srv = await startTdxServer({
    barsByCode: {
      '600001': [
        { date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10 },
        { date: '20261118', open: 5.2, high: 5.3, low: 5.1, close: 5.2 },
      ],
    },
    xdxrByCode: { '600001': [{ code: '600001', date: '20261118', category: 1, songzhuangu: 10 }] },
  });
  const port = srv.address().port;
  // A quote from a later date forces the historical-backfill branch for 20261118.
  installFetchMock([
    ['https://qt.gtimg.cn/q=', () => new Response(tencentQuoteLine({
      symbol: 'sh600001', code: '600001', date: '20261120', open: 5.2, close: 5.2, high: 5.3, low: 5.1, pre: 5.2, vol: 1000, amtYuan: 520000,
    }), { status: 200 })],
    ['https://push2.eastmoney.com/api/qt/clist/get', () => new Response(JSON.stringify({ data: { total: 0, diff: [] } }), { status: 200 })],
  ]);
  try {
    await withEnv({ ASHARE_DATA_PROVIDER: 'free', ASHARE_TDX_HOSTS: `127.0.0.1:${port}` }, async () => {
      clearFreeProviderCache();
      const daily = await fetchFreeDataset('daily', { trade_date: '20261118' }, db);
      assert.equal(daily.length, 1);
      assert.equal(daily[0].pre_close, 5);
      assert.equal(daily[0].close, 5.2);
      assert.equal(daily[0].amount, 524.288, 'TDX amount must be carried, not 0');
      const factors = await fetchFreeDataset('adj_factor', { trade_date: '20261118' }, db);
      assert.equal(factors.length, 1);
      assert.equal(factors[0].adj_factor, 2);
      const stored = db.prepare("SELECT pre_close FROM daily WHERE ts_code='600001.SH' AND trade_date='20261117'").get();
      assert.equal(stored.pre_close, 10, 'prior stored rows are untouched');
    });
  } finally {
    clearFreeProviderCache();
    restoreFetch();
    await new Promise(resolve => srv.close(resolve));
    db.close();
  }
});

test('P1-4: ETF 1% distribution now moves fund_adj (0.1% threshold instead of 2%)', async () => {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'], [
    { ts_code: '159999.SZ', trade_date: '20261117', open: 2, high: 2.01, low: 1.99, close: 2, pre_close: 2, change: 0, pct_chg: 0, vol: 1000, amount: 2000 },
    // 1% distribution: exchange reference price 1.98 vs prior close 2.00.
    { ts_code: '159999.SZ', trade_date: '20261118', open: 1.98, high: 1.99, low: 1.97, close: 1.98, pre_close: 1.98, change: 0, pct_chg: 0, vol: 1000, amount: 1980 },
  ]);
  upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [
    { ts_code: '159999.SZ', trade_date: '20261117', adj_factor: 1 },
  ]);
  try {
    const rows = await fetchFreeDataset('fund_adj', { ts_code: '159999.SZ', start_date: '20261118', end_date: '20261118' }, db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].adj_factor, 1.0101, 'factor = 2.00 / 1.98, above the new 0.1% floor');
    assert.ok(rows[0].adj_factor !== 1, 'a 1% distribution must not be ignored');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- P1-5 trade calendar self-correction

test('P1-5: real index bars correct a previously inferred open day; uncovered days are not force-closed', async () => {
  const db = openAshareDb(':memory:');
  // Prior inference wrote 20261005 (National Day holiday) as open — index bars prove it closed.
  // 20260908 is before the bar series begins; it must keep its inferred weekday=open.
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: '20261005', is_open: 1, pretrade_date: '20260930' },
    { cal_date: '20260908', is_open: 1, pretrade_date: '20260907' },
  ]);

  const openDates = ['20260928', '20260929', '20260930', '20261009', '20261012', '20261013', '20261014', '20261015', '20261016'];
  const klines = openDates.map(d => {
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return `${iso},3300,3310,3320,3290,1000000,3000000000,1,0.3,10,0.5`;
  });
  installFetchMock([
    ['https://push2his.eastmoney.com/api/qt/stock/kline/get', () => new Response(JSON.stringify({ data: { klines } }), { status: 200 })],
  ]);
  try {
    await withEnv({ ASHARE_DATA_PROVIDER: 'free', ASHARE_TDX_HOSTS: '127.0.0.1:1' }, async () => {
      clearFreeProviderCache();
      const rows = await fetchFreeDataset('trade_cal', { start_date: '20260928', end_date: '20261016' }, db);
      const byDate = new Map(rows.map(r => [r.cal_date, r]));
      assert.equal(byDate.get('20261005').is_open, 0, 'index bars prove the holiday: prior is_open=1 corrected to 0');
      assert.equal(byDate.get('20261009').is_open, 1, 'a real open day from the bar series stays 1');
      assert.equal(byDate.get('20260928').is_open, 1);
      assert.equal(byDate.get('20261010').is_open, 0, 'weekend inside the covered range');
      // 20260908 is a Tuesday before the first returned bar: covered=false, so no forced closure.
      // It is outside the requested [start,end] output window; widen the request to see it.
      const wider = await fetchFreeDataset('trade_cal', { start_date: '20260908', end_date: '20261016' }, db);
      const w = new Map(wider.map(r => [r.cal_date, r]));
      assert.equal(w.get('20260908').is_open, 1, 'date before the bar series must not be treated as closed');
      assert.equal(w.get('20261005').is_open, 0);
    });
  } finally {
    clearFreeProviderCache();
    restoreFetch();
    db.close();
  }
});

// ---------------------------------------------------------------- P2-1 Tencent amount / qfq

test('P2-1: Tencent zero/unknown amount is null, never a suspension signal, and qfqday is not raw', async () => {
  const quote = parseTencentQuoteLine(tencentQuoteLine({
    symbol: 'sz000001', code: '000001', date: '20261118', open: 12.2, close: 12.3, high: 12.4, low: 12.1, pre: 12.2, vol: 1000, amtYuan: null,
  }));
  assert.ok(quote);
  assert.equal(quote.amount, null, 'missing amount fields -> null, not 0');
  assert.equal(quote.vol, 1000);

  installFetchMock([
    ['https://web.ifzq.gtimg.cn/appstock/app/fqkline/get', () => new Response(JSON.stringify({
      data: { sz000001: { day: [['2026-11-17', 12.2, 12.2, 12.3, 12.1, 1000], ['2026-11-18', 12.2, 12.3, 12.4, 12.1, 2000]] } },
    }), { status: 200 })],
  ]);
  try {
    const bars = await fetchTencentDailyBars('000001.SZ', '20261117', '20261118');
    assert.equal(bars.length, 2);
    assert.equal(bars[0].amount, null);
    assert.equal(bars[1].amount, null, 'Tencent daily bars never report turnover: unknown, not 0');
    assert.equal(bars[1].pre_close, 12.2);
  } finally {
    restoreFetch();
  }

  installFetchMock([
    ['https://web.ifzq.gtimg.cn/appstock/app/fqkline/get', () => new Response(JSON.stringify({
      data: { sz000001: { qfqday: [['2026-11-17', 11.0, 11.0, 11.1, 10.9, 1000], ['2026-11-18', 11.0, 11.1, 11.2, 10.9, 2000]] } },
    }), { status: 200 })],
  ]);
  try {
    const bars = await fetchTencentDailyBars('000001.SZ', '20261117', '20261118');
    assert.deepEqual(bars, [], 'a qfq-only payload must not be served as raw daily bars');
  } finally {
    restoreFetch();
  }
});

test('P2-1: a live quote with unknown amount is a real bar, not a suspended stock', async () => {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'], [
    { ts_code: '600001.SH', symbol: '600001', name: '测试无成交额', list_date: '20000101', list_status: 'L' },
  ]);
  upsertRows(db, 'daily', DAILY_COLS, [
    { ts_code: '600001.SH', trade_date: '20261117', open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 1000, amount: 1000 },
  ]);
  installFetchMock([
    ['https://qt.gtimg.cn/q=', () => new Response(tencentQuoteLine({
      symbol: 'sh600001', code: '600001', date: '20261118', open: 10.1, close: 10.2, high: 10.3, low: 10, pre: 10, vol: 1200, amtYuan: null,
    }), { status: 200 })],
    ['https://push2.eastmoney.com/api/qt/clist/get', () => new Response(JSON.stringify({ data: { total: 0, diff: [] } }), { status: 200 })],
  ]);
  try {
    await withEnv({ ASHARE_DATA_PROVIDER: 'free', ASHARE_TDX_HOSTS: '127.0.0.1:1' }, async () => {
      clearFreeProviderCache();
      const daily = await fetchFreeDataset('daily', { trade_date: '20261118' }, db);
      assert.equal(daily.length, 1, 'vol>0 with unknown amount is a valid bar');
      assert.equal(daily[0].amount, null);
      const suspended = await fetchFreeDataset('suspend_d', { trade_date: '20261118' }, db);
      assert.equal(suspended.length, 0, 'unknown amount must not be reported as a suspension');
    });
  } finally {
    clearFreeProviderCache();
    restoreFetch();
    db.close();
  }
});

// ---------------------------------------------------------------- P2-4 readiness

function seedReadinessDay(db, date, codes, overridesByCode = {}) {
  const dailyRows = codes.map(code => ({
    ts_code: code, trade_date: date, open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 100, amount: 1000,
    ...(overridesByCode[code] ?? {}),
  }));
  upsertRows(db, 'daily', DAILY_COLS, dailyRows);
  upsertRows(db, 'daily_basic', ['ts_code', 'trade_date', 'turnover_rate', 'pe_ttm', 'pb', 'circ_mv', 'total_mv'],
    codes.map(code => ({ ts_code: code, trade_date: date, turnover_rate: 1, pe_ttm: 10, pb: 1.5, circ_mv: 1000, total_mv: 2000 })));
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], codes.map(code => ({ ts_code: code, trade_date: date, adj_factor: 1 })));
  upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], codes.map(code => ({ ts_code: code, trade_date: date, up_limit: 11, down_limit: 9 })));
}

const codesOf = n => Array.from({ length: n }, (_, i) => `${600000 + i}.SH`);

test('P2-4: market-level short pages and mass bad bars block; isolated bad bars are excluded by symbol and disclosed', async () => {
  await withEnv({ ASHARE_DATA_PROVIDER: 'free' }, async () => {
    // 1) short same-day page: 90 of the previous day's 100 names -> market-level -> NOT_READY.
    const shortDb = openAshareDb(':memory:');
    try {
      upsertRows(shortDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
        { cal_date: '20261117', is_open: 1, pretrade_date: '20261116' },
        { cal_date: '20261118', is_open: 1, pretrade_date: '20261117' },
      ]);
      seedReadinessDay(shortDb, '20261117', codesOf(100));
      seedReadinessDay(shortDb, '20261118', codesOf(90));
      const short = checkDataReadiness(shortDb, '20261118');
      assert.equal(short.status, 'NOT_READY');
      assert.match(short.reason, /97%/);
    } finally {
      shortDb.close();
    }

    // 2) one bad close / one NULL OHLC out of 10: isolated -> DEGRADED + symbol disclosure.
    const isolatedDb = openAshareDb(':memory:');
    try {
      upsertRows(isolatedDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: '20261118', is_open: 1, pretrade_date: null }]);
      seedReadinessDay(isolatedDb, '20261118', codesOf(10), { '600000.SH': { close: 0 } });
      const badClose = checkDataReadiness(isolatedDb, '20261118');
      assert.equal(badClose.status, 'DEGRADED', 'one bad close must not block the whole snapshot');
      assert.match(badClose.reason, /价格字段非法 1 只（600000\.SH）/);
      assert.match(badClose.reason, /已按 symbol 剔除/);
      assert.match(badClose.reason, /不阻断日报/);

      isolatedDb.exec("UPDATE daily SET close = 10, open = NULL WHERE ts_code = '600000.SH' AND trade_date = '20261118'");
      const nullOhlc = checkDataReadiness(isolatedDb, '20261118');
      assert.equal(nullOhlc.status, 'DEGRADED');
      assert.match(nullOhlc.reason, /价格字段非法 1 只/);
    } finally {
      isolatedDb.close();
    }

    // 3) six of ten price-invalid bars is a market-level failure -> NOT_READY.
    const massDb = openAshareDb(':memory:');
    try {
      upsertRows(massDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: '20261118', is_open: 1, pretrade_date: null }]);
      const overrides = Object.fromEntries(codesOf(6).map(code => [code, { close: 0 }]));
      seedReadinessDay(massDb, '20261118', codesOf(10), overrides);
      const mass = checkDataReadiness(massDb, '20261118');
      assert.equal(mass.status, 'NOT_READY');
      assert.match(mass.reason, /行情记录非法 6 条（> 5），属市场级坏条/);
    } finally {
      massDb.close();
    }

    // 4) an auxiliary dataset gap (<97%) is disclosed, not a block.
    const auxDb = openAshareDb(':memory:');
    try {
      upsertRows(auxDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: '20261118', is_open: 1, pretrade_date: null }]);
      seedReadinessDay(auxDb, '20261118', codesOf(10));
      auxDb.exec("DELETE FROM stk_limit WHERE ts_code = '600009.SH'");
      const aux = checkDataReadiness(auxDb, '20261118');
      assert.equal(aux.status, 'DEGRADED', 'auxiliary dataset gaps must not block the report');
      assert.match(aux.reason, /stk_limit=9 < daily=10/);
      assert.match(aux.reason, /不阻断日报/);
    } finally {
      auxDb.close();
    }
  });
});

test('P2-4: free mode discloses unusable daily_basic/adj_factor instead of trusting 1:1 NULL rows', async () => {
  await withEnv({ ASHARE_DATA_PROVIDER: 'free' }, async () => {
    const db = openAshareDb(':memory:');
    try {
      upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: '20261118', is_open: 1, pretrade_date: null }]);
      seedReadinessDay(db, '20261118', codesOf(10));
      // Historical backfill shape: a daily_basic row per stock, every valuation field NULL.
      // Anti-over-defense: a missing valuation column is a disclosed data-quality warning
      // (DEGRADED still publishes), not a whole-day NOT_READY block.
      db.exec("UPDATE daily_basic SET pe_ttm = NULL, pb = NULL, circ_mv = NULL WHERE trade_date = '20261118'");
      const nullBasic = checkDataReadiness(db, '20261118');
      assert.equal(nullBasic.status, 'DEGRADED', 'publishes with a warning instead of blocking the report');
      assert.match(nullBasic.reason, /free 模式 daily_basic 有效值 0/);
      assert.match(nullBasic.reason, /不阻断日报/);

      // Usable values clear the warning.
      db.exec("UPDATE daily_basic SET pb = 1.5 WHERE trade_date = '20261118'");
      const covered = checkDataReadiness(db, '20261118');
      assert.ok(!String(covered.reason).includes('daily_basic 有效值'), `unexpected free-mode reason: ${covered.reason}`);

      // Non-positive factors are disclosed the same way.
      db.exec("UPDATE adj_factor SET adj_factor = 0 WHERE trade_date = '20261118'");
      const badAdj = checkDataReadiness(db, '20261118');
      assert.equal(badAdj.status, 'DEGRADED');
      assert.match(badAdj.reason, /free 模式 adj_factor 正值 0/);
    } finally {
      db.close();
    }
  });
});

test('P2-4 addendum: hotspotPipeline publishes with isolated bad OHLC and blocks only on market-level price defects', () => {
  const db = openAshareDb(':memory:');
  try {
    const days = weekdays('20250101', 100);
    const asOf = days.at(-1);
    seedMarket(db, days);

    // One isolated NULL open on the as-of bar: the pipeline gate reads dataState → the same
    // isolated-defect policy as checkDataReadiness, so the snapshot must still be written.
    db.prepare("UPDATE daily SET open = NULL WHERE ts_code = '600000.SH' AND trade_date = ?").run(asOf);
    const isolated = runHotspotPipeline(db, asOf, { etfCodes: [] });
    assert.equal(isolated.readiness.status, 'DEGRADED', isolated.readiness.reason);
    assert.match(String(isolated.readiness.reason), /价格字段非法 1 只（600000\.SH）/);
    assert.ok(isolated.saved, 'isolated bad OHLC must not block the hotspot snapshot write');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM hotspot_snapshot WHERE as_of = ?').get(asOf).n, 1);

    // Six price-defective symbols is market-level: the same gate must refuse to persist.
    const massCodes = Array.from({ length: 6 }, (_, i) => `${600000 + i}.SH`);
    const corrupt = db.prepare('UPDATE daily SET close = 0 WHERE ts_code = ? AND trade_date = ?');
    for (const code of massCodes) corrupt.run(code, asOf);
    const mass = runHotspotPipeline(db, asOf, { etfCodes: [] });
    assert.equal(mass.readiness.status, 'NOT_READY');
    assert.match(String(mass.readiness.reason), /行情记录非法 6 条（> 5），属市场级坏条/);
    assert.equal(mass.saved, null, 'market-level price defects must not persist a snapshot');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM hotspot_snapshot WHERE as_of = ?').get(asOf).n, 1, 'the earlier valid snapshot is untouched');
  } finally {
    db.close();
  }
});

test('P2-4 third-round: the real daily report entry publishes isolated bad OHLC and blocks market-level defects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-report-'));
  const prevDataDir = process.env.ASHARE_DATA_DIR;
  process.env.ASHARE_DATA_DIR = dir;
  const db = openAshareDb(':memory:');
  try {
    const days = weekdays('20250101', 100);
    const asOf = days.at(-1);
    seedMarket(db, days);

    // One isolated NULL open on the as-of bar: checkQuality classifies it as a per-symbol
    // defect, so generateReport (the real daily/report entry) must still produce the market
    // judgement and publish DEGRADED instead of short-circuiting on NOT_READY.
    db.prepare("UPDATE daily SET open = NULL WHERE ts_code = '600000.SH' AND trade_date = ?").run(asOf);
    const isolated = generateReport(db, asOf, 'live');
    assert.equal(isolated.report.status, 'DEGRADED', JSON.stringify(isolated.report.data?.quality?.reasons));
    assert.ok(isolated.report.market, 'the market judgement must still be produced');
    assert.equal(isolated.report.not_ready, undefined);
    assert.equal(isolated.report.data.quality.status, 'DEGRADED');
    assert.match(
      JSON.stringify(isolated.report.data.quality.reasons),
      /600000\.SH.*已按 symbol 剔除/,
      'the report discloses the excluded symbol',
    );

    // Six bad bars are market-level: the same entry returns to a NOT_READY report that carries
    // no market judgement, never a silently degraded one.
    const massCodes = Array.from({ length: 6 }, (_, i) => `${600000 + i}.SH`);
    const corrupt = db.prepare('UPDATE daily SET close = 0 WHERE ts_code = ? AND trade_date = ?');
    for (const code of massCodes) corrupt.run(code, asOf);
    const mass = generateReport(db, asOf, 'live');
    assert.equal(mass.report.status, 'NOT_READY');
    assert.ok(mass.report.not_ready);
    assert.equal(mass.report.market, undefined);
  } finally {
    db.close();
    if (prevDataDir === undefined) delete process.env.ASHARE_DATA_DIR;
    else process.env.ASHARE_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- P2-5 regime lookback + breadth universe

/** Shared market fixture for the regime tests: a rising index trio with a one-day crash. */
function seedRegimeMarket(db, days, crashIdx) {
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    days.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null })));

  const steady = (base, i) => base * (1 + 0.001 * i);
  const indexSeries = base => i => (i === crashIdx ? steady(base, crashIdx - 1) * 0.95 : steady(base, i));
  const pushIndex = (tsCode, base) => {
    upsertRows(db, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map((trade_date, i) => {
        const close = indexSeries(base)(i);
        const prev = i > 0 ? indexSeries(base)(i - 1) : close;
        return {
          ts_code: tsCode, trade_date, open: close, high: close * 1.01, low: close * 0.99, close,
          pre_close: prev, pct_chg: prev > 0 ? ((close / prev) - 1) * 100 : 0, vol: 1e6, amount: 1e6,
        };
      }));
  };
  pushIndex('000300.SH', 3000);
  pushIndex('000905.SH', 5000);
  pushIndex('399006.SZ', 2000);

  // 100 names each day: flat except the crash day, where every name sits at its down limit.
  const codes = codesOf(100);
  const daily = [];
  const limits = [];
  for (let i = 0; i < days.length; i++) {
    for (const code of codes) {
      const crash = i === crashIdx;
      daily.push({
        ts_code: code, trade_date: days[i], open: 10, high: 10, low: crash ? 9 : 10,
        close: crash ? 9 : 10, pre_close: 10, pct_chg: crash ? -10 : 0, vol: 1000, amount: 1000,
      });
      limits.push({ ts_code: code, trade_date: days[i], up_limit: 11, down_limit: 9 });
    }
  }
  upsertRows(db, 'daily', DAILY_COLS, daily);
  upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], limits);

  // Breadth toggles the raw regime between OFFENSIVE and STRUCTURAL after the crash so that
  // no two consecutive days agree; only the crash-set DEFENSIVE can survive.
  const pctMap = {};
  for (let i = 0; i < days.length; i++) {
    pctMap[days[i]] = i <= crashIdx ? 0.6 : ((i - crashIdx) % 2 === 1 ? 0.6 : 0.38);
  }
  return pctMap;
}

test('P2-5: the confirmed regime is carried from the last crash, not re-seeded by the display window', async () => {
  const db = openAshareDb(':memory:');
  try {
    const days = weekdays('20260302', 110);
    const asOf = days.at(-1);
    // 30 trading days before asOf: outside the default 20-day DISPLAY window, inside the
    // bounded 60-day STATE replay window. The crash lock must still hold.
    const crashIdx = days.length - 30;
    const pctMap = seedRegimeMarket(db, days, crashIdx);

    const held = evaluateMarketRegime(db, asOf, { pctAboveMa60ByDate: pctMap });
    assert.equal(held.crash_override, false, 'the crash itself is 30 trading days before asOf');
    assert.equal(held.regime, 'DEFENSIVE', 'the state machine inherits the crash lock from outside the display window');
    assert.equal(held.hysteresis_held, true);
    assert.equal(held.history.length, 20, 'display history stays bounded at the default 20 days');

    // The display lookback no longer controls the carried state: even a 5-day display keeps it.
    const shortDisplay = evaluateMarketRegime(db, asOf, { hysteresisLookbackDays: 5, pctAboveMa60ByDate: pctMap });
    assert.equal(shortDisplay.regime, 'DEFENSIVE', 'a short display window must not forget the crash');
    assert.equal(shortDisplay.history.length, 5);
    assert.equal(shortDisplay.history.at(-1).confirmed_regime, 'DEFENSIVE');
  } finally {
    db.close();
  }
});

test('P2-5 third-round: the crash lock survives more than 60 trading days of alternating raw', async () => {
  const db = openAshareDb(':memory:');
  try {
    const days = weekdays('20260105', 160);
    const asOf = days.at(-1);
    // 70 trading days before asOf: outside the 60-day state window. The report-backed replay
    // extension must still find the crash event and carry DEFENSIVE to asOf.
    const crashIdx = days.length - 70;
    const pctMap = seedRegimeMarket(db, days, crashIdx);

    const held = evaluateMarketRegime(db, asOf, { pctAboveMa60ByDate: pctMap });
    assert.equal(held.crash_override, false, 'the crash is 70 trading days before asOf');
    assert.equal(held.regime, 'DEFENSIVE', 'the >60-day event scan keeps the crash lock');
    assert.equal(held.hysteresis_held, true);
    assert.equal(held.history.length, 20);

    const shortDisplay = evaluateMarketRegime(db, asOf, { hysteresisLookbackDays: 5, pctAboveMa60ByDate: pctMap });
    assert.equal(shortDisplay.regime, 'DEFENSIVE');
    assert.equal(shortDisplay.history.length, 5);
  } finally {
    db.close();
  }
});

test('P2-5: scanMarket breadth excludes .BJ, missing MA60 and price-defective symbols; no valid MA yields null', () => {
  const db = openAshareDb(':memory:');
  try {
    const days = weekdays('20260701', 70);
    const asOf = days.at(-1);
    upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
      days.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null })));

    const universe = [
      { ts_code: '600001.SH', name: '上升A' },
      { ts_code: '600002.SH', name: '上升B' },
      { ts_code: '920001.BJ', name: '北交所C' },
      { ts_code: '600004.SH', name: '短历史D', bars: 30 },
      { ts_code: '600005.SH', name: '下降E' },
      { ts_code: '600006.SH', name: '坏价格F' },
    ];
    upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'],
      universe.map(s => ({ ts_code: s.ts_code, symbol: s.ts_code.slice(0, 6), name: s.name, industry: '测试', list_date: '20180101', list_status: 'L' })));

    const daily = [];
    const factors = [];
    for (const s of universe) {
      const offset = days.length - (s.bars ?? days.length);
      days.slice(offset).forEach((trade_date, k) => {
        const rising = s.ts_code !== '600005.SH';
        const defect = s.ts_code === '600006.SH' && trade_date === asOf;
        const close = rising ? 10 + k * 0.2 : 30 - k * 0.2;
        daily.push({
          ts_code: s.ts_code, trade_date, open: close, high: close * 1.01, low: close * 0.99,
          close: defect ? 0 : close, pre_close: close, pct_chg: 0, vol: 1000, amount: 1000,
        });
        factors.push({ ts_code: s.ts_code, trade_date, adj_factor: 1 });
      });
    }
    upsertRows(db, 'daily', DAILY_COLS, daily);
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], factors);

    const scan = scanMarket(db, asOf);
    // MA60 universe: 600001 (above), 600002 (above), 600005 (below). .BJ, the 30-bar stock and
    // the price-defective symbol are excluded.
    assert.ok(Math.abs(scan.pct_above_ma60 - 2 / 3) < 1e-9, `pct_above_ma60=${scan.pct_above_ma60}`);
    // MA20 universe adds the 30-bar stock (valid MA20, above), still excludes .BJ and the defect.
    assert.ok(Math.abs(scan.pct_above_ma20 - 3 / 4) < 1e-9, `pct_above_ma20=${scan.pct_above_ma20}`);
    assert.notEqual(scan.pct_above_ma60, 0.6, 'the old all-rows denominator would report 3/5');

    const defective = scan.rows.find(r => r.ts_code === '600006.SH');
    assert.equal(defective.signals.length, 0, 'a price-defective symbol must not emit signals');
    assert.ok(defective.risk_flags.some(f => f.includes('价格字段非法')), JSON.stringify(defective.risk_flags));
  } finally {
    db.close();
  }

  // No valid MA60 anywhere -> null (unknown), never 0% (which reads as maximally weak).
  const shortDb = openAshareDb(':memory:');
  try {
    const days = weekdays('20260701', 30);
    const asOf = days.at(-1);
    upsertRows(shortDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
      days.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null })));
    upsertRows(shortDb, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [
      { ts_code: '600001.SH', symbol: '600001', name: '短历史', industry: '测试', list_date: '20180101', list_status: 'L' },
    ]);
    upsertRows(shortDb, 'daily', DAILY_COLS, days.map((trade_date, k) => ({
      ts_code: '600001.SH', trade_date, open: 10 + k * 0.2, high: 10.3 + k * 0.2, low: 9.9 + k * 0.2,
      close: 10 + k * 0.2, pre_close: 10 + k * 0.2, pct_chg: 0, vol: 1000, amount: 1000,
    })));
    upsertRows(shortDb, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: '600001.SH', trade_date, adj_factor: 1 })));
    const scan = scanMarket(shortDb, asOf);
    assert.equal(scan.pct_above_ma60, null, 'no MA60 anywhere is unknown, not 0%');
    assert.ok(Number.isFinite(scan.pct_above_ma20), 'MA20 is still measured when available');
  } finally {
    shortDb.close();
  }
});

// ---------------------------------------------------------------- P2-3 financials

test('P2-3: a cashflow endpoint failure surfaces instead of nulling the whole market', async () => {
  const db = openAshareDb(':memory:');
  const cpd = {
    result: {
      pages: 1,
      data: [{
        SECUCODE: '000001.SZ', NOTICE_DATE: '2026-10-24 00:00:00', REPORTDATE: '2026-09-30 00:00:00',
        BASIC_EPS: 1.94, WEIGHTAVG_ROE: 8.07, YSTZ: 2.4, SJLTZ: 2.2, XSMLL: 30, MGJYXJJE: 14.59, PARENT_NETPROFIT: 1000,
      }],
    },
  };
  const balance = { result: { pages: 1, data: [{ SECUCODE: '000001.SZ', DEBT_ASSET_RATIO: 90.6 }] } };
  let cashflowFails = true;
  installFetchMock([
    ['https://datacenter-web.eastmoney.com/api/data/v1/get', u => {
      if (u.includes('RPT_DMSK_FN_CASHFLOW')) {
        return cashflowFails ? new Response('boom', { status: 500 }) : new Response(JSON.stringify({ result: { pages: 1, data: [{ SECUCODE: '000001.SZ', NETCASH_OPERATE: 6045 }] } }), { status: 200 });
      }
      if (u.includes('RPT_DMSK_FN_BALANCE')) return new Response(JSON.stringify(balance), { status: 200 });
      return new Response(JSON.stringify(cpd), { status: 200 });
    }],
  ]);
  try {
    await withEnv({ ASHARE_DATA_PROVIDER: 'free' }, async () => {
      clearFreeProviderCache();
      await assert.rejects(
        () => fetchFreeDataset('fina_indicator_vip', { period: '20260930' }, db),
        /HTTP 500/,
        'a cashflow failure must not be swallowed into NULL ocf_to_profit',
      );
      assert.equal(db.prepare('SELECT COUNT(*) n FROM fina_indicator').get().n, 0, 'nothing cached from a failed fetch');

      // With a local copy of the period, the router keeps the cached values instead of nulling them.
      upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'ocf_to_profit', 'eps'], [
        { ts_code: '000001.SZ', end_date: '20260930', ann_date: '20261024', roe: 8.07, ocf_to_profit: 55, eps: 1.94 },
      ]);
      clearFreeProviderCache();
      const cachedRows = await fetchFreeDataset('fina_indicator_vip', { period: '20260930' }, db);
      assert.equal(cachedRows.length, 1);
      assert.equal(cachedRows[0].ocf_to_profit, 55, 'cached cashflow value survives an upstream failure');

      cashflowFails = false;
      clearFreeProviderCache();
      const freshRows = await fetchFreeDataset('fina_indicator_vip', { period: '20260930' }, db);
      assert.equal(freshRows.length, 1);
      assert.equal(freshRows[0].ocf_to_profit, 604.5, 'OCF/归母净利润 = 6045/1000');
      assert.equal(freshRows[0].debt_to_assets, 90.6);
    });
  } finally {
    clearFreeProviderCache();
    restoreFetch();
    db.close();
  }
});

test('P2-3: announcement-first PIT selection is opt-in; the public default stays period-first', () => {
  const db = openAshareDb(':memory:');
  try {
    upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe'], [
      // Q1 2026 announced 04-28 ...
      { ts_code: '000001.SZ', end_date: '20260331', ann_date: '20260428', roe: 2.5 },
      // ... then FY2025 was re-announced 04-30.
      { ts_code: '000001.SZ', end_date: '20251231', ann_date: '20260430', roe: 9 },
    ]);
    const byPeriod = financialsAsOf(db, '20260501').get('000001.SZ');
    assert.equal(byPeriod.end_date, '20260331', 'public default: the newest period wins');
    const byAnnouncement = financialsAsOf(db, '20260501', 'announcement-first').get('000001.SZ');
    assert.equal(byAnnouncement.end_date, '20251231', 'stock-swing PIT: a late re-announcement of an older period wins');
    assert.equal(byAnnouncement.ann_date, '20260430');
    // Without a later correction both orders select the newest period.
    assert.equal(financialsAsOf(db, '20260429').get('000001.SZ').end_date, '20260331');
    assert.equal(financialsAsOf(db, '20260429', 'announcement-first').get('000001.SZ').end_date, '20260331');
  } finally {
    db.close();
  }

  // The scan hook wiring: only the stock-swing screener opts into announcement-first.
  const scanDb = openAshareDb(':memory:');
  try {
    const days = weekdays('20260105', 90);
    const asOf = days.at(-1);
    upsertRows(scanDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
      days.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null })));
    upsertRows(scanDb, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [
      { ts_code: '000001.SZ', symbol: '000001', name: '测试', industry: '银行', list_date: '20180101', list_status: 'L' },
    ]);
    upsertRows(scanDb, 'daily', DAILY_COLS, days.map((trade_date, k) => ({
      ts_code: '000001.SZ', trade_date, open: 10 + k * 0.05, high: 10.2 + k * 0.05, low: 9.9 + k * 0.05,
      close: 10 + k * 0.05, pre_close: 10 + k * 0.05, pct_chg: 0, vol: 1000, amount: 1000,
    })));
    upsertRows(scanDb, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: '000001.SZ', trade_date, adj_factor: 1 })));
    upsertRows(scanDb, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe'], [
      { ts_code: '000001.SZ', end_date: '20260331', ann_date: '20260428', roe: 2.5 },
      { ts_code: '000001.SZ', end_date: '20251231', ann_date: '20260430', roe: 9 },
    ]);
    const pick = hooks => scanMarket(scanDb, asOf, hooks).rows.find(r => r.ts_code === '000001.SZ')?.fundamentals;
    assert.equal(pick().end_date, '20260331', 'scanMarket default follows the public period-first rule');
    assert.equal(pick({ fundamentals_order: 'announcement-first' }).end_date, '20251231', 'the stock-swing hook selects by announcement');
  } finally {
    scanDb.close();
  }
});

// ---------------------------------------------------------------- P3-1 quick fixes

test('P3-1: rate-limit detection is word-bounded', () => {
  assert.equal(isRateLimit('generate report failed'), false);
  assert.equal(isRateLimit('accurate data unavailable'), false);
  assert.equal(isRateLimit('separator missing'), false);
  assert.equal(isRateLimit('每分钟最多调用 200 次'), true);
  assert.equal(isRateLimit('接口频次超限'), true);
  assert.equal(isRateLimit('Too many requests'), true);
  assert.equal(isRateLimit('rate limit exceeded'), true);
  assert.equal(isRateLimit('rate_limit_error'), true);
});

test('P3-1: current-day snapshots are refused before the 15:05 Beijing close', () => {
  // 2026-11-23 10:00 Beijing (02:00Z) and 15:10 Beijing (07:10Z).
  assert.equal(isFinalAshareClose('20261123', Date.parse('2026-11-23T02:00:00Z')), false);
  assert.equal(isFinalAshareClose('20261123', Date.parse('2026-11-23T07:04:00Z')), false);
  assert.equal(isFinalAshareClose('20261123', Date.parse('2026-11-23T07:10:00Z')), true);
  assert.equal(isFinalAshareClose('20261120', Date.parse('2026-11-23T02:00:00Z')), true, 'historical days are always final');
});

test('P3-1: a TDX read timeout closes the session so later requests cannot reuse a corrupt buffer', async () => {
  const srv = net.createServer(sock => {
    sock.on('data', chunk => {
      if (chunk.length === 13 && chunk[10] === 0x0d) sock.write(tdxFrame(Buffer.from('ok')));
      // Every other command is ignored: the client must time out.
    });
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const session = new TdxSession({ host: '127.0.0.1', port }, 120);
  try {
    await session.connect();
    await assert.rejects(() => session.getBars(9, 1, '600001', 0, 10, false), /read timeout/);
    assert.equal(session.socket, null, 'the session socket is destroyed on timeout');
    await assert.rejects(() => session.getBars(9, 1, '600001', 0, 10, false), /TDX not connected/);
  } finally {
    session.close();
    await new Promise(resolve => srv.close(resolve));
  }
});
