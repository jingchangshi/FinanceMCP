#!/usr/bin/env node
// Entry-outcome research runner (goal-1030 WP4). Read-only.
//
// Replays the production decision path over the requested window, hands every
// eligible entry to the shared evaluation engine (`evaluation.evaluateEvents`),
// and reports what happened: 3/5/10/20 trade-day returns, CSI 300 and industry
// excess, MFE/MAE, post-entry drawdown, invalidation, entry-price drift,
// blocked entries, and the family / stage / score / regime / half-sample /
// plateau breakdowns.
//
// The universe is the stock pool of the frozen 20261029 snapshot, so the study
// is conditional on names that already passed the research filter. That is a
// survivorship caveat printed in the report, not a hidden assumption.
//
// Usage:
//   node scripts/entry-research.mjs --db <path> --from 20250506 --to 20261029 \
//     --json /tmp/entry-study.json
//   node scripts/entry-research.mjs --db <path> --shadow-from 20261020 --shadow-to 20261029
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { runEntryStudy, entryShadow } from '../build/ashare/entryResearch.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('--db');
if (!dbPath) {
  console.error('usage: entry-research.mjs --db <path> --from <YYYYMMDD> --to <YYYYMMDD> [--json out.json]');
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

// ---- forward shadow only
const shadowFrom = arg('--shadow-from');
if (shadowFrom) {
  const res = entryShadow(db, { since: shadowFrom, asOf: arg('--shadow-to', shadowFrom) });
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

const from = arg('--from');
const to = arg('--to');
if (!from || !to) {
  console.error('--from and --to are required');
  process.exit(2);
}
const universeAsOf = arg('--universe-as-of', '20261029');
const row = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(universeAsOf);
if (!row) {
  console.error(`no snapshot for ${universeAsOf}`);
  process.exit(1);
}
const snap = JSON.parse(row.payload);
const codes = snap.candidates.filter(c => c.instrument_type === 'STOCK').map(c => c.ts_code);
console.log(`universe ${codes.length} stocks from snapshot ${universeAsOf}`
  + ` (FOCUS ${snap.candidates.filter(c => c.pool === 'FOCUS').length})`);

const arm = arg('--arm', 'eligible_only');
if (arm !== 'eligible_only' && arm !== 'all_live_signals') {
  console.error(`--arm must be eligible_only or all_live_signals, got ${arm}`);
  process.exit(2);
}
const t0 = Date.now();
const study = runEntryStudy(db, {
  start: from, end: to, codes, arm,
  windowDays: Number(arg('--window-bars', '330')),
  designDay: arg('--design-day', '20261029'),
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const pct = v => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const H = study.meta.horizons;

function block(title, groups) {
  console.log(`\n--- ${title} ---`);
  for (const [k, s] of Object.entries(groups)) {
    if (!s) continue;
    const cells = H.map(h => {
      const x = s.horizons[`${h}`];
      return `${h}d n${x.n} ${pct(x.mean_net)}/md${pct(x.median_net)}/w${pct(x.win_rate)}`;
    });
    const x10 = s.horizons['10'] ?? {};
    console.log(` ${String(k).padEnd(18)} n=${String(s.n).padStart(4)}${s.sufficient_sample ? ' ' : '!'}`
      + ` ${cells.join('  ')} | exc10 ${pct(x10.mean_excess_csi300)}/${pct(x10.mean_excess_industry)}`
      + ` | MFE ${pct(x10.mean_mfe)} MAE ${pct(x10.mean_mae)} DD ${pct(x10.mean_drawdown)}`
      + ` | drift ${pct(s.mean_entry_drift)} inv10 ${pct(s.invalidated_within_10)}`);
  }
  for (const [k, s] of Object.entries(groups)) {
    if (!s) continue;
    const st = Object.entries(s.status_counts)
      .map(([h, counts]) => `${h}d ${Object.entries(counts).map(([a, b]) => `${a}:${b}`).join(',')}`)
      .join(' | ');
    console.log(`   ${String(k).padEnd(18)} ${st}`);
  }
}

console.log(`\nreplay ${from}..${to} in ${secs}s   arm ${study.meta.arm}   observations ${study.observations.length}`
  + `   days ${study.meta.days_evaluated}   split ${study.meta.split_date}`);
console.log(`engine ${study.meta.engine} / ${study.meta.evaluation_version}`
  + `   costs ${JSON.stringify(study.meta.costs)}`);
block('overall', { ALL: study.summary.overall });
block('by family', study.summary.by_family);
block('by stage', study.summary.by_stage);
block('by score bucket', study.summary.by_score_bucket);
block('by market regime at entry', study.summary.by_regime);
block('by sample role', study.summary.by_sample_role);
block('by half of the window', study.summary.by_half);
block('by soft divergence', study.summary.by_soft_risk);
block('plateau: distance <= k ATR', study.summary.plateau.distance_atr_max);
block('plateau: signal age <= k days', study.summary.plateau.age_max);

const rp = study.summary.risk_event_predictive;
console.log(`\n--- risk-event predictive value ---`);
console.log(` breakdown within 10d after the signal: with divergence ${pct(rp.with_soft_risk_breakdown_rate)}`
  + ` / without ${pct(rp.without_soft_risk_breakdown_rate)}`);
for (const n of rp.notes) console.log(` note ${n}`);

console.log('\n--- data gaps ---');
for (const g of study.meta.data_gaps) console.log(` ${g}`);

console.log('\n--- engine limitations (verbatim) ---');
for (const l of study.limitations) console.log(` - ${l}`);

const jsonPath = arg('--json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(study));
  console.log(`\nwrote ${jsonPath}`);
}
