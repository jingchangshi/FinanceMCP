#!/usr/bin/env node
// goal-1031 §8.4: 江苏银行 600919.SH 与 山西汾酒 600809.SH 在 2026-10-30 的
// 修复前后对比，外加 603119.SH（当日"收盘已越过自身失效位却仍合格"的缺陷样本）。
//
// Read-only by construction: the market handle is `readOnly: true` and the
// pipeline runs with `persist: false`, so no snapshot, pool or research record
// is written. The "before" side is the STORED 20261030 payload — it was written
// by the deployed image under `entry-rules-1.0.0`, so it is the real before,
// not a reconstruction.
//
// Usage:
//   set -a && . deploy/ashare/.env && set +a
//   node scripts/entry-regression-20261030.mjs [--db PATH] [--json out.json]
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { runHotspotPipeline } from '../build/ashare/hotspotPipeline.js';

const DEFAULT_DB = '/home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite';
const AS_OF = '20261030';
const CODES = ['600919.SH', '600809.SH', '603119.SH'];
const arg = (n, d = null) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);

const dbPath = arg('--db', DEFAULT_DB);
const db = new DatabaseSync(dbPath, { readOnly: true });
const storedRow = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(AS_OF);
const stored = storedRow ? JSON.parse(storedRow.payload) : null;
const res = runHotspotPipeline(db, AS_OF, { persist: false });
db.close();

const pick = (list, code) => (list ?? []).find(c => c.ts_code === code) ?? null;
const rows = [];
for (const code of CODES) {
  const now = pick(res.snapshot.candidates, code);
  const before = pick(stored?.candidates, code);
  const nowA = (now?.entry_assessments ?? []).filter(Boolean);
  const beforeA = (before?.entry_assessments ?? []).filter(Boolean);
  const families = [...new Set([...nowA, ...beforeA].map(a => a.strategy_family))].sort();
  rows.push({
    ts_code: code,
    name: now?.name ?? before?.name ?? null,
    // The candidate record carries no close; the representative assessment's own
    // reference price is the comparable number.
    before: {
      entry_stage: before?.entry_stage ?? null,
      entry_eligibility: before?.entry_eligibility ?? null,
      entry_score: before?.entry_score ?? null,
      analysis_version: before?.entry_assessments?.[0]?.analysis_version ?? null,
      families: beforeA.map(a => ({
        family: a.strategy_family, stage: a.entry_stage, eligible: a.entry_eligibility,
        score: a.entry_score, trigger: a.entry_trigger?.condition ?? null,
        ref_kind: a.entry_trigger?.reference_kind ?? null,
        risk_atr: a.objective_risk_distance?.atr ?? null,
        reward_kind: a.reward_estimate?.kind ?? null,
        reward_price: a.reward_estimate?.price ?? null,
        risk_reward: a.risk_reward, risk_basis: a.risk_basis ?? null,
        reasons: a.rejection_reasons ?? [],
      })),
    },
    after: {
      entry_stage: now?.entry_stage ?? null,
      entry_eligibility: now?.entry_eligibility ?? null,
      entry_score: now?.entry_score ?? null,
      analysis_version: nowA[0]?.analysis_version ?? null,
      families: nowA.map(a => ({
        family: a.strategy_family, stage: a.entry_stage, eligible: a.entry_eligibility,
        score: a.entry_score, trigger: a.entry_trigger?.condition ?? null,
        ref_kind: a.entry_trigger?.reference_kind ?? null,
        risk_atr: a.objective_risk_distance?.atr ?? null,
        reward_kind: a.reward_estimate?.kind ?? null,
        reward_price: a.reward_estimate?.price ?? null,
        risk_reward: a.risk_reward, risk_basis: a.risk_basis ?? null,
        risk_note: a.risk_note ?? null,
        reasons: a.rejection_reasons ?? [],
      })),
    },
    families_checked: families,
  });
}

const view = res.snapshot.entry_view ?? null;
const out = {
  as_of: AS_OF,
  source: dbPath,
  stored_entry_view: stored?.entry_view ? stored.entry_view.counts : null,
  current_entry_view: view ? view.counts : null,
  rules_version_now: rows[0]?.after.analysis_version ?? null,
  rules_version_stored: rows[0]?.before.analysis_version ?? null,
  rows,
};
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
