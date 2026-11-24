import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-fix-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, openResearchDb, upsertRows, getAshareDb, closeAshareDb } = await import('../build/ashare/db.js');
const { syncTradeDate, checkQuality } = await import('../build/ashare/ingest.js');
const { syncRange } = await import('../build/ashare/sync.js');
const { generateReport, latestReportMeta } = await import('../build/ashare/report.js');
const { evaluateWatchlist, computeEvidence, loadVerdicts } = await import('../build/ashare/evidence.js');
const { scanMarket } = await import('../build/ashare/analysis.js');
const { forEachStockBars } = await import('../build/ashare/bars.js');
const { acceptance, acceptanceDay } = await import('../build/ashare/acceptance.js');
const { runCommand } = await import('../build/ashare/commands.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { seedMarket, addMarketDays, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const DATES = weekdays('20260105', 150);
const FUTURE = weekdays('20260105', 160).slice(150);

function helpers(args) {
  const out = [];
  return {
    out,
    h: {
      arg: name => args[name],
      flag: name => args[name] === true,
      ymd: v => v,
      print: v => out.push(v),
    },
  };
}

// ---------------------------------------------------------------- Tushare mock

/** Serve whole-market responses from `tables[api][trade_date]`, with offset pagination. */
function mockTushare(tables) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const { api_name: api, params, fields } = body;
    calls.push({ api, ...params });
    let rows = [];
    if (api === 'trade_cal') rows = tables.trade_cal ?? [];
    else if (api === 'stock_basic') rows = params.list_status === 'L' ? (tables.stock_basic ?? []) : [];
    else if (api === 'index_daily') rows = [];
    else rows = typeof tables[api]?.[params.trade_date] === 'function' ? tables[api][params.trade_date]() : (tables[api]?.[params.trade_date] ?? []);
    const cols = fields ? fields.split(',') : Object.keys(rows[0] ?? {});
    const page = rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
  return calls;
}

const D0 = '20261015';
const D1 = '20261016';
const quote = (i, date, close = 10) => ({ ts_code: `${600000 + i}.SH`, trade_date: date, open: close, high: close, low: close, close, pre_close: close, pct_chg: 0, vol: 1, amount: 1, adj_factor: 1, up_limit: 11, down_limit: 9, turnover_rate: 1 });
const day = (date, n, close) => Array.from({ length: n }, (_, i) => quote(i, date, close?.(i)));
const allApis = rows => ({ daily: rows, daily_basic: rows, adj_factor: rows, stk_limit: rows });

