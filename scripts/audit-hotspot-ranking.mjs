#!/usr/bin/env node
// Read-only audit of the goal-1030 entry view for one hotspot day.
//
// Rebuilds the pool and the independent entry ranking for `--as-of` and prints
// the comparison the WP3 contract requires: the legacy research top-10, the
// entry top-10 (which may be empty), every high-ranked name the entry gates
// reject, and how FOCUS membership moved. The production DB is opened with
// `readOnly: true` and the pipeline runs with `persist: false`, so nothing is
// written — the frozen snapshot stays the only record of that day.
//
// Usage:
//   node scripts/audit-hotspot-ranking.mjs \
//     --db /home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite \
//     --as-of 20261029
import { DatabaseSync } from 'node:sqlite';
import { runHotspotPipeline } from '../build/ashare/hotspotPipeline.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('--db');
const asOf = arg('--as-of');
if (!dbPath || !asOf) {
  console.error('usage: audit-hotspot-ranking.mjs --db <path> --as-of <YYYYMMDD>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const storedRow = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(asOf);
const stored = storedRow ? JSON.parse(storedRow.payload) : null;
const run = runHotspotPipeline(db, asOf, { persist: false });
const snap = run.snapshot;
const view = snap.entry_view;
if (!view) {
  console.error('snapshot has no entry_view — build older than goal-1030 WP3?');
  process.exit(1);
}

const pct = (v) => (typeof v === 'number' ? v : 'n/a');
console.log(`as_of ${asOf}  timings ${JSON.stringify(run.timings)}`);
console.log(`counts ${JSON.stringify(snap.counts)}`);
console.log(`class counts ${JSON.stringify(view.counts)}`);

console.log(`\n--- research_top10 (legacy priority order) ---`);
for (const e of view.research_top10) {
  console.log(` ${e.ts_code} ${e.name} priority=${pct(e.priority)} research_score=${pct(e.research_score)}`);
}

console.log(`\n--- entry_top10 (eligible only; zero is allowed) --- ${view.entry_top10.length}`);
for (const e of view.entry_top10) {
  console.log(` ${e.ts_code} ${e.name} ${e.candidate_class} ${e.entry_stage}`
    + ` score=${pct(e.entry_score)} conf=${e.confirmed_on ?? '-'} RR=${pct(e.risk_reward)}`);
}

console.log(`\n--- preparing_top (watch list, never entry) --- ${view.preparing_top.length}`);
for (const e of view.preparing_top) console.log(` ${e.ts_code} ${e.name} score=${pct(e.entry_score)}`);

console.log(`\n--- rejected_high_rank --- ${view.rejected_high_rank.length}`);
for (const e of view.rejected_high_rank) {
  console.log(` ${e.ts_code} ${e.name} priority=${pct(e.priority)} ${e.candidate_class} ${e.entry_stage}`
    + ` :: ${e.rejection_reasons.join(',')}`);
}

if (stored) {
  const oldFocus = new Map(stored.candidates.filter(c => c.pool === 'FOCUS').map(c => [c.ts_code, c]));
  const newFocus = new Map(snap.candidates.filter(c => c.pool === 'FOCUS').map(c => [c.ts_code, c]));
  const left = [...oldFocus.keys()].filter(c => !newFocus.has(c));
  const entered = [...newFocus.keys()].filter(c => !oldFocus.has(c));
  const byCode = new Map(snap.candidates.map(c => [c.ts_code, c]));
  console.log(`\n--- FOCUS membership: ${oldFocus.size} → ${newFocus.size} (${left.length} out / ${entered.length} in) ---`);
  for (const code of left) {
    const now = byCode.get(code);
    console.log(` out ${code} ${oldFocus.get(code).name} priority ${oldFocus.get(code).priority} → ${pct(now?.priority)}`
      + ` (${now?.exclusion_reason ?? now?.pool})`);
  }
  for (const code of entered) {
    console.log(` in  ${code} ${newFocus.get(code).name} priority ${pct(oldFocus.get(code)?.priority ?? null)} →`
      + ` ${pct(newFocus.get(code).priority)} (was ${stored.candidates.find(c => c.ts_code === code)?.pool})`);
  }
}
