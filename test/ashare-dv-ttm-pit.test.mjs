import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const {
  computeDvTtmPit,
  upsertXdxrEvents,
  loadXdxrKnowledge,
  backfillDailyBasicDvTtm,
} = await import('../build/ashare/dividendYield.js');
const { syncTradeDate } = await import('../build/ashare/ingest.js');
const { clearFreeProviderCache, fetchFreeDataset } = await import('../build/ashare/providers/freeProviderRouter.js');

const originalFetch = globalThis.fetch;

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
  const body = z.length >= payload.length ? payload : z;
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(0x01, 0);
  hdr.writeUInt16LE(body.length, 12);
  hdr.writeUInt16LE(payload.length, 14);
  return Buffer.concat([hdr, body]);
}

function encodeBarsPayload(bars) {
  const chunks = [Buffer.alloc(2)];
  chunks[0].writeUInt16LE(bars.length, 0);
  let prevCloseBase = 0;
  for (const b of bars) {
    const d = Buffer.alloc(4);
    d.writeUInt32LE(Number(b.date), 0);
    const openBase = Math.round(b.open * 1000);
    const closeBase = Math.round(b.close * 1000);
    const highBase = Math.round(b.high * 1000);
    const lowBase = Math.round(b.low * 1000);
    const tail = Buffer.alloc(8);
    // 0x4e0c0978 -> positive decoded vol
    tail.writeUInt32LE(0x4e0c0978, 0);
    tail.writeUInt32LE(0x4e0c0978, 4);
    chunks.push(
      d,
      encodeTdxVarint(openBase - prevCloseBase),
      encodeTdxVarint(closeBase - openBase),
      encodeTdxVarint(highBase - openBase),
      encodeTdxVarint(lowBase - openBase),
      tail,
    );
    prevCloseBase = closeBase;
  }
  return Buffer.concat(chunks);
}

function encodeXdxrPayload(events) {
  const buf = Buffer.alloc(11 + events.length * 29);
  buf.writeUInt16LE(events.length, 9);
  events.forEach((e, i) => {
    const base = 11 + i * 29;
    buf.writeUInt8(e.market ?? 1, base);
    Buffer.from(e.code ?? '600000', 'ascii').copy(buf, base + 1);
    buf.writeUInt32LE(Number(e.date), base + 8);
    buf.writeUInt8(e.category ?? 1, base + 12);
    buf.writeFloatLE(e.fenhong ?? 0, base + 13);
    buf.writeFloatLE(e.peigujia ?? 0, base + 17);
    buf.writeFloatLE(e.songzhuangu ?? 0, base + 21);
    buf.writeFloatLE(e.peigu ?? 0, base + 25);
  });
  return buf;
}

