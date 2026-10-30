#!/usr/bin/env node
// Arm 1 of the goal-1030 WP4 four-arm comparison: the scheme in production
// today — buy a stock the day the official watchlist admits it, no entry gate.
// Read-only.
//
// This is deliberately NOT a second backtest engine: the events are handed to
// the shared `evaluation.evaluateEvents` (T+1 open entry, limit/suspension
// aware, frozen cost model) and summarised with its own `distribution`, exactly
// as the entry-scheme arms are. What differs is only where the events come from.
//
// Known limit, stated by the report: the official watchlist table only starts
// 20260701, so this arm can cover 20260701..as-of but never the full
// 20250506..20261029 window the entry arms cover.
//
// Usage:
//   node scripts/watchlist-scheme-study.mjs --db <path> --from 20260701 --to 20261029 \
//     --json /tmp/goal1030/arm-watchlist.json
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { evaluateEvents, distribution, EVALUATION_VERSION } from '../build/ashare/evaluation.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('--db');
if (!dbPath) {
  console.error('usage: watchlist-scheme-study.mjs --db <path> --from <YYYYMMDD> --to <YYYYMMDD> [--json out.json]');
  process.exit(2);
}
const from = arg('--from', '20260701');
const to = arg('--to', '20261029');
const universeAsOf = arg('--universe-as-of', '20261029');
const db = new DatabaseSync(dbPath, { readOnly: true });

const HORIZONS = [3, 5, 10, 20];
const COSTS = { buyFeeBps: 15, sellFeeBps: 25, slippageBps: 10, maxExitDelay: 5 };

// Universe: the same 71-code stock pool the entry arms use, so the only
// difference between arms is the rule that selects an entry, not the pool.
const row = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(universeAsOf);
if (!row) {
  console.error(`no snapshot for ${universeAsOf}`);
  process.exit(1);
}
const snap = JSON.parse(row.payload);
const universe = new Set(snap.candidates.filter(c => c.instrument_type === 'STOCK').map(c => c.ts_code));

const adds = db.prepare(
  "SELECT trade_date AS date, ts_code, score, rank, reason FROM watchlist_change WHERE action = 'add' AND trade_date BETWEEN ? AND ? ORDER BY trade_date, ts_code",
).all(from, to);
const events = adds.filter(a => universe.has(a.ts_code));
const outside = adds.length - events.length;

const coverage = db.prepare('SELECT count(*) AS n, min(trade_date) AS first, max(trade_date) AS last FROM watchlist')
  .get();
const days = db.prepare('SELECT count(DISTINCT trade_date) AS n FROM watchlist WHERE trade_date BETWEEN ? AND ?')
  .get(from, to).n;
const firstBar = db.prepare('SELECT min(trade_date) AS d FROM daily').get().d;

console.log(`arm watchlist_adds  ${from}..${to}  universe ${universe.size} stocks (snapshot ${universeAsOf})`);
console.log(`watchlist table      ${coverage.n} rows, ${coverage.first}..${coverage.last}`
  + `   (daily bars start ${firstBar})`);
console.log(`adds in window       ${adds.length}, of which inside the universe ${events.length}`
  + ` (${outside} outside the universe and therefore not measurable here)`);
console.log(`watchlist days in window ${days}`);

const pct = v => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const driftStmt = db.prepare('SELECT close FROM daily WHERE ts_code = ? AND trade_date = ?');

const out = { arm: 'watchlist_adds', from, to, universe_size: universe.size, events: [], horizons: {},
  evaluation_version: EVALUATION_VERSION, costs: COSTS, watchlist_coverage: coverage, adds_outside_universe: outside };

for (const horizon of HORIZONS) {
  const res = evaluateEvents(db, events, { asOf: to, horizon, ...COSTS });
  const done = res.outcomes.filter(o => o.status === 'completed');
  const net = distribution(done.map(o => o.net_return));
  const gross = distribution(done.map(o => o.gross_return));
  const excess = key => {
    const xs = done.map(o => o.excess[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null;
  };
  const drifts = done.map(o => {
    const c = driftStmt.get(o.event.ts_code, o.event.date)?.close;
    const open = o.entry_price;
    return typeof c === 'number' && c > 0 && typeof open === 'number' && open > 0 ? open / c - 1 : null;
  }).filter(v => v !== null);
  const status = {};
  for (const o of res.outcomes) status[o.status] = (status[o.status] ?? 0) + 1;
  out.horizons[`${horizon}`] = {
    n: res.outcomes.length, pending: status.pending ?? 0, blocked: status.entry_blocked ?? 0,
    mean_net: net.mean, median_net: net.median, win_rate: net.win_rate,
    mean: gross.mean, median: gross.median,
    mean_excess_csi300: excess('csi300'), mean_excess_industry: excess('industry'),
    mean_entry_drift: drifts.length ? Math.round((drifts.reduce((a, b) => a + b, 0) / drifts.length) * 1e4) / 1e4 : null,
    status_counts: status,
  };
}
for (const o of evaluateEvents(db, events, { asOf: to, horizon: HORIZONS[2], ...COSTS }).outcomes) {
  out.events.push({
    date: o.event.date, ts_code: o.event.ts_code, status: o.status, entry_date: o.entry_date,
    gross_return: o.gross_return, net_return: o.net_return,
  });
}

console.log('\n--- watchlist scheme (no entry gate) ---');
for (const h of HORIZONS) {
  const x = out.horizons[`${h}`];
  console.log(` ${String(h).padStart(2)}d n=${x.n}  net ${pct(x.mean_net)} / md ${pct(x.median_net)} / win ${pct(x.win_rate)}`
    + `  excCSI300 ${pct(x.mean_excess_csi300)}  excInd ${pct(x.mean_excess_industry)}`
    + `  drift ${pct(x.mean_entry_drift)}  pending ${x.pending} blocked ${x.blocked}`);
}
console.log('\n--- 10d per event ---');
for (const e of out.events) {
  console.log(` ${e.date} ${e.ts_code} ${e.status.padEnd(9)} entry ${e.entry_date ?? '-'}`
    + ` net ${pct(e.net_return)}`);
}

const jsonPath = arg('--json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${jsonPath}`);
}
