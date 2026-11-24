import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { syncTradeDate, syncIndexDaily, checkQuality } = await import('../build/ashare/ingest.js');
const { syncRange } = await import('../build/ashare/sync.js');
const { syncEtfForDaily, resolveFundNavPremium } = await import('../build/ashare/etf.js');
const {
  decodeTdxVarint,
  decodeTdxVolume,
  decodeTdxDateTime,
  parseSecurityListPayload,
  parseBarsPayload,
  parseXdxrPayload,
} = await import('../build/ashare/providers/tdxClient.js');
const { parseTencentQuoteLine } = await import('../build/ashare/providers/tencentClient.js');
const { resolveDataProviderMode, computeDefaultLimitPrices } = await import('../build/ashare/providers/types.js');
const { clearFreeProviderCache, STATIC_CLOSED_WEEKDAYS } = await import('../build/ashare/providers/freeProviderRouter.js');

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

test('resolveDataProviderMode honors explicit override and auto token detection', () => {
  const prevProv = process.env.ASHARE_DATA_PROVIDER;
  const prevTok = process.env.TUSHARE_TOKEN;
  try {
    process.env.ASHARE_DATA_PROVIDER = 'free';
    process.env.TUSHARE_TOKEN = 'expired-token';
    assert.equal(resolveDataProviderMode(), 'free');

    process.env.ASHARE_DATA_PROVIDER = 'tushare';
    assert.equal(resolveDataProviderMode(), 'tushare');

    delete process.env.ASHARE_DATA_PROVIDER;
    process.env.TUSHARE_TOKEN = 'test-token';
    assert.equal(resolveDataProviderMode(), 'tushare');

    process.env.TUSHARE_TOKEN = '';
    assert.equal(resolveDataProviderMode(), 'free');
  } finally {
    if (prevProv === undefined) delete process.env.ASHARE_DATA_PROVIDER;
    else process.env.ASHARE_DATA_PROVIDER = prevProv;
    if (prevTok === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = prevTok;
  }
});

test('TDX binary decoders: varint, volume float, datetime, security list, bars, xdxr', () => {
  for (const n of [0, 1, -1, 63, -63, 64, -64, 1220, -1220, 398377, -51234]) {
    const buf = encodeTdxVarint(n);
    const [decoded, nextPos] = decodeTdxVarint(buf, 0);
    assert.equal(decoded, n, `varint roundtrip ${n}`);
    assert.equal(nextPos, buf.length);
  }

  assert.equal(decodeTdxVolume(0), 0);
  // Real captured vol/amount encoding check: 0x4e0c0978 ~ 1727920128 or standard positive monotonicity
  assert.ok(decodeTdxVolume(0x520d5210) > decodeTdxVolume(0x4e0c0978));

  // Daily datetime category=9 (YYYYMMDD uint32) vs 5-min datetime category=0
  const dBuf = Buffer.alloc(4);
  dBuf.writeUInt32LE(20261118, 0);
  assert.equal(decodeTdxDateTime(9, dBuf, 0).dateYmd, '20261118');

  const m5Buf = Buffer.alloc(4);
  const zipday = ((2026 - 2004) << 11) + 1118;
  m5Buf.writeUInt16LE(zipday, 0);
  m5Buf.writeUInt16LE(14 * 60 + 55, 2);
  const dt5 = decodeTdxDateTime(0, m5Buf, 0);
  assert.equal(dt5.dateYmd, '20261118');
  assert.equal(dt5.hour, 14);
  assert.equal(dt5.minute, 55);

  // parseBarsPayload: daily bar (12.24 open, 12.31 high, 12.03 low, 12.20 close)
  const barBuf = Buffer.concat([
    Buffer.from([1, 0]),
    dBuf,
    encodeTdxVarint(12240),
    encodeTdxVarint(-40),
    encodeTdxVarint(70),
    encodeTdxVarint(-210),
    Buffer.from('00000000', 'hex'),
    Buffer.from('00000000', 'hex'),
  ]);
  const bars = parseBarsPayload(barBuf, 9, false);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].trade_date, '20261118');
  assert.equal(bars[0].open, 12.24);
  assert.equal(bars[0].high, 12.31);
  assert.equal(bars[0].low, 12.03);
  assert.equal(bars[0].close, 12.2);

  // parseSecurityListPayload
  const itemBuf = Buffer.alloc(2 + 29);
  itemBuf.writeUInt16LE(1, 0);
  Buffer.from('000001', 'ascii').copy(itemBuf, 2);
  itemBuf.writeUInt16LE(100, 8);
  Buffer.from('PINGAN\0\0', 'ascii').copy(itemBuf, 10);
  itemBuf.writeUInt8(2, 22);
  itemBuf.writeUInt32LE(0, 23);
  const list = parseSecurityListPayload(itemBuf, 0);
  assert.equal(list.length, 1);
  assert.equal(list[0].code, '000001');
  assert.equal(list[0].decimalPoint, 2);

  // parseXdxrPayload
  const xdBuf = Buffer.alloc(11 + 29);
  xdBuf.writeUInt16LE(1, 9);
  xdBuf.writeUInt8(0, 11);
  Buffer.from('000001', 'ascii').copy(xdBuf, 12);
  xdBuf.writeUInt32LE(20260618, 19);
  xdBuf.writeUInt8(1, 23);
  xdBuf.writeFloatLE(2.5, 24); // fenhong 2.5 per 10 shares
  const xd = parseXdxrPayload(xdBuf);
  assert.equal(xd.length, 1);
  assert.equal(xd[0].date, '20260618');
  assert.equal(xd[0].fenhong, 2.5);
});

