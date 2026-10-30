#!/usr/bin/env node
// WP6.2 production side: re-run the 2026-10-29 hotspot pipeline against the
// production database and print the eight regression names, family by family.
//
// Read-only by construction: the handle is opened `readOnly: true` and the
// pipeline is called with `persist: false`, so no snapshot, signal, pool or
// research record is written. It still needs the Tushare token to exist in the
// environment (`set -a && . deploy/ashare/.env && set +a`) because the pipeline
// loads market context, even when nothing is fetched.
//
// Why this exists next to the offline reproducer: `tc_rps_hold` needs the
// full-market RPS cross-section, which the fixture cannot carry. For names
// whose family representative is an RPS signal (600926.SH on 2026-10-29) the
// offline replay and this script legitimately disagree on score/confirmed_on
// while agreeing on stage and eligibility. See
// docs/goal-1030/ENTRY_REGRESSION_20261029.md §3.
//
// Usage:
//   node scripts/entry-regression-20261029-production.mjs [--db PATH] [--json out.json]
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { runHotspotPipeline } from '../build/ashare/hotspotPipeline.js';
import { classifyCandidate } from '../build/ashare/entryRanking.js';

const DEFAULT_DB = '/home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite';
const AS_OF = '20261029';
const NAMES = ['平安银行', '杭州银行', '江苏银行', '中国海油', '中国石油', '广汇能源', '五洲医疗', '艾艾精工'];
const arg = (n, d = null) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);

const dbPath = arg('--db', DEFAULT_DB);
const db = new DatabaseSync(dbPath, { readOnly: true });
const res = runHotspotPipeline(db, AS_OF, { persist: false });
const storedRow = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(AS_OF);
const stored = storedRow ? JSON.parse(storedRow.payload) : null;
db.close();

const stocks = res.snapshot.candidates.filter(c => c.instrument_type === 'STOCK')
  .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
const oldRank = new Map((stored?.candidates ?? [])
  .filter(c => c.instrument_type === 'STOCK')
  .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1))
  .map((c, i) => [c.ts_code, i + 1]));

const cases = [];
for (const name of NAMES) {
  const c = res.snapshot.candidates.find(x => x.name === name);
  if (!c) throw new Error(`pipeline produced no candidate named ${name}`);
  const old = stored?.candidates.find(x => x.ts_code === c.ts_code) ?? null;
  const cls = classifyCandidate(c);
  cases.push({
    name, ts_code: c.ts_code,
    old_priority: old?.priority ?? null, old_rank: oldRank.get(c.ts_code) ?? null, old_pool: old?.pool ?? null,
    old_signals: (old?.signals ?? []).map(s => `${s.strategy_id}@${s.confirmed_on}:${s.status}`),
    priority: c.priority, pool: c.pool, trade_permission: c.trade_permission,
    candidate_class: cls.candidate_class, entry_stage: c.entry_stage,
    entry_eligibility: c.entry_eligibility, entry_score: c.entry_score,
    eligibility_reasons: cls.eligibility_reasons, rejection_reasons: c.entry_rejection_reasons,
    assessments: (c.entry_assessments ?? []).map(a => ({
      family: a.strategy_family, stage: a.entry_stage, eligibility: a.entry_eligibility,
      representative: a.representative_signal_id, confirmed_on: a.confirmed_on,
      age: a.signal_age_trade_days, distance_atr: a.entry_distance?.atr ?? null,
      risk_atr: a.objective_risk_distance?.atr ?? null,
      reward: a.reward_estimate ? `${a.reward_estimate.kind}:${a.reward_estimate.price}` : null,
      risk_reward: a.risk_reward, risk_reward_uncertainty: a.risk_reward_uncertainty,
      hard: a.hard_invalidations, soft: a.soft_risk_warnings, score: a.entry_score,
      parts: (a.ranking_contributions ?? []).map(p => `${p.factor}:${p.points}`),
    })),
  });
}

const f2 = v => (typeof v === 'number' ? v.toFixed(2) : '—');
console.log(`as_of ${AS_OF}   production pipeline, persist:false   db ${dbPath}`);
console.log('old columns come from the frozen snapshot written on 2026-10-29 (no entry fields existed)');
for (const c of cases) {
  console.log(`\n=== ${c.ts_code} ${c.name}  ${c.candidate_class}  stage ${c.entry_stage ?? '—'}`
    + `  eligible=${c.entry_eligibility}  score ${c.entry_score ?? 'null'}`);
  console.log(`  old: priority ${f2(c.old_priority)} (rank ${c.old_rank}) pool ${c.old_pool}`
    + `  — no entry verdict existed`);
  console.log(`  new: priority ${f2(c.priority)} pool ${c.pool} permission ${c.trade_permission}`);
  console.log(`  reasons ${(c.rejection_reasons ?? []).join(',') || '—'}`
    + `   gate ${(c.eligibility_reasons ?? []).join(',') || '—'}`);
  for (const a of c.assessments) {
    console.log(`  [${a.family}] ${a.stage} elig=${a.eligibility} rep=${a.representative}`
      + ` conf=${a.confirmed_on} age=${a.age} dist=${a.distance_atr} riskATR=${a.risk_atr}`
      + ` reward=${a.reward} RR=${a.risk_reward}/${a.risk_reward_uncertainty} score=${a.score}`);
    console.log(`    hard=${(a.hard ?? []).join(',') || '-'}  soft=${(a.soft ?? []).join(',') || '-'}`);
    if (a.parts.length) {
      const sum = a.parts.reduce((t, p) => t + Number(String(p).split(':')[1]), 0);
      console.log(`    parts ${a.parts.join(' ')}  ⇒ ${(100 + sum).toFixed(2)}`);
    }
  }
}

const jsonPath = arg('--json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ as_of: AS_OF, db: dbPath, cases }, null, 1));
  console.log(`\nwrote ${jsonPath}`);
}
