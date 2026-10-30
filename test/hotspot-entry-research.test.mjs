// goal-1030 WP4: the entry-outcome research layer.
//
// These tests pin the *wiring and the honesty rules*, not the strategy: real
// entries are measured by the shared `evaluation.evaluateEvents` engine (T+1
// open, limits, costs, references), and this layer must record what the engine
// says — including blocked entries and censored windows — instead of computing
// its own returns.
//
// The synthetic series produces one real breakout by construction, so every
// number below can be checked by hand from the seeded prices.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'entry-research-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { runEntryStudy, entryShadow } = await import('../build/ashare/entryResearch.js');
const { HOTSPOT_EXPERIMENT_COSTS } = await import('../build/ashare/hotspotTypes.js');

const CODE = '600001.SH';
const EMPTY_CODE = '600002.SH';
/** 200 weekdays from 2024-01-02. */
function weekdays(n) {
  const out = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const DATES = weekdays(200);
const BREAK = 120; // the confirmation bar
const ENTRY = 101; // open of BREAK+1: the fill the engine must use

const db = openAshareDb();
upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], DATES.map(d => ({ cal_date: d, is_open: 1 })));

// Flat 100/100.5/99.5 box, then a 103 breakout on 3x volume, then it holds.
const dailyRows = (code, breakout) => DATES.map((d, i) => {
  const after = breakout && i >= BREAK;
  const open = after ? 101 : 100;
  const close = after ? 103 : 100;
  const high = after ? 103.5 : 100.5;
  const low = after ? 102.5 : 99.5;
  const vol = i === BREAK && breakout ? 300000 : 100000;
  return {
    ts_code: code, trade_date: d, open, high, low, close,
    pre_close: i === 0 ? open : (breakout && i === BREAK ? 100 : close),
    pct_chg: 0, vol, amount: close * vol,
  };
});
upsertRows(db, 'daily',
  ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
  [...dailyRows(CODE, true), ...dailyRows(EMPTY_CODE, false)]);
upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
  DATES.flatMap(d => [CODE, EMPTY_CODE].map(c => ({ ts_code: c, trade_date: d, adj_factor: 1 }))));
// Without limit rows the engine cannot tell a tradable open from a limit-up one
// and reports `entry_unknown` — a fixture that wants executed entries needs them.
upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'],
  DATES.flatMap(d => [CODE, EMPTY_CODE].map(c => ({ ts_code: c, trade_date: d, up_limit: 115, down_limit: 85 }))));

// Benchmark rises 0.1% per day, so excess must differ from the raw return.
const idx = DATES.map((d, i) => ({ ts_code: '000300.SH', trade_date: d, open: 3000, high: 3000, low: 3000,
  close: 3000 * Math.pow(1.001, i), pre_close: 3000, pct_chg: 0, vol: 1, amount: 1e8 }));
upsertRows(db, 'index_daily',
  ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], idx);

const CODES = [CODE, EMPTY_CODE];
const study = (over = {}) => runEntryStudy(db, {
  start: DATES[BREAK], end: DATES.at(-1), codes: CODES, designDay: DATES[BREAK], ...over,
});
const main = study();
const at = (s, d) => s.observations.find(o => o.as_of === d);

/** The engine's own net-return formula, repeated so the test documents it. */
const netOf = gross => (1 + gross) * (1 - HOTSPOT_EXPERIMENT_COSTS.slippageBps / 1e4)
  * (1 - HOTSPOT_EXPERIMENT_COSTS.sellFeeBps / 1e4)
  / ((1 + HOTSPOT_EXPERIMENT_COSTS.slippageBps / 1e4) * (1 + HOTSPOT_EXPERIMENT_COSTS.buyFeeBps / 1e4)) - 1;

test('research: eligible entries are handed to the engine and filled at the next open', () => {
  assert.ok(main.observations.length > 0, 'the synthetic breakout must produce observations');
  assert.ok(!main.observations.some(o => o.ts_code === EMPTY_CODE), 'no signal ⇒ no observation');

  const first = at(main, DATES[BREAK]);
  assert.ok(first, 'the confirmation day itself is observed');
  const h3 = first.horizons['3'];
  assert.equal(h3.status, 'completed');
  assert.equal(h3.entry_date, DATES[BREAK + 1]);
  assert.equal(h3.entry_price, ENTRY, 'the engine fills at the next open, never at the signal close');
  assert.equal(first.entry_drift, Math.round((ENTRY / 103 - 1) * 1e4) / 1e4);
  assert.equal(first.confirmed_on, DATES[BREAK]);
  assert.equal(first.signal_age_trade_days, 0);
  assert.equal(first.entry_stage, 'NEWLY_CONFIRMED');
  assert.ok(main.meta.engine.includes('evaluateEvents'), 'the study says which engine measured it');
});