test('P0-1: a second daily run re-queries the as-of day and replaces revised data', async () => {
  const originalFetch = globalThis.fetch;
  const db = openAshareDb(':memory:');
  try {
    // 18:40 response: 97 of 100 stocks (passes the 97% rule) plus a row Tushare later withdraws.
    const first = [...day(D1, 97), quote(999, D1, 5)];
    // 21:10 response: all 100 stocks; stock 0 has a revised close.
    const second = day(D1, 100, i => (i === 0 ? 12.34 : 10));
    let response = first;
    const tables = {
      trade_cal: [{ cal_date: D0, is_open: 1, pretrade_date: null }, { cal_date: D1, is_open: 1, pretrade_date: D0 }],
      stock_basic: [],
    };
    for (const api of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) tables[api] = { [D0]: day(D0, 100), [D1]: () => response };
    const calls = mockTushare(tables);

    const run1 = await syncRange(db, D0, D1, { refreshFrom: D1, fina: false });
    assert.deepEqual(run1.refreshed, [D1]);
    assert.equal(run1.datasets[D1].daily.rows, 98);
    assert.equal(run1.datasets[D1].daily.status, 'ok');

    // The old behaviour (skip a date already marked ok) would never see the revision.
    const skipped = await syncTradeDate(db, D1, 'skip_ok');
    assert.equal(skipped.daily.fetched, false);

    response = second;
    const before = calls.filter(c => c.api === 'daily' && c.trade_date === D1).length;
    const run2 = await syncRange(db, D0, D1, { refreshFrom: D1, fina: false });
    assert.equal(calls.filter(c => c.api === 'daily' && c.trade_date === D1).length, before + 1, 'second run fetched the as-of day again');
    assert.equal(calls.filter(c => c.api === 'daily' && c.trade_date === D0).length, 1, 'older complete days are not re-downloaded');
    assert.equal(run2.datasets[D1].daily.write, 'replaced');
    assert.equal(db.prepare('SELECT close FROM daily WHERE ts_code = ? AND trade_date = ?').get('600000.SH', D1).close, 12.34);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM daily WHERE ts_code = ? AND trade_date = ?').get('600999.SH', D1).n, 0, 'withdrawn row removed');

    // A third run with identical data: no duplicates, same counts, still ok.
    await syncRange(db, D0, D1, { refreshFrom: D1, fina: false });
    for (const table of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE trade_date = ?`).get(D1).n, 100, table);
      assert.equal(db.prepare('SELECT status FROM sync_log WHERE dataset = ? AND key = ?').get(table, D1).status, 'ok');
    }
    const history = db.prepare("SELECT COUNT(*) n FROM sync_history WHERE dataset = 'daily' AND key = ?").get(D1).n;
    assert.equal(history, 3, 'every fetch of the as-of day is kept for audit');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('P0-1: an incomplete first response is completed later; a short refresh never shrinks data', async () => {
  const originalFetch = globalThis.fetch;
  const db = openAshareDb(':memory:');
  try {
    upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: D0, is_open: 1 }, { cal_date: D1, is_open: 1, pretrade_date: D0 }]);
    let response = day(D1, 50);
    mockTushare({ ...Object.fromEntries(Object.entries(allApis(null)).map(([k]) => [k, { [D0]: day(D0, 100), [D1]: () => response }])) });
    await syncTradeDate(db, D0, 'refresh');

    const first = await syncTradeDate(db, D1, 'refresh');
    assert.equal(first.daily.status, 'partial');
    assert.equal(checkQuality(db, D1, false).status, 'NOT_READY');

    response = day(D1, 100);
    const second = await syncTradeDate(db, D1, 'skip_ok'); // partial dates are fetched again even without refresh
    assert.equal(second.daily.fetched, true);
    assert.equal(second.daily.status, 'ok');
    assert.equal(second.daily.rows, 100);

    // A stale extra row (stored 101, Tushare now answers 100) is removed by a complete refresh.
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'close'], [{ ts_code: '688999.SH', trade_date: D1, close: 1 }]);
    const cleaned = await syncTradeDate(db, D1, 'refresh');
    assert.equal(cleaned.daily.write, 'replaced');
    assert.equal(cleaned.daily.rows, 100);

    response = day(D1, 40); // transient short answer on a later refresh
    const third = await syncTradeDate(db, D1, 'refresh');
    assert.equal(third.daily.write, 'kept');
    assert.equal(third.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.equal(third.daily.rows, 100);
    assert.equal(third.daily.status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

// ---------------------------------------------------------------- live market fixture

const live = openAshareDb();
seedMarket(live, DATES);
const LIVE_DAYS = DATES.slice(-5);
for (const d of LIVE_DAYS) generateReport(live, d, 'live');

function snapshot(db) {
  return {
    watchlist: db.prepare('SELECT * FROM watchlist ORDER BY trade_date, ts_code').all(),
    changes: db.prepare('SELECT * FROM watchlist_change ORDER BY trade_date, ts_code, action').all(),
    scores: db.prepare('SELECT trade_date, COUNT(*) n FROM stock_score GROUP BY trade_date').all(),
    reports: db.prepare('SELECT * FROM report ORDER BY report_id').all(),
    latest: LIVE_DAYS.map(d => readFileSync(join(dir, 'reports', d, 'latest.json'), 'utf8')),
  };
}

test('P0-2: replay and back-dated reports never touch live watchlists or reports', async () => {
  const before = snapshot(live);
  const latestBefore = latestReportMeta(live);
  assert.equal(latestBefore.trade_date, LIVE_DAYS.at(-1));

  // Replay over a range that overlaps the live days.
  const replay = helpers({ start: DATES.at(-20), end: DATES.at(-2) });
  await runCommand(live, 'replay', replay.h);
  assert.equal(replay.h && replay.out[0].space, 'research');
  assert.equal(replay.out[0].reports.length, 19);

  // Manual report for a date that already has later live days goes to research.
  const manual = helpers({ date: LIVE_DAYS[1] });
  await runCommand(live, 'report', manual.h);
  assert.equal(manual.out[0].space, 'research');

  assert.deepEqual(snapshot(live), before, 'live watchlist, changes, scores, reports and latest.json unchanged');
  assert.equal(latestReportMeta(live).report_id, latestBefore.report_id);

  const research = openResearchDb();
  try {
    assert.ok(research.prepare('SELECT COUNT(*) n FROM report').get().n >= 20);
    assert.equal(research.prepare("SELECT COUNT(*) n FROM main.report WHERE run_mode = 'live'").get().n, 0);
    assert.throws(() => research.exec("DELETE FROM live.watchlist"), /readonly/);
    const r = research.prepare('SELECT path FROM report LIMIT 1').get();
    assert.match(r.path, /^research\/reports\//);
  } finally {
    research.close();
  }

  // The next live day continues from the last live list, not from the replay.
  const next = weekdays('20260105', 151).at(-1);
  addMarketDays(live, [next], weekdays('20260105', 151));
  const { report } = generateReport(live, next, 'live');
  assert.equal(report.watchlist.previous_date, LIVE_DAYS.at(-1));
  const prevCount = live.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(LIVE_DAYS.at(-1)).n;
  assert.equal(report.watchlist.count, prevCount + report.watchlist.added.length - report.watchlist.removed.length);
  LIVE_DAYS.push(next);
});

test('fix2 P0-1: report for the latest live date, an older date and an unseen date all stay in research', async () => {
  const last = LIVE_DAYS.at(-1);
  const servedBefore = (await runAshareTool('ashare_daily_report', { date: last, format: 'json' })).content[0].text;
  const before = snapshot(live);
  for (const date of [last, LIVE_DAYS[0], DATES[140]]) {
    const run = helpers({ date });
    await runCommand(live, 'report', run.h);
    assert.equal(run.out[0].space, 'research', date);
    assert.equal(run.out[0].run_mode, 'manual');
    assert.match(run.out[0].path, /research[\\/]reports/);
  }
  assert.deepEqual(snapshot(live), before, 'live watchlist, changes, scores, reports and latest.json unchanged');
  assert.equal(latestReportMeta(live, last).run_mode, 'live');
  closeAshareDb();
  const servedAfter = (await runAshareTool('ashare_daily_report', { date: last, format: 'json' })).content[0].text;
  assert.equal(JSON.parse(servedAfter).report_id, JSON.parse(servedBefore).report_id, 'MCP still serves the live report');
  closeAshareDb();
  // Only the daily pipeline may write live state.
  assert.throws(() => generateReport(live, last, 'manual'), /研究库/);
  assert.throws(() => generateReport(live, last, 'replay'), /研究库/);
  // The next live day still continues from the last live list.
  const all = weekdays('20260105', 152);
  addMarketDays(live, [all.at(-1)], all);
  const { report } = generateReport(live, all.at(-1), 'live');
  assert.equal(report.watchlist.previous_date, last);
  const prevCount = live.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(last).n;
  assert.equal(report.watchlist.count, prevCount + report.watchlist.added.length - report.watchlist.removed.length);
  LIVE_DAYS.push(all.at(-1));
});

test('P1-1: the latest report is ordered by trade date and prefers live over replay', () => {
  const db = openAshareDb(':memory:');
  const ins = db.prepare('INSERT INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)');
  ins.run('live-16', '20261016', 'READY', '2026-10-16T21:10:00+08:00', 'x', 'live');
  ins.run('replay-15', '20261015', 'READY', '2026-10-17T00:33:00+08:00', 'x', 'replay');
  ins.run('replay-16', '20261016', 'READY', '2026-10-17T00:40:00+08:00', 'x', 'replay');
  ins.run('legacy-14', '20261014', 'READY', '2026-10-18T00:00:00+08:00', 'x', null);
  // A manual report left in an older live database, generated after the live one, does not win.
  ins.run('manual-16', '20261016', 'READY', '2026-10-17T09:00:00+08:00', 'x', 'manual');
  ins.run('manual-14', '20261014', 'READY', '2026-10-17T09:00:00+08:00', 'x', 'manual');
  assert.equal(latestReportMeta(db, '20261014').report_id, 'manual-14', 'manual ranks above rows without run_mode');
  assert.equal(latestReportMeta(db).report_id, 'live-16');
  assert.equal(latestReportMeta(db, '20261016').report_id, 'live-16');
  assert.equal(latestReportMeta(db, undefined, true, '20261015').report_id, 'replay-15');
  db.close();
});

test('P0-3: pool evaluation and evidence are strictly as of the report date', () => {
  const end = LIVE_DAYS.at(-1);
  const start = LIVE_DAYS[0];
  const asOf = evaluateWatchlist(live, start, end, 2, 10);
  assert.ok(asOf.pending_dates > 0, 'some pool dates have windows that end after `end`');
  const all = weekdays('20260105', 165);
  assert.ok(asOf.per_date.length > 0);
  assert.ok(asOf.per_date.every(d => all.indexOf(d.trade_date) + 2 <= all.indexOf(end)), 'only windows realised by `end`');

  // New market data after `end` must not change the as-of figures.
  addMarketDays(live, all.slice(152), all);
  assert.deepEqual(evaluateWatchlist(live, start, end, 2, 10), asOf);

  // Evidence computed through a later date is not shown as known to an earlier report.
  computeEvidence(live, DATES[0], all.at(-1));
  const later = loadVerdicts(live, all.at(-1));
  assert.equal(later.meta.usable_as_of, true);
  const early = loadVerdicts(live, DATES.at(-10));
  assert.equal(early.meta.usable_as_of, false);
  for (const v of early.verdicts.values()) {
    assert.equal(v.classification, 'research_only');
    assert.match(v.basis, /晚于/);
  }
  const research = openResearchDb();
  try {
    const { report } = generateReport(research, DATES.at(-10), 'replay');
    assert.equal(report.signals.evidence_window.usable_as_of, false);
    assert.ok(report.signals.market_summary.every(s => s.evidence === 'research_only'));
    assert.match(report.signals.evidence_scope.meaning, /样本内方向性证据/);
  } finally {
    research.close();
  }
});

test('P1-3: a stock with missing adjustment factors gets no score and no signals', () => {
  const db = openAshareDb(':memory:');
  seedMarket(db, DATES);
  const victim = STOCKS[3].ts_code;
  db.prepare('DELETE FROM adj_factor WHERE ts_code = ? AND trade_date = ?').run(victim, DATES[100]);
  let missing;
  forEachStockBars(db, DATES[0], DATES.at(-1), (_c, b) => { missing = b.adjMissing; }, [victim]);
  assert.equal(missing, 1);
  const row = scanMarket(db, DATES.at(-1)).rows.find(r => r.ts_code === victim);
  assert.equal(row.eligible, false);
  assert.match(row.ineligible_reason, /复权因子缺失/);
  assert.deepEqual(row.signals, []);
  assert.ok(row.risk_flags.some(f => /复权因子缺失/.test(f)));
  db.close();
});

// ---------------------------------------------------------------- acceptance

/**
 * One synthetic live day. `runs` are [Beijing HH:MM, status, run_mode?,
 * generated_at?]; `fetches` are [Beijing HH:MM, refresh_status, rows?].
 * The optional explicit generated_at models a next-day catch-up.
 */
function fakeLiveDay(db, date, runs = [], fetches = []) {
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  mkdirSync(join(dir, 'reports', date), { recursive: true });
  runs.forEach(([time, status, mode = 'live', generatedAt], i) => {
    const id = `ASR-${date}-${i}-${mode}`;
    const at = generatedAt ?? `${d}T${time}:00.000+08:00`;
    const path = join('reports', date, `${id}.json`);
    writeFileSync(join(dir, path), JSON.stringify({
      report_id: id, run_mode: mode, status, generated_at: at,
      data: { quality: { reasons: status === 'DEGRADED' ? ['涨跌停价覆盖率 0.9 < 0.95'] : [] } },
      watchlist: { previous_date: null, added: [], removed: [] },
    }));
    db.prepare('INSERT INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
      .run(id, date, status, at, path, mode);
  });
  for (const [time, refreshStatus, rows = 5500] of fetches) {
    db.prepare("INSERT INTO sync_history (dataset, key, rows, status, message, synced_at, refresh_status) VALUES ('daily', ?, ?, 'ok', 'refresh', ?, ?)")
      .run(date, rows, new Date(`${d}T${time}:00+08:00`).toISOString(), refreshStatus);
  }
}

const ACCEPT_DAYS = ['20261019', '20261020', '20261021', '20261022', '20261023', '20261026', '20261027', '20261028', '20261029', '20261030', '20261102', '20261103'];
const openAcceptDays = db => upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], ACCEPT_DAYS.map(c => ({ cal_date: c, is_open: 1 })));
const LATER = new Date('2026-11-03T02:00:00Z'); // 10:00 Beijing after every fixture day

test('P1-2: one live report plus one post-close REFRESH_OK passes; retries may recover, late checks do not count', () => {
  const db = openAshareDb(':memory:');
  openAcceptDays(db);

  // Free provider: one complete daily fetch is enough (the retired rule required two runs and two refreshes).
  fakeLiveDay(db, '20261019', [['19:40', 'READY']], [['19:35', 'REFRESH_OK']]);
  const single = acceptanceDay(db, '20261019', { now: LATER });
  assert.equal(single.result, 'PASS', JSON.stringify(single.failed));
  assert.deepEqual(single.failed, []);
  assert.equal(single.final.report_id, 'ASR-20261019-0-live');
  assert.equal(single.mcp_report_id, single.final.report_id);
  assert.equal(single.late_recovery, false);

  // The first attempt returned a short page; the later REFRESH_OK before the selected report satisfies the check.
  fakeLiveDay(db, '20261020', [['19:30', 'NOT_READY'], ['20:10', 'READY']], [['19:20', 'REFRESH_INCOMPLETE'], ['20:05', 'REFRESH_OK']]);
  const retried = acceptanceDay(db, '20261020', { now: LATER });
  assert.equal(retried.result, 'PASS', JSON.stringify(retried.failed));
  assert.equal(retried.final.report_id, 'ASR-20261020-1-live');
  assert.equal(retried.daily_fetches.find(f => f.refresh_status === 'REFRESH_INCOMPLETE').eligible, false);

  // Failed-only requests are not a re-check.
  fakeLiveDay(db, '20261021', [['19:40', 'READY']], [['19:35', 'REFRESH_FAILED']]);
  const failedOnly = acceptanceDay(db, '20261021', { now: LATER });
  assert.equal(failedOnly.result, 'FAIL');
  assert.ok(failedOnly.failed.includes('data_rechecked'));

  // A good refresh AFTER the selected report cannot prove the report was built from it.
  fakeLiveDay(db, '20261030', [['19:40', 'READY']], [['20:00', 'REFRESH_OK']]);
  const afterReport = acceptanceDay(db, '20261030', { now: LATER });
  assert.equal(afterReport.result, 'FAIL');
  assert.ok(afterReport.failed.includes('data_rechecked'));
  assert.equal(afterReport.daily_fetches[0].before_report, false);

  // Pre-close records are not post-close evidence.
  fakeLiveDay(db, '20261102', [['14:00', 'READY']], [['14:05', 'REFRESH_OK']]);
  const preClose = acceptanceDay(db, '20261102', { now: LATER });
  assert.equal(preClose.result, 'FAIL');
  assert.ok(preClose.failed.includes('live_report'));
  assert.ok(preClose.failed.includes('data_rechecked'));

  assert.equal(acceptance(db, '20261019', 1, { now: LATER }).passed, true);
  const summary = acceptance(db, '20261021', 3, { now: LATER });
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.criteria, ['live_report', 'data_rechecked', 'final_status', 'mcp_consistent', 'on_time']);
  db.close();
});

test('P1-2: DEGRADED is PASS_DEGRADED by default; --strict-ready fails it and --allow-degraded is a compatibility alias', async () => {
  const db = openAshareDb(':memory:');
  openAcceptDays(db);
  fakeLiveDay(db, '20261022', [['19:40', 'DEGRADED']], [['19:35', 'REFRESH_OK']]);

  const byDefault = acceptanceDay(db, '20261022', { now: LATER });
  assert.equal(byDefault.result, 'PASS_DEGRADED');
  assert.deepEqual(byDefault.failed, []);
  const strict = acceptanceDay(db, '20261022', { now: LATER, strictReady: true });
  assert.equal(strict.result, 'FAIL');
  assert.ok(strict.failed.includes('final_status'));
  const alias = acceptanceDay(db, '20261022', { now: LATER, allowDegraded: true });
  assert.equal(alias.result, 'PASS_DEGRADED');

  // NOT_READY is never publishable, even with the alias.
  fakeLiveDay(db, '20261023', [['19:40', 'NOT_READY']], [['19:35', 'REFRESH_OK']]);
  const notReady = acceptanceDay(db, '20261023', { now: LATER, allowDegraded: true });
  assert.equal(notReady.result, 'FAIL');
  assert.ok(notReady.failed.includes('final_status'));

  // The CLI keeps the default and both spellings.
  const run = async flags => {
    const x = helpers({ days: '1', end: '20261022', ...flags });
    await runCommand(db, 'acceptance', x.h);
    return x.out[0];
  };
  assert.equal((await run({})).checks[0].result, 'PASS_DEGRADED');
  assert.equal((await run({ 'allow-degraded': true })).checks[0].result, 'PASS_DEGRADED');
  const strictRun = await run({ 'strict-ready': true });
  assert.equal(strictRun.checks[0].result, 'FAIL');
  assert.equal(strictRun.strict_ready, true);
  db.close();
});

test('P1-2: wrong-day, replay, ID mismatch, late recovery and the 21:15 PENDING boundary', () => {
  const db = openAshareDb(':memory:');
  openAcceptDays(db);

  // A next-day catch-up is not the assessed day's evidence.
  fakeLiveDay(db, '20261023', [['19:40', 'READY', 'live', '2026-10-26T08:00:00.000+08:00']], [['19:35', 'REFRESH_OK']]);
  const catchUp = acceptanceDay(db, '20261023', { now: LATER });
  assert.equal(catchUp.result, 'FAIL');
  assert.ok(catchUp.failed.includes('live_report'));
  assert.ok(catchUp.failed.includes('on_time'));
  assert.equal(catchUp.late_recovery, true);

  // A replay for the target day is never live evidence, even when it is what the tools serve.
  fakeLiveDay(db, '20261026', [['20:00', 'READY', 'replay']], [['19:35', 'REFRESH_OK']]);
  const replay = acceptanceDay(db, '20261026', { now: LATER });
  assert.equal(replay.result, 'FAIL');
  assert.equal(replay.final, null);
  assert.equal(replay.live_runs.length, 0);
  assert.ok(replay.failed.includes('live_report'));
  assert.ok(replay.failed.includes('mcp_consistent'));

  // Reports generated after the assessment time are invisible; MCP still serves one, so the IDs differ.
  fakeLiveDay(db, '20261027', [['19:40', 'READY'], ['22:00', 'READY']], [['19:35', 'REFRESH_OK']]);
  const mismatch = acceptanceDay(db, '20261027', { now: new Date('2026-10-27T20:00:00+08:00') });
  assert.equal(mismatch.result, 'PENDING', 'before 21:15 the incomplete MCP check is PENDING');
  assert.equal(mismatch.final.report_id, 'ASR-20261027-0-live');
  assert.notEqual(mismatch.mcp_report_id, mismatch.final.report_id);
  assert.ok(mismatch.failed.includes('mcp_consistent'));

  // Incomplete before 21:15 is PENDING; after 21:15 it is FAIL.
  fakeLiveDay(db, '20261028', [['19:40', 'READY']], [['19:35', 'REFRESH_INCOMPLETE']]);
  const pending = acceptanceDay(db, '20261028', { now: new Date('2026-10-28T21:00:00+08:00') });
  assert.equal(pending.result, 'PENDING');
  assert.ok(pending.failed.includes('data_rechecked'));
  const failed = acceptanceDay(db, '20261028', { now: new Date('2026-10-28T21:20:00+08:00') });
  assert.equal(failed.result, 'FAIL');

  // A same-day recovery after the deadline is complete but is not on-time SLA.
  fakeLiveDay(db, '20261029', [['19:40', 'NOT_READY'], ['21:30', 'READY']], [['19:35', 'REFRESH_OK']]);
  const late = acceptanceDay(db, '20261029', { now: new Date('2026-10-29T21:45:00+08:00') });
  assert.equal(late.result, 'FAIL');
  assert.ok(late.failed.includes('on_time'));
  assert.equal(late.checks.live_report, true);
  assert.equal(late.checks.data_rechecked, true);
  assert.equal(late.checks.final_status, true, 'the latest same-day report is READY');
  assert.equal(late.late_recovery, true);
  db.close();
});

test('P1-2: a next-day catch-up is served by MCP but is not evidence; an on-time report still passes', () => {
  const db = openAshareDb(':memory:');
  openAcceptDays(db);
  fakeLiveDay(db, '20261103', [
    ['19:40', 'READY'],
    ['08:00', 'READY', 'live', '2026-11-04T08:00:00.000+08:00'],
  ], [['19:35', 'REFRESH_OK']]);
  const result = acceptanceDay(db, '20261103', { now: new Date('2026-11-05T02:00:00Z') });
  assert.equal(result.result, 'PASS', JSON.stringify(result.failed));
  assert.equal(result.final.report_id, 'ASR-20261103-0-live', 'the on-time report is the evidence');
  assert.equal(result.mcp_report_id, 'ASR-20261103-1-live', 'MCP serves the latest live target-day report');
  assert.equal(result.checks.mcp_consistent, true);
  assert.equal(result.late_recovery, false, 'the day was already ready on time; nothing was recovered late');
  db.close();
});

test('P1-2: a real live report is served, and watchlist continuity is a diagnostic rather than a gate', () => {
  const date = LIVE_DAYS.at(-1);
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const { meta } = generateReport(live, date, 'live');
  // Pin the fixture report to its trade day; generated_at otherwise carries the
  // wall clock, which is not that 2026 fixture date when the suite runs later.
  live.prepare("UPDATE report SET generated_at = ? WHERE trade_date = ? AND run_mode = 'live' AND report_id != ?")
    .run(`${d}T19:30:00.000+08:00`, date, meta.report_id);
  live.prepare('UPDATE report SET generated_at = ? WHERE report_id = ?').run(`${d}T19:40:00.000+08:00`, meta.report_id);
  live.prepare("INSERT INTO sync_history (dataset, key, rows, status, message, synced_at, refresh_status) VALUES ('daily', ?, 60, 'ok', 'refresh', ?, 'REFRESH_OK')")
    .run(date, new Date(`${d}T19:35:00+08:00`).toISOString());
  const result = acceptanceDay(live, date, { now: new Date(`${d}T20:00:00+08:00`) });
  assert.equal(result.result, 'PASS', JSON.stringify(result.failed));
  assert.deepEqual(result.failed, []);
  assert.equal(result.mcp_report_id, meta.report_id);
  assert.equal(result.final.report_id, meta.report_id);
  assert.equal(result.watchlist?.continuous, true);
});

// ---------------------------------------------------------------- MCP tools

test('MCP tools: five tools answer from the live cache through a read-only connection', async () => {
  closeAshareDb();
  const date = LIVE_DAYS.at(-1);
  const status = (await runAshareTool('ashare_data_status', { date })).content[0].text;
  assert.match(status, /数据质量：\*\*READY\*\*/);
  const md = (await runAshareTool('ashare_daily_report', { date })).content[0].text;
  assert.match(md, /样本内方向性证据/);
  const json = JSON.parse((await runAshareTool('ashare_daily_report', { date, format: 'json' })).content[0].text);
  assert.equal(json.run_mode, 'live');
  assert.equal(json.report_id, latestReportMeta(live, date).report_id);
  const wl = JSON.parse((await runAshareTool('ashare_watchlist', { date })).content[0].text);
  assert.equal(wl.report_id, json.report_id);
  const stock = JSON.parse((await runAshareTool('ashare_stock_analysis', { ts_code: STOCKS[0].ts_code, date })).content[0].text);
  assert.equal(stock.last_bar, date);
  const sectors = (await runAshareTool('ashare_sector_rank', { date, top: 5 })).content[0].text;
  assert.match(sectors, new RegExp(json.report_id));
  assert.throws(() => getAshareDb().exec('DELETE FROM report'), /readonly/);
  // A replayed date in research must never be what the tools serve.
  assert.ok(existsSync(join(dir, 'research', 'reports')));
  closeAshareDb();
});