function startMockTdxServer({ barsByCode = {}, xdxrByCode = {} } = {}) {
  const srv = net.createServer(sock => {
    sock.on('data', chunk => {
      if (chunk.length === 13 && chunk[10] === 0x0d) {
        sock.write(tdxFrame(Buffer.from('ok')));
        return;
      }
      const cmd = chunk.readUInt16LE(10);
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

function buildTencentLine(symbol, name, code, date, open, close, high, low, pre, vol, amtYuan, circYi) {
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
  f[35] = `${close}/${vol}/${amtYuan}`;
  f[37] = String((amtYuan / 10000).toFixed(2));
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

// ---------------------------------------------------------------- Pure PIT unit tests

test('computeDvTtmPit handles annual and semi-annual multiple cash dividends in % unit', () => {
  const events = [
    { ex_date: '20260116', category: 1, fenhong: 10.13 },
    { ex_date: '20260710', category: 1, fenhong: 10.03 },
    // category !== 1 (share listing / non-dividend event) must be ignored
    { ex_date: '20260801', category: 5, fenhong: 999 },
  ];
  // (1.013 + 1.003) / 43.45 * 100 = 4.639815... -> 4.6398 (%)
  assert.equal(computeDvTtmPit(43.45, '20261117', events), 4.6398);
  assert.equal(computeDvTtmPit(43.45, '20261117', []), 0);
  assert.equal(computeDvTtmPit(0, '20261117', events), null);
  assert.equal(computeDvTtmPit(null, '20261117', events), null);
  assert.equal(computeDvTtmPit(43.45, 'bad-date', events), null);
});

test('computeDvTtmPit dilutes both cross-period and same-day bonus/rights shares properly', () => {
  // 1) Cross-period bonus after dividend: 10派3.12 on 20260608, then 10送4 on 20260923
  const crossPeriod = [
    { ex_date: '20260608', category: 1, fenhong: 3.12, songzhuangu: 0 },
    { ex_date: '20260923', category: 1, fenhong: 0, songzhuangu: 4 },
  ];
  // (0.312 / 1.4) / 29.36 * 100 = 0.75905... -> 0.7591
  assert.equal(computeDvTtmPit(29.36, '20261117', crossPeriod), 0.7591);

  // 2) Same-day cash + bonus, followed by later cash dividend:
  //    20260617: 10派3.8转4; 20260907: 10派0.9 -> 0.38/1.4 + 0.09 = 0.36142857 / 14.52 * 100 = 2.4892
  const sameDayAndLater = [
    { ex_date: '20260617', category: 1, fenhong: 3.8, songzhuangu: 4 },
    { ex_date: '20260907', category: 1, fenhong: 0.9, songzhuangu: 0 },
  ];
  assert.equal(computeDvTtmPit(14.52, '20261117', sameDayAndLater), 2.4892);

  // 3) Split BEFORE dividend must NOT dilute the later dividend
  const splitBeforeDiv = [
    { ex_date: '20260110', category: 1, fenhong: 0, songzhuangu: 10 },
    { ex_date: '20260520', category: 1, fenhong: 5, songzhuangu: 0 },
  ];
  // 0.5 / 10 * 100 = 5.0%
  assert.equal(computeDvTtmPit(10, '20261117', splitBeforeDiv), 5);

  // 4) Unsorted input events + separate same-date records (split + cash) must give same result
  const splitRowsSameDay = [
    { ex_date: '20260617', category: 1, fenhong: 0, songzhuangu: 4 },
    { ex_date: '20260907', category: 1, fenhong: 0.9, songzhuangu: 0 },
    { ex_date: '20260617', category: 1, fenhong: 3.8, songzhuangu: 0 },
  ];
  assert.equal(computeDvTtmPit(14.52, '20261117', splitRowsSameDay), 2.4892);
});

test('computeDvTtmPit enforces strict PIT boundary dates: ex_date==trade_date included, >trade_date excluded, >365d rolled out', () => {
  const events = [
    // Exactly 365 days before 20261117 -> excluded (half-open window (20251117, 20261117])
    { ex_date: '20251117', category: 1, fenhong: 2.1 },
    // 364 days before 20261117 -> included
    { ex_date: '20251118', category: 1, fenhong: 1.5 },
    // Exact trade_date -> included
    { ex_date: '20261117', category: 1, fenhong: 2.0 },
    // Future ex-dividend & future split -> strictly forbidden (zero lookahead)
    { ex_date: '20261118', category: 1, fenhong: 9.0, songzhuangu: 10 },
  ];
  // (0.15 + 0.20) / 10 * 100 = 3.5%
  assert.equal(computeDvTtmPit(10, '20261117', events), 3.5);
  // On 20261116: both 20251117 (2.1) and 20251118 (1.5) are inside (20251116, 20261116], 20261117 is future!
  // -> (0.21 + 0.15) / 10 * 100 = 3.6%
  assert.equal(computeDvTtmPit(10, '20261116', events), 3.6);
  // On 20261118: 20251118 rolls out, 20261117 gets diluted by 20261118 10送10, plus 20261118 10派9:
  // (0.20 + 0.90) / 2 / 10 * 100 = 5.5%
  assert.equal(computeDvTtmPit(10, '20261118', events), 5.5);
});

test('2026-11-17 real sample verification: 26 stocks match stored daily_basic.dv_ttm with MAE < 0.01 and r > 0.999', () => {
  // Real close, stored daily_basic.dv_ttm, and TDX xdxr events observed read-only on 2026-11-17.
  const samples = [
    { code: '600329.SH', close: 38.65, stored: 12.3933, evs: [{ ex_date: '20250704', category: 1, fenhong: 12.8 }, { ex_date: '20260212', category: 1, fenhong: 24.5 }, { ex_date: '20260710', category: 1, fenhong: 23.4 }] },
    { code: '002763.SZ', close: 7.1, stored: 11.2676, evs: [{ ex_date: '20250529', category: 1, fenhong: 1.5 }, { ex_date: '20250924', category: 1, fenhong: 3 }, { ex_date: '20260515', category: 1, fenhong: 8 }] },
    { code: '002572.SZ', close: 7.35, stored: 10.8844, evs: [{ ex_date: '20250529', category: 1, fenhong: 10 }, { ex_date: '20260521', category: 1, fenhong: 8 }] },
    { code: '600398.SH', close: 6.25, stored: 10.88, evs: [{ ex_date: '20250710', category: 1, fenhong: 1.8 }, { ex_date: '20260511', category: 1, fenhong: 4.1 }, { ex_date: '20261014', category: 1, fenhong: 2.7 }] },
    { code: '000915.SZ', close: 19.42, stored: 10.2987, evs: [{ ex_date: '20250611', category: 1, fenhong: 20 }, { ex_date: '20251017', category: 1, fenhong: 5 }, { ex_date: '20260701', category: 1, fenhong: 20 }] },
    { code: '600380.SH', close: 10.48, stored: 8.874, evs: [{ ex_date: '20250718', category: 1, fenhong: 2 }, { ex_date: '20260626', category: 1, fenhong: 2.2 }, { ex_date: '20261020', category: 1, fenhong: 7.1 }] },
    { code: '600866.SH', close: 4.32, stored: 8.7963, evs: [{ ex_date: '20250623', category: 1, fenhong: 3.8 }, { ex_date: '20260723', category: 1, fenhong: 3.8 }] },
    { code: '600153.SH', close: 8.25, stored: 8.4848, evs: [{ ex_date: '20260211', category: 1, fenhong: 2 }, { ex_date: '20260624', category: 1, fenhong: 5 }] },
    { code: '002441.SZ', close: 8.31, stored: 8.4236, evs: [{ ex_date: '20251216', category: 1, fenhong: 2 }, { ex_date: '20260625', category: 1, fenhong: 3 }, { ex_date: '20260909', category: 1, fenhong: 2 }] },
    { code: '600382.SH', close: 4.92, stored: 8.3943, evs: [{ ex_date: '20260115', category: 1, fenhong: 2 }, { ex_date: '20260525', category: 1, fenhong: 2.13 }] },
    { code: '603833.SH', close: 29.6, stored: 8.3682, evs: [{ ex_date: '20260109', category: 1, fenhong: 12.4 }, { ex_date: '20260625', category: 1, fenhong: 12.37 }] },
    { code: '000001.SZ', close: 12.25, stored: 4.9714, evs: [{ ex_date: '20260612', category: 1, fenhong: 3.6 }, { ex_date: '20260924', category: 1, fenhong: 2.49 }] },
    { code: '000651.SZ', close: 40.66, stored: 7.3707, evs: [{ ex_date: '20260123', category: 1, fenhong: 10 }, { ex_date: '20260827', category: 1, fenhong: 20 }] },
    { code: '000858.SZ', close: 73.98, stored: 6.9695, evs: [{ ex_date: '20251218', category: 1, fenhong: 25.78 }, { ex_date: '20260716', category: 1, fenhong: 25.796852 }] },
    { code: '600028.SH', close: 5.89, stored: 3.6863, evs: [{ ex_date: '20260617', category: 1, fenhong: 1.12 }, { ex_date: '20260930', category: 1, fenhong: 1.05 }] },
    { code: '600036.SH', close: 43.45, stored: 4.6398, evs: [{ ex_date: '20260116', category: 1, fenhong: 10.13 }, { ex_date: '20260710', category: 1, fenhong: 10.03 }] },
    { code: '600519.SH', close: 1457.7, stored: 3.5689, evs: [{ ex_date: '20251219', category: 1, fenhong: 239.57 }, { ex_date: '20260626', category: 1, fenhong: 280.2423 }] },
    { code: '600887.SH', close: 32.41, stored: 4.2579, evs: [{ ex_date: '20251217', category: 1, fenhong: 4.8 }, { ex_date: '20260605', category: 1, fenhong: 9 }] },
    { code: '600900.SH', close: 30.6, stored: 3.268, evs: [{ ex_date: '20260212', category: 1, fenhong: 2.1 }, { ex_date: '20260717', category: 1, fenhong: 7.9 }] },
    { code: '601088.SH', close: 50.57, stored: 3.9747, evs: [{ ex_date: '20260713', category: 1, fenhong: 10.3 }, { ex_date: '20261026', category: 1, fenhong: 9.8 }] },
    { code: '601166.SH', close: 20.17, stored: 5.2851, evs: [{ ex_date: '20260206', category: 1, fenhong: 5.65 }, { ex_date: '20260612', category: 1, fenhong: 5.01 }] },
    { code: '000034.SZ', close: 22.07, stored: 0.2363, evs: [{ ex_date: '20260519', category: 1, fenhong: 0.73, songzhuangu: 4 }] },
    { code: '001225.SZ', close: 29.36, stored: 0.7591, evs: [{ ex_date: '20260608', category: 1, fenhong: 3.12 }, { ex_date: '20260923', category: 1, songzhuangu: 4 }] },
    { code: '001230.SZ', close: 14.52, stored: 2.4892, evs: [{ ex_date: '20260617', category: 1, fenhong: 3.8, songzhuangu: 4 }, { ex_date: '20260907', category: 1, fenhong: 0.9 }] },
    { code: '002966.SZ', close: 10.12, stored: 1.4822, evs: [{ ex_date: '20251117', category: 1, fenhong: 2.1 }, { ex_date: '20260624', category: 1, fenhong: 1.5 }] },
    { code: '002007.SZ', close: 11.73, stored: 5.9676, evs: [{ ex_date: '20260615', category: 1, fenhong: 5 }, { ex_date: '20261117', category: 1, fenhong: 2 }] },
  ];

  const xs = [];
  const ys = [];
  for (const s of samples) {
    const calc = computeDvTtmPit(s.close, '20261117', s.evs);
    assert.ok(calc !== null);
    xs.push(s.stored);
    ys.push(calc);
  }
  const mae = xs.reduce((acc, x, i) => acc + Math.abs(x - ys[i]), 0) / xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const sdx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const sdy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  const r = cov / (sdx * sdy);
  assert.ok(mae < 0.01, `expected MAE < 0.01, got ${mae}`);
  assert.ok(r > 0.9999, `expected Pearson r > 0.9999, got ${r}`);
});

// ---------------------------------------------------------------- SQLite + FreeProviderRouter integration tests

test('local xdxr storage enforces PIT cutoff and backfills daily_basic.dv_ttm', () => {
  const db = openAshareDb(':memory:');
  try {
    upsertXdxrEvents(db, '600519.SH', [
      { date: '20251219', category: 1, fenhong: 239.57 },
      { date: '20260626', category: 1, fenhong: 280.2423 },
      { date: '20261201', category: 1, fenhong: 100 }, // future relative to 20261118
    ]);
    upsertXdxrEvents(db, '300999.SZ', []); // explicitly synced with 0 dividends

    const k = loadXdxrKnowledge(db, '20261118');
    assert.equal(k.eventsByCode.get('600519.SH')?.length, 2, 'future event 20261201 must not be loaded');
    assert.ok(k.knownCodes.has('300999.SZ'));

    const basicRows = [
      { ts_code: '600519.SH', trade_date: '20261118', dv_ttm: null },
      { ts_code: '300999.SZ', trade_date: '20261118', dv_ttm: null },
      { ts_code: '920001.BJ', trade_date: '20261118', dv_ttm: null }, // unknown xdxr -> must remain null
      { ts_code: '000001.SZ', trade_date: '20261118', dv_ttm: 4.9714 }, // already populated -> preserved
    ];
    const closes = new Map([
      ['600519.SH', 1480],
      ['300999.SZ', 20],
      ['920001.BJ', 15],
      ['000001.SZ', 12.2],
    ]);
    const filled = backfillDailyBasicDvTtm(db, '20261118', basicRows, closes);
    assert.equal(filled[0].dv_ttm, 3.5122); // (23.957 + 28.02423) / 1480 * 100
    assert.equal(filled[1].dv_ttm, 0);
    assert.equal(filled[2].dv_ttm, null);
    assert.equal(filled[3].dv_ttm, 4.9714);
  } finally {
    db.close();
  }
});

test('freeProviderRouter populates dv_ttm on both live daily sync and historical backfill paths', async () => {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: '20261117', is_open: 1, pretrade_date: '20261116' },
    { cal_date: '20261118', is_open: 1, pretrade_date: '20261117' },
    { cal_date: '20261119', is_open: 1, pretrade_date: '20261118' },
  ]);
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'], [
    { ts_code: '600519.SH', symbol: '600519', name: '贵州茅台', list_date: '20010827', list_status: 'L' },
    { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', list_date: '19910403', list_status: 'L' },
  ]);
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], [
    { ts_code: '600519.SH', trade_date: '20261117', open: 1455, high: 1460, low: 1450, close: 1457.7, pre_close: 1460, pct_chg: -0.15, vol: 35000, amount: 5094594 },
    { ts_code: '000001.SZ', trade_date: '20261117', open: 12.25, high: 12.32, low: 12.11, close: 12.25, pre_close: 12.3, pct_chg: -0.4, vol: 1720412, amount: 2104476 },
  ]);

  const srv = await startMockTdxServer({
    barsByCode: {
      600519: [
        { date: '20261117', open: 1455, high: 1460, low: 1450, close: 1457.7 },
        { date: '20261118', open: 1470, high: 1490, low: 1465, close: 1480 },
      ],
      '000001': [
        { date: '20261117', open: 12.25, high: 12.32, low: 12.11, close: 12.25 },
        { date: '20261118', open: 12.24, high: 12.31, low: 12.03, close: 12.2 },
      ],
    },
    xdxrByCode: {
      600519: [
        { market: 1, code: '600519', date: '20260626', category: 1, fenhong: 280.2423 },
      ],
      '000001': [
        { market: 0, code: '000001', date: '20260612', category: 1, fenhong: 3.6 },
        { market: 0, code: '000001', date: '20260924', category: 1, fenhong: 2.49 },
      ],
    },
  });
  const port = srv.address().port;
  const prevProv = process.env.ASHARE_DATA_PROVIDER;
  const prevHosts = process.env.ASHARE_TDX_HOSTS;
  process.env.ASHARE_DATA_PROVIDER = 'free';
  process.env.ASHARE_TDX_HOSTS = `127.0.0.1:${port}`;
  clearFreeProviderCache();

  // Mock Tencent/EM showing latest date = 20261119 -> 20261119 hits live snapshot, 20261118 hits historical backfill!
  const quotesBySym = new Map([
    ['sh600519', buildTencentLine('sh600519', '贵州茅台', '600519', '20261119', 1480, 1490, 1495, 1475, 1480, 35000, 5000000000, 18500)],
    ['sz000001', buildTencentLine('sz000001', '平安银行', '000001', '20261119', 12.2, 12.3, 12.35, 12.15, 12.2, 1300000, 1600000000, 2367)],
  ]);
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://qt.gtimg.cn/q=')) {
      const syms = u.slice('https://qt.gtimg.cn/q='.length).split(',');
      return new Response(syms.map(s => quotesBySym.get(s) ?? '').filter(Boolean).join('\n'), { status: 200 });
    }
    if (u.startsWith('https://push2.eastmoney.com/api/qt/clist/get')) {
      return new Response(JSON.stringify({ data: { total: 0, diff: [] } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };

  try {
    // 1) Historical backfill (20261118 < observedDate 20261119)
    await syncTradeDate(db, '20261118', 'refresh');
    const histRows = db.prepare("SELECT ts_code, dv_ttm FROM daily_basic WHERE trade_date='20261118' ORDER BY ts_code").all();
    assert.deepEqual(histRows.map(r => [r.ts_code, r.dv_ttm]), [
      ['000001.SZ', 4.9918], // (0.36 + 0.249) / 12.2 * 100
      ['600519.SH', 1.8935], // 28.02423 / 1480 * 100
    ]);

    // 2) Live snapshot (20261119 == observedDate 20261119)
    await syncTradeDate(db, '20261119', 'refresh');
    const liveRows = db.prepare("SELECT ts_code, dv_ttm FROM daily_basic WHERE trade_date='20261119' ORDER BY ts_code").all();
    assert.deepEqual(liveRows.map(r => [r.ts_code, r.dv_ttm]), [
      ['000001.SZ', 4.9512], // 0.609 / 12.3 * 100
      ['600519.SH', 1.8808], // 28.02423 / 1490 * 100
    ]);

    // 3) Cached >= 4000 historical day with previously NULL dv_ttm gets backfilled from local xdxr
    const bulkDaily = Array.from({ length: 4000 }, (_, i) => ({
      ts_code: i === 0 ? '600519.SH' : `688${String(i).padStart(3, '0')}.SH`,
      trade_date: '20261118',
      open: 10, high: 10.1, low: 9.9, close: i === 0 ? 1480 : 10, pre_close: 10, pct_chg: 0, vol: 1000, amount: 10000,
    }));
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], bulkDaily);
    db.exec("UPDATE daily_basic SET dv_ttm = NULL WHERE trade_date = '20261118'");
    clearFreeProviderCache();
    const cachedBasic = await fetchFreeDataset('daily_basic', { trade_date: '20261118' }, db);
    const moutai = cachedBasic.find(r => r.ts_code === '600519.SH');
    assert.equal(moutai?.dv_ttm, 1.8935);
  } finally {
    clearFreeProviderCache();
    globalThis.fetch = originalFetch;
    await new Promise(resolve => srv.close(resolve));
    if (prevProv === undefined) delete process.env.ASHARE_DATA_PROVIDER;
    else process.env.ASHARE_DATA_PROVIDER = prevProv;
    if (prevHosts === undefined) delete process.env.ASHARE_TDX_HOSTS;
    else process.env.ASHARE_TDX_HOSTS = prevHosts;
    db.close();
  }
});