test('research: returns, costs and excess come from the engine, not from local arithmetic', () => {
  const h3 = at(main, DATES[BREAK]).horizons['3'];
  const gross = Math.round((103 / ENTRY - 1) * 1e4) / 1e4;
  assert.equal(h3.gross_return, gross);
  assert.equal(h3.net_return, Math.round(netOf(103 / ENTRY - 1) * 1e4) / 1e4);
  assert.ok(h3.net_return < h3.gross_return, 'costs must reduce the return');

  // One entered observation ⇒ mean and median coincide *within a basis*. The
  // aggregate fields must therefore agree on their basis: `mean`/`median`
  // gross, `mean_net`/`median_net` after costs. Mixing them silently would make
  // every gross-vs-median comparison in the report wrong.
  const agg = main.summary.overall.horizons['3'];
  assert.equal(agg.median, agg.mean, 'median is reported gross, like mean');
  assert.equal(agg.median_net, agg.mean_net, 'median_net is reported after costs');
  assert.equal(agg.mean, h3.gross_return, 'the gross mean is the engine gross return');
  assert.equal(agg.median_net, h3.net_return, 'the after-cost median is the engine net return');

  // CSI 300 reference: entry open (flat 3000) → exit close (compounding 0.1%/day).
  const bench = Math.pow(1.001, BREAK + 3) - 1;
  assert.equal(h3.excess_csi300, Math.round((netOf(103 / ENTRY - 1) - bench) * 1e4) / 1e4,
    'excess is measured against the index over the same span');
  assert.ok(Math.abs(h3.excess_csi300 - h3.net_return) > 1e-4,
    'excess must differ from the return when the benchmark moved');
});

test('research: path statistics describe the entered position over the planned window', () => {
  const o = at(main, DATES[BREAK]);
  assert.equal(o.horizons['3'].mfe, Math.round((103.5 / ENTRY - 1) * 1e4) / 1e4);
  assert.equal(o.horizons['3'].mae, Math.round((102.5 / ENTRY - 1) * 1e4) / 1e4);
  assert.ok(o.horizons['3'].max_drawdown <= 0, 'drawdown is measured from the entry price as the first peak');
});

test('research: a blocked entry is reported as blocked, not dropped and not priced', () => {
  const d = DATES[BREAK + 1];
  db.prepare('UPDATE stk_limit SET up_limit = ? WHERE ts_code = ? AND trade_date = ?').run(ENTRY, CODE, d);
  try {
    const blocked = study({ start: DATES[BREAK], end: DATES[BREAK + 5] });
    const row = blocked.observations.find(o => o.as_of === DATES[BREAK]);
    assert.ok(row, 'the decision is still recorded');
    assert.equal(row.horizons['3'].status, 'entry_blocked');
    assert.equal(row.horizons['3'].entry_price, null);
    assert.equal(row.horizons['3'].gross_return, null);
    assert.equal(row.horizons['3'].mfe, null, 'no position ⇒ no path statistics');
    assert.equal(blocked.summary.overall.horizons['3'].blocked, 1);
    assert.equal(blocked.summary.overall.horizons['3'].n, 0, 'a blocked entry is not a return');
  } finally {
    db.prepare('UPDATE stk_limit SET up_limit = ? WHERE ts_code = ? AND trade_date = ?').run(115, CODE, d);
  }
});

test('research: an unclosed window is censored as pending, never shortened', () => {
  // Stop the data one bar after the signal: the fill exists, the return does not.
  const trunc = study({ start: DATES[BREAK], end: DATES[BREAK + 1] });
  assert.equal(trunc.observations.length, 1);
  const row = trunc.observations[0];
  assert.equal(row.observed_bars_forward, 1);
  assert.equal(row.horizons['3'].status, 'pending');
  assert.equal(row.horizons['3'].gross_return, null);
  assert.equal(trunc.summary.overall.horizons['3'].pending, 1);

  // No next bar ⇒ no fill ⇒ nothing to measure, so no observation at all.
  const noFill = study({ start: DATES[BREAK], end: DATES[BREAK] });
  assert.equal(noFill.observations.length, 0);
  assert.equal(noFill.meta.days_evaluated, 1, 'the day was evaluated, it just could not be filled');
});