test('Tencent GBK quote parser maps stock, ETF, BJ units accurately and falls back limit prices', () => {
  const fields = new Array(60).fill('');
  fields[1] = '半导体设备ETF';
  fields[2] = '159558';
  fields[3] = '0.823';
  fields[4] = '0.809';
  fields[5] = '0.818';
  fields[6] = '19992687';
  fields[30] = '20261118161433';
  fields[31] = '0.014';
  fields[32] = '1.73';
  fields[33] = '0.835';
  fields[34] = '0.788';
  fields[35] = '0.823/19992687/1623668480';
  fields[37] = '162367';
  fields[38] = '10.34';
  fields[44] = '159.15';
  fields[45] = '159.15';
  fields[46] = '0.00';
  fields[47] = '0.890';
  fields[48] = '0.728';
  fields[49] = '1.05';

  const row = parseTencentQuoteLine(`v_sz159558="${fields.join('~')}";`);
  assert.ok(row);
  assert.equal(row.ts_code, '159558.SZ');
  assert.equal(row.trade_date, '20261118');
  assert.equal(row.vol, 19992687);
  assert.equal(row.amount, 1623668.48); // 元 -> 千元
  assert.equal(row.circ_mv, 1591500); // 亿元 -> 万元
  assert.equal(row.up_limit, 0.89);
  assert.equal(row.down_limit, 0.728);

  const bjLim = computeDefaultLimitPrices(10.6, '920000.BJ', '安徽凤凰');
  assert.equal(bjLim.up_limit, 13.78);
  assert.equal(bjLim.down_limit, 7.42);
});

