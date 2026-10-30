#!/usr/bin/env node
// WP6.2 regression: the eight named 2026-10-29 stocks, replayed from the frozen
// fixture only — no database, no clock, no network.
//
// The point is that the regression is provable offline: `test/fixtures/
// hotspot-20261029/` holds the exact snapshot payload and the forward-adjusted
// bars, so this prints the same table on any machine. It is the evidence behind
// docs/goal-1030/ENTRY_REGRESSION_20261029.md.
//
// It is NOT a re-run of the production pipeline: RPS120 needs the full-market
// cross-section, so `tc_rps_hold` cannot fire here. Where the TREND family's
// representative is an RPS signal in production (600926.SH on 2026-10-29), the
// stage and eligibility still agree but `entry_score` / `confirmed_on` differ.
// The doc's §1 table is the production recomputation; this script is the
// offline reproducer for everything else.
//
// Usage:
//   node scripts/entry-regression-20261029.mjs [--json out.json]
import { writeFileSync } from 'node:fs';
import { classifyCandidate } from '../build/ashare/entryRanking.js';
import { loadFixture, replayStock, AS_OF } from '../test/hotspot-20261029-fixture.mjs';

const NAMES = ['平安银行', '杭州银行', '江苏银行', '中国海油', '中国石油', '广汇能源', '五洲医疗', '艾艾精工'];
const arg = (n, d = null) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);

const fixture = loadFixture();
// Old scheme = the frozen snapshot's own priority ranking. It had no entry
// verdict at all: `entry_*` did not exist before goal-1030 WP3.
const stockRank = new Map([...fixture.snapshot.candidates]
  .filter(c => c.instrument_type === 'STOCK')
  .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1))
  .map((c, i) => [c.ts_code, i + 1]));
const out = [];
for (const name of NAMES) {
  const stored = fixture.snapshot.candidates.find(c => c.name === name);
  if (!stored) throw new Error(`fixture has no candidate named ${name}`);
  const { scan } = await replayStock(stored.ts_code, fixture);
  const candidate = {
    ...stored,
    entry_stage: scan.entry.entry_stage,
    entry_eligibility: scan.entry.entry_eligibility,
    entry_score: scan.entry.entry_score,
    entry_assessments: scan.entry.entry_assessments,
    entry_rejection_reasons: scan.entry.rejection_reasons,
    as_of: AS_OF,
  };
  const c = classifyCandidate(candidate);
  const a = scan.entry.entry_assessments.find(x => x.entry_eligibility) ?? scan.entry.entry_assessments[0] ?? null;
  out.push({
    name, ts_code: stored.ts_code, candidate_class: c.candidate_class,
    old_priority: stored.priority, old_pool: stored.pool, old_rank: stockRank.get(stored.ts_code) ?? null,
    entry_eligibility: c.entry_eligibility, eligibility_reasons: c.eligibility_reasons,
    entry_stage: scan.entry.entry_stage, entry_score: scan.entry.entry_score,
    family: a?.strategy_family ?? null, confirmed_on: a?.confirmed_on ?? null,
    age: a?.signal_age_trade_days ?? null, distance_atr: a?.entry_distance?.atr ?? null,
    risk_pct: a?.objective_risk_distance?.pct ?? null, reward_pct: a?.reward_estimate?.pct ?? null,
    risk_reward: a?.risk_reward ?? null, risk_reward_uncertainty: a?.risk_reward_uncertainty ?? null,
    invalidation: a?.invalidation_condition ?? null,
    hard: a?.hard_invalidations ?? [], soft: a?.soft_risk_warnings ?? [],
    reasons: scan.entry.rejection_reasons,
    parts: a?.ranking_contributions ?? [],
    permission: stored.trade_permission, permission_reason: stored.trade_permission_reason,
  });
}

const pct = v => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—');
const num = v => (typeof v === 'number' ? v.toFixed(2) : '—');
console.log(`as_of ${AS_OF}   fixture replay (no DB)   candidate class / entry gate`);
console.log('offline replay: tc_rps_hold cannot fire (no RPS cross-section), so score/confirmed'
  + ' can differ from production where the RPS signal is the family representative');
for (const r of out) {
  console.log(`\n${r.ts_code} ${r.name}  ${r.candidate_class}  eligible=${r.entry_eligibility}`);
  console.log(`  old scheme: priority ${r.old_priority} rank ${r.old_rank}/${stockRank.size}${r.old_pool === 'FOCUS' ? '' : ` pool ${r.old_pool}`}`
    + '  (no entry verdict existed)');
  console.log(`  stage ${r.entry_stage ?? '—'}  score ${r.entry_score ?? 'null'}  family ${r.family ?? '—'}`
    + `  confirmed ${r.confirmed_on ?? '—'}  age ${r.age ?? '—'}`);
  console.log(`  distance ${r.distance_atr === null ? '—' : r.distance_atr.toFixed(2) + ' ATR'}`
    + `  risk ${pct(r.risk_pct)}  reward ${pct(r.reward_pct)}  RR ${num(r.risk_reward)} (${r.risk_reward_uncertainty ?? '—'})`);
  console.log(`  invalidation ${r.invalidation ? r.invalidation.code + ' @ ' + r.invalidation.level : '—'}`);
  console.log(`  hard ${r.hard.length ? r.hard.join(',') : '—'}  soft ${r.soft.length ? r.soft.join(',') : '—'}`);
  console.log(`  reasons ${r.reasons.length ? r.reasons.join(',') : '—'}   permission ${r.permission}`);
  if (r.parts.length) {
    const sum = r.parts.reduce((t, p) => t + p.points, 0);
    console.log(`  score parts ${r.parts.map(p => `${p.factor}:${p.points}`).join(' ')}`
      + `  ⇒ 100${sum >= 0 ? '+' : ''}${sum.toFixed(2)} = ${Math.max(0, Math.min(100, 100 + sum)).toFixed(2)}`);
  }
}

const jsonPath = arg('--json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ as_of: AS_OF, cases: out }, null, 1));
  console.log(`\nwrote ${jsonPath}`);
}