test('research: the design day is reported apart from the out-of-sample observations', () => {
  const roles = main.summary.by_sample_role;
  assert.deepEqual(Object.keys(roles), ['design_day'],
    'this fixture has exactly one eligible day and it is the design day');
  assert.equal(roles.design_day.n, 1);
  assert.equal(main.summary.overall.n, main.observations.length);
  assert.equal(main.summary.overall.invalidated_within_10, 0,
    'the breakout is never invalidated here, so the rate is a real 0 over closed windows');

  const other = study({ designDay: DATES[BREAK + 5] });
  assert.deepEqual(Object.keys(other.summary.by_sample_role), ['out_of_sample']);
  assert.equal(other.summary.by_sample_role.out_of_sample.n, 1);
});

test('research: groups smaller than the floor are flagged, and the plateau keeps the gate row', () => {
  assert.equal(main.summary.overall.sufficient_sample, false, 'n=1 cannot support a conclusion');
  const p = main.summary.plateau.distance_atr_max;
  assert.equal(p['1.0 (gate)'].n, main.summary.overall.n,
    'every eligible entry is within the 1.0 ATR gate by construction');
  assert.ok(p['0.25'].n <= p['0.5'].n && p['0.5'].n <= p['0.75'].n);
});

test('research: the study never writes, and runs against a read-only handle', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(process.env.ASHARE_DB_PATH, { readOnly: true });
  const again = runEntryStudy(ro, {
    start: DATES[BREAK], end: DATES[BREAK + 10], codes: [CODE], designDay: DATES[BREAK],
  });
  assert.ok(again.observations.length > 0);
  ro.close();
});

test('research: the control arm buys every live signal, the test arm only gated entries', () => {
  // The gate rejects everything after the confirmation day (the name is now
  // > 1 ATR from the reference and `overheated` applies once age > 0), so the
  // control arm must hold strictly more observations from the same replay.
  const control = study({ arm: 'all_live_signals' });
  assert.equal(control.meta.arm, 'all_live_signals');
  assert.equal(main.meta.arm, 'eligible_only', 'the default arm is the scheme under test');
  assert.ok(control.observations.length > main.observations.length,
    'removing the timing gate must add entries, not remove them');

  const stages = new Set(control.observations.map(o => o.entry_stage));
  for (const s of stages) {
    assert.ok(['NEWLY_CONFIRMED', 'PULLBACK_READY', 'EXTENDED', 'RISK_BLOCKED'].includes(s),
      `control arm must never buy a non-live stage (${s})`);
  }
  assert.ok([...stages].some(s => s !== 'NEWLY_CONFIRMED' && s !== 'PULLBACK_READY'),
    'the fixture must exercise at least one rejected stage in the control arm');
  // Same execution semantics in both arms: the engine still fills at the next open.
  for (const o of control.observations) {
    const h = o.horizons['3'];
    if (h.status === 'completed') assert.equal(h.entry_date, nextTradeDay(o.as_of));
  }
});

/** The fixture calendar has no holidays, so the next bar is the next weekday. */
function nextTradeDay(d) {
  const i = DATES.indexOf(d);
  return DATES[i + 1];
}