function startMockTdxServer() {
  const frame = (payload) => {
    const z = deflateSync(payload);
    const hdr = Buffer.alloc(16);
    hdr.writeUInt32LE(0x01, 0);
    hdr.writeUInt16LE(z.length, 12);
    hdr.writeUInt16LE(payload.length, 14);
    return Buffer.concat([hdr, z]);
  };
  const srv = net.createServer(sock => {
    sock.on('data', chunk => {
      // Check command bytes inside pkt header (bytes 10..12 LE)
      if (chunk.length === 13 && chunk[10] === 0x0d) {
        sock.write(frame(Buffer.from('ok')));
        return;
      }
      const cmd = chunk.readUInt16LE(10);
      if (cmd === 0x044e) {
        // getSecurityCount
        const out = Buffer.alloc(2);
        const mkt = chunk.readUInt16LE(12);
        out.writeUInt16LE(mkt === 0 ? 1 : 0, 0);
        sock.write(frame(out));
      } else if (cmd === 0x0450) {
        // getSecurityList
        const out = Buffer.alloc(2 + 29);
        out.writeUInt16LE(1, 0);
        Buffer.from('000001', 'ascii').copy(out, 2);
        out.writeUInt16LE(100, 8);
        Buffer.from('PINGAN\0\0', 'ascii').copy(out, 10);
        out.writeUInt8(2, 22);
        sock.write(frame(out));
      } else if (cmd === 0x052d) {
        // getBars for 20261118
        const isIdx = chunk.subarray(14, 20).toString('ascii') === '000300';
        const dBuf = Buffer.alloc(4);
        dBuf.writeUInt32LE(20261118, 0);
        const tail = isIdx ? Buffer.alloc(12) : Buffer.alloc(8);
        const out = Buffer.concat([
          Buffer.from([1, 0]),
          dBuf,
          encodeTdxVarint(isIdx ? 3980000 : 12240),
          encodeTdxVarint(isIdx ? 3770 : -40),
          encodeTdxVarint(isIdx ? 11160 : 70),
          encodeTdxVarint(isIdx ? -31500 : -210),
          tail,
        ]);
        sock.write(frame(out));
      } else {
        sock.write(frame(Buffer.alloc(4)));
      }
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
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
  f[32] = String((((close - pre) / pre) * 100).toFixed(2));
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

function installHttpMock(today, options = {}) {
  const prev = '20261117';
  const stocks = [
    { ts: '000001.SZ', sym: 'sz000001', code: '000001', name: '平安银行', o: 12.24, c: 12.2, h: 12.31, l: 12.03, p: 12.25, v: 1362498, a: 1660573146, circ: 2367 },
    { ts: '600519.SH', sym: 'sh600519', code: '600519', name: '贵州茅台', o: 1460, c: 1480, h: 1485, l: 1455, p: 1480, v: 35000, a: 5000000000, circ: 18500 },
    { ts: '000635.SZ', sym: 'sz000635', code: '000635', name: '英力特', o: 0, c: 9.5, h: 0, l: 0, p: 9.5, v: 0, a: 0, circ: 30 },
  ];
  const etfs = [
    { ts: '159241.SZ', sym: 'sz159241', code: '159241', name: '航空航天ETF', o: 1.01, c: 1.02, h: 1.03, l: 1.0, p: 1.0, v: 500000, a: 51000000, circ: 15 },
    { ts: '159278.SZ', sym: 'sz159278', code: '159278', name: '机器人ETF', o: 1.11, c: 1.12, h: 1.13, l: 1.1, p: 1.1, v: 600000, a: 67000000, circ: 20 },
    { ts: '159558.SZ', sym: 'sz159558', code: '159558', name: '半导体设备ETF', o: 0.818, c: 0.823, h: 0.835, l: 0.788, p: 0.809, v: 19992687, a: 1623668480, circ: 159.15 },
    { ts: '516080.SH', sym: 'sh516080', code: '516080', name: '创新药ETF', o: 0.71, c: 0.72, h: 0.73, l: 0.7, p: 0.71, v: 400000, a: 28800000, circ: 18 },
    { ts: '560390.SH', sym: 'sh560390', code: '560390', name: '电网设备ETF', o: 1.21, c: 1.22, h: 1.23, l: 1.2, p: 1.2, v: 300000, a: 36600000, circ: 12 },
    { ts: '513100.SH', sym: 'sh513100', code: '513100', name: '纳指ETF', o: 2.166, c: 2.167, h: 2.174, l: 2.163, p: 2.166, v: 561940, a: 121800808, circ: 209.87 },
  ];
  const indices = [
    { ts: '000001.SH', sym: 'sh000001', code: '000001', base: 3300 },
    { ts: '399001.SZ', sym: 'sz399001', code: '399001', base: 10500 },
    { ts: '000300.SH', sym: 'sh000300', code: '000300', base: 3983.77 },
  ];

  const allQuotes = new Map();
  for (const s of [...stocks, ...etfs]) {
    allQuotes.set(s.sym, buildTencentLine(s.sym, s.name, s.code, today, s.o, s.c, s.h, s.l, s.p, s.v, s.a, s.circ));
  }
  for (const idx of indices) {
    allQuotes.set(idx.sym, buildTencentLine(idx.sym, 'INDEX', idx.code, today, idx.base, idx.base, idx.base, idx.base, idx.base, 1000000, 1000000000, 1000));
  }

  globalThis.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://qt.gtimg.cn/q=')) {
      if (options.failTencent) return new Response('err', { status: 500 });
      const syms = u.slice('https://qt.gtimg.cn/q='.length).split(',');
      const lines = syms.map(s => allQuotes.get(s) ?? '').filter(Boolean).join('\n');
      return new Response(Buffer.from(lines, 'utf8'), { status: 200 });
    }
    if (u.startsWith('https://push2.eastmoney.com/api/qt/clist/get')) {
      const isFund = u.includes('MK0021');
      const items = (isFund ? etfs : stocks).map(s => ({
        f2: s.c, f3: 1.2, f4: 0.1, f5: s.v, f6: s.a, f8: 1.1, f10: 1.0,
        f12: s.code, f13: s.ts.endsWith('.SH') ? 1 : 0, f14: s.name,
        f15: s.h, f16: s.l, f17: s.o, f18: s.p, f20: s.circ * 1e8, f21: s.circ * 1e8,
        f23: 1.5, f26: 20200101, f100: '银行', f115: 10.5, f124: Math.floor(Date.parse('2026-11-18T15:00:00+08:00') / 1000), f130: 2.0,
      }));
      return new Response(JSON.stringify({ data: { total: items.length, diff: items } }), { status: 200 });
    }
    if (u.startsWith('https://push2his.eastmoney.com/api/qt/stock/kline/get')) {
      const isoPrev = `${prev.slice(0, 4)}-${prev.slice(4, 6)}-${prev.slice(6, 8)}`;
      const isoToday = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
      return new Response(JSON.stringify({
        data: {
          klines: [
            `${isoPrev},3970,3976.46,3985,3942,179262855,409477157763.40,1.0,-0.08,-3.34,0.5`,
            `${isoToday},3991.16,3983.77,3991.16,3948.50,167318271,389913837568.00,1.0,0.18,7.31,0.5`,
          ],
        },
      }), { status: 200 });
    }
    if (u.startsWith('https://api.fund.eastmoney.com/f10/lsjz')) {
      return new Response(JSON.stringify({
        Data: {
          LSJZList: [{
            FSRQ: `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`,
            DWJZ: '2.1670', LJJZ: '9.3435',
          }],
        },
      }), { status: 200 });
    }
    if (u.startsWith('https://datacenter-web.eastmoney.com/api/data/v1/get')) {
      return new Response(JSON.stringify({
        result: {
          pages: 1,
          data: [{
            SECUCODE: '000001.SZ',
            NOTICE_DATE: '2026-10-24 00:00:00',
            REPORTDATE: '2026-09-30 00:00:00',
            BASIC_EPS: 1.94,
            WEIGHTAVG_ROE: 8.07,
            YSTZ: 2.4,
            SJLTZ: 2.2,
            XSMLL: 30,
            MGJYXJJE: 14.59,
            PARENT_NETPROFIT: 1000,
            DEBT_ASSET_RATIO: 90.6,
            NETCASH_OPERATE: 6045,
          }],
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in free provider test: ${u}`);
  };
}

function seedBaselineDay(db, prevDay, today) {
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: prevDay, is_open: 1, pretrade_date: '20261116' },
    { cal_date: today, is_open: 1, pretrade_date: prevDay },
  ]);
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'], [
    { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', list_date: '19910403', list_status: 'L' },
    { ts_code: '600519.SH', symbol: '600519', name: '贵州茅台', list_date: '20010827', list_status: 'L' },
    { ts_code: '000635.SZ', symbol: '000635', name: '英力特', list_date: '19961120', list_status: 'L' },
  ]);
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], [
    { ts_code: '000001.SZ', trade_date: prevDay, open: 12.25, high: 12.32, low: 12.11, close: 12.25, pre_close: 12.3, pct_chg: -0.4, vol: 1720412, amount: 2104476 },
    { ts_code: '600519.SH', trade_date: prevDay, open: 1455, high: 1460, low: 1450, close: 1457.7, pre_close: 1460, pct_chg: -0.15, vol: 35000, amount: 5094594 },
  ]);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [
    { ts_code: '000001.SZ', trade_date: prevDay, adj_factor: 142.0699 },
    // 600519 pre_close on today is 1480 vs 1457.7? Let's test non-ex-dividend for 000001 and ex-dividend for 600519
    { ts_code: '600519.SH', trade_date: prevDay, adj_factor: 100.0 },
  ]);
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'market', 'status'], [
    { ts_code: '159558.SZ', name: '半导体设备ETF', market: 'E', status: 'L' },
    { ts_code: '513100.SH', name: '纳指ETF', market: 'E', status: 'L' },
  ]);
  upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'], [
    { ts_code: '159558.SZ', trade_date: prevDay, open: 0.8, high: 0.82, low: 0.79, close: 0.809, pre_close: 0.8, change: 0.009, pct_chg: 1.1, vol: 100000, amount: 80000 },
  ]);
  upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [
    { ts_code: '159558.SZ', trade_date: prevDay, adj_factor: 3 },
  ]);
}

test('FreeProviderRouter drives syncRange + syncEtfForDaily to READY and preserves adj_factor chaining', async () => {
  const db = openAshareDb(':memory:');
  const { openEtfSchema } = await import('../build/ashare/schemaCheck.js').catch(() => ({ openEtfSchema: null }));
  void openEtfSchema;
  // Seed fund tables schema via etf migrate DDL or sync_log creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS fund_basic (ts_code TEXT PRIMARY KEY, name TEXT, management TEXT, custodian TEXT, fund_type TEXT, found_date TEXT, due_date TEXT, list_date TEXT, issue_date TEXT, delist_date TEXT, issue_amount REAL, m_fee REAL, c_fee REAL, benchmark TEXT, status TEXT, invest_type TEXT, type TEXT, market TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS fund_daily (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, pre_close REAL, change REAL, pct_chg REAL, vol REAL, amount REAL, PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fund_adj (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, adj_factor REAL, PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fund_share (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, fd_share REAL, fund_type TEXT, market TEXT, PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fund_nav (ts_code TEXT NOT NULL, ann_date TEXT, nav_date TEXT NOT NULL, unit_nav REAL, accum_nav REAL, adj_nav REAL, PRIMARY KEY (ts_code, nav_date));
    CREATE TABLE IF NOT EXISTS fund_sync_log (dataset TEXT NOT NULL, key TEXT NOT NULL, rows INTEGER NOT NULL, status TEXT NOT NULL, message TEXT, synced_at TEXT NOT NULL, PRIMARY KEY (dataset, key)) WITHOUT ROWID;
  `);

  const today = '20261118';
  seedBaselineDay(db, '20261117', today);

  const srv = await startMockTdxServer();
  const port = srv.address().port;
  const prevProv = process.env.ASHARE_DATA_PROVIDER;
  const prevHosts = process.env.ASHARE_TDX_HOSTS;
  process.env.ASHARE_DATA_PROVIDER = 'free';
  process.env.ASHARE_TDX_HOSTS = `127.0.0.1:${port}`;
  clearFreeProviderCache();
  installHttpMock(today);

  try {
    await syncRange(db, today, today, { refreshFrom: today, skipCalendar: true });
    const q = checkQuality(db, today, false);
    assert.equal(q.status, 'READY', JSON.stringify(q.reasons));

    // Suspended stock 000635.SZ must be in suspend_d and NOT in daily
    assert.equal(db.prepare("SELECT COUNT(*) n FROM daily WHERE ts_code='000635.SZ' AND trade_date=?").get(today).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM suspend_d WHERE ts_code='000635.SZ' AND trade_date=?").get(today).n, 1);

    // 000001.SZ adj_factor keeps 142.0699 (pre_close 12.25 == prevClose 12.25); 600519 chains ratio 1457.7/1480
    const adj000001 = db.prepare("SELECT adj_factor FROM adj_factor WHERE ts_code='000001.SZ' AND trade_date=?").get(today).adj_factor;
    assert.equal(adj000001, 142.0699);
    const adj600519 = db.prepare("SELECT adj_factor FROM adj_factor WHERE ts_code='600519.SH' AND trade_date=?").get(today).adj_factor;
    assert.ok(Math.abs(adj600519 - 100 * (1457.7 / 1480)) < 0.01, `adj600519=${adj600519}`);

    // ETF sync: all 5 holdings READY, fund_adj chains 3.0, fund_nav resolves cross_border premium
    const etfRes = await syncEtfForDaily(db, today, { refreshFrom: today, days: 2 });
    assert.deepEqual(etfRes.coverage[today].missing, []);
    const adj159558 = db.prepare("SELECT adj_factor FROM fund_adj WHERE ts_code='159558.SZ' AND trade_date=?").get(today).adj_factor;
    assert.equal(adj159558, 3);
    const nav513100 = resolveFundNavPremium(db, '513100.SH', 2.167, today, 'cross_border');
    assert.equal(nav513100.unit_nav, 2.167);
    assert.equal(nav513100.buy_blocked, false);

    // Fallback test when BOTH TDX TCP AND Tencent are down -> Eastmoney cross section still drives READY
    clearFreeProviderCache();
    process.env.ASHARE_TDX_HOSTS = '127.0.0.1:1';
    installHttpMock(today, { failTencent: true });
    await syncTradeDate(db, today, 'refresh');
    await syncIndexDaily(db, today, today, today);
    const qFallback = checkQuality(db, today, false);
    assert.equal(qFallback.status, 'READY', JSON.stringify(qFallback.reasons));
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

test('2027 State Council holiday weekdays are in the static closed table', () => {
  // 国办发明电〔2026〕10号：只列周一至周五休市日；调休上班的周六/周日由周末规则关闭。
  const closedWeekdays = [
    '20270101',
    '20270205', '20270208', '20270209', '20270210', '20270211', '20270212',
    '20270405',
    '20270503', '20270504', '20270505',
    '20270609',
    '20270915',
    '20271001', '20271004', '20271005', '20271006', '20271007',
  ];
  for (const date of closedWeekdays) {
    const day = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay();
    assert.ok(day >= 1 && day <= 5, `${date} should be a weekday`);
    assert.ok(STATIC_CLOSED_WEEKDAYS.has(date), `${date} must be statically closed`);
  }
  for (const date of ['20270131', '20270214', '20270508', '20270926', '20271009']) {
    const day = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay();
    assert.ok(day === 0 || day === 6, `${date} is a weekend makeup day; weekends are closed by isWeekend`);
  }
});