test('shadow: snapshots without an entry view are named as such, never counted as zero performance', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS hotspot_snapshot (
    as_of TEXT NOT NULL, config_version TEXT NOT NULL, content_hash TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (as_of, config_version))`);
  const insert = (asOf, payload) => db.prepare(
    'INSERT INTO hotspot_snapshot (as_of, config_version, content_hash, payload, created_at)'
    + ' VALUES (?, ?, ?, ?, ?)').run(asOf, 'test', `sha256:${asOf}`, JSON.stringify(payload), '2026-10-30T00:00:00Z');

  insert(DATES[BREAK], { as_of: DATES[BREAK] }); // pre-WP3 snapshot: no entry_view
  const empty = entryShadow(db, { since: DATES[BREAK], asOf: DATES[BREAK + 1] });
  assert.equal(empty.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(empty.snapshot_days, 1);
  assert.equal(empty.snapshot_days_with_entry_view, 0);
  assert.equal(empty.signals_recorded, 0);
  assert.match(empty.note, /entry_view/);

  insert(DATES[BREAK + 1], { as_of: DATES[BREAK + 1], entry_view: { entry_top10: [{ ts_code: CODE, entry_score: 100 }] } });
  const published = entryShadow(db, { since: DATES[BREAK], asOf: DATES[BREAK + 2] });
  assert.equal(published.snapshot_days_with_entry_view, 1);
  assert.equal(published.signals_recorded, 1, 'the published pick is read from the snapshot');
  assert.equal(published.signals_evaluable, 1, 'it has a next bar, so the engine priced the entry');
  assert.equal(published.signals_matured, 0, 'a 10-day horizon has not closed after one bar');
  assert.equal(published.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(published.stats, null, 'no statistic is fabricated from zero matured cases');
});

// goal-1031 §2.2: `entry_drift` was purely descriptive. The gate is decided at
// T's close and the fill happens at T+1's open; until these fields existed the
// study silently assumed the two prices were the same.
test('research: the T+1 open re-check is a second gate, not a description of drift', () => {
  const first = at(main, DATES[BREAK]);
  assert.equal(first.entry_stage, 'NEWLY_CONFIRMED');
  assert.ok(Number.isFinite(first.entry_recheck_atr), 'the re-check is measured, not assumed');
  assert.equal(first.entry_eligible_at_open, true, 'a fill at 101 is below the 103 reference, so it passes');
  assert.ok(first.entry_recheck_atr < 0, 'a fill below the reference is a negative distance');

  for (const o of main.observations) {
    if (o.entry_stage === 'NEWLY_CONFIRMED' || o.entry_stage === 'PULLBACK_READY') continue;
    assert.equal(o.entry_recheck_atr, null, `${o.entry_stage} is not an entry stage: no distance exists`);
    assert.equal(o.entry_eligible_at_open, null, 'not applicable must never be reported as false');
  }

  // Same decision day, a gap through the entry window at the open. The window is
  // 1.0 ATR and ATR14 here is ~1.2, so +5 over the 103 reference cannot pass.
  const d = DATES[BREAK + 1];
  const before = db.prepare('SELECT open, high FROM daily WHERE ts_code = ? AND trade_date = ?').get(CODE, d);
  db.prepare('UPDATE daily SET open = ?, high = ? WHERE ts_code = ? AND trade_date = ?').run(108, 108.5, CODE, d);
  try {
    const gapped = at(study(), DATES[BREAK]);
    assert.equal(gapped.entry_stage, 'NEWLY_CONFIRMED', 'the decision-day verdict is unchanged by the gap');
    assert.ok(gapped.entry_drift > 0, 'the gap is visible in drift too — but drift was never a gate');
    assert.ok(gapped.entry_recheck_atr > 1, 'measured in the same ATR units as the entry window');
    assert.equal(gapped.entry_eligible_at_open, false, 'the fill price is outside the 1.0-ATR window');
  } finally {
    db.prepare('UPDATE daily SET open = ?, high = ? WHERE ts_code = ? AND trade_date = ?')
      .run(before.open, before.high, CODE, d);
  }
  assert.equal(at(study(), DATES[BREAK]).entry_eligible_at_open, true, 'restoring the open restores the verdict');
});

// goal-1031 §2.4: one event with four horizon windows is four rows, not four
// independent trials, and the horizon rows of one signal are perfectly dependent.
test('research: event-days and unique signals are published side by side', () => {
  const o = main.summary.overall;
  assert.ok(Number.isInteger(o.unique_signals), 'a signal count, not an event count');
  assert.ok(o.unique_signals >= 1 && o.unique_signals <= o.n, 'signals can never exceed event-days');
  const h3 = o.horizons_signal_equal['3'];
  assert.ok(Number.isInteger(h3.signals) && h3.signals <= o.unique_signals);
  assert.ok(Number.isFinite(o.open_recheck.failed));
  assert.ok(o.open_recheck.failed <= o.open_recheck.n);
  // A mean cannot show a gate that failed in the tail; the distribution can.
  assert.ok(Object.hasOwn(o.entry_drift_distribution, 'p95'));
  assert.ok(Object.hasOwn(o.entry_drift_distribution, 'max'));
});
