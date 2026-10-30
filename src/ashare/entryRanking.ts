/**
 * Candidate classification and entry ranking (goal-1030 WP3).
 *
 * Two questions must stay separate:
 *   - research value  → `research_score` (the frozen analysis score) and the
 *                       legacy `priority` ranking, whose FOCUS semantics are
 *                       deliberately untouched;
 *   - entry timing    → `entry_eligibility` + `entry_score` from
 *                       entryAssessment.ts, ranked independently.
 *
 * This module never sums "how many bullish signals" into a rank: entry
 * evidence is already aggregated per family upstream, and a candidate enters
 * the ranking through one deterministic verdict.
 */
import type { HotspotCandidate, EntryStage, CandidateClass, EntryView } from './hotspotTypes.js';

// 1.1.0 (goal-1031 §2.1-5): `entry_top10` rows gain `strategy_family` and
// `families_considered`. The ORDER is unchanged — same filter, same sort, same
// tie-break — so a 1.0.0 list is the same list with less disclosed. The version
// moves because the published payload gained fields, not because a rule moved.
export const RANKING_RULES_VERSION = 'ranking-rules-1.1.0';

export type { CandidateClass, EntryView } from './hotspotTypes.js';

export interface ClassifiedCandidate {
  ts_code: string;
  name: string;
  candidate_class: CandidateClass;
  entry_stage: EntryStage | null;
  entry_eligibility: boolean;
  entry_score: number | null;
  /** Ordering tie-breakers, carried so a tie is never broken arbitrarily. */
  risk_reward: number | null;
  entry_distance_atr: number | null;
  research_score: number | null;
  priority: number | null;
  eligibility_reasons: string[];
}


const CLASS_ORDER: CandidateClass[] = [
  'NEW_ENTRY', 'PULLBACK_WAIT', 'PREPARING', 'RISK_REJECTED', 'INSUFFICIENT_DATA', 'RESEARCH_ONLY',
];

/** Deterministic class assignment — no score, no threshold fitting. */
export function classifyCandidate(c: HotspotCandidate): ClassifiedCandidate {
  const reasons = [...(c.entry_rejection_reasons ?? [])];
  const primary = c.entry_assessments?.[0] ?? null;
  const base = {
    ts_code: c.ts_code, name: c.name,
    entry_stage: c.entry_stage ?? null,
    entry_eligibility: c.entry_eligibility ?? false,
    entry_score: c.entry_score ?? null,
    risk_reward: primary?.risk_reward ?? null,
    entry_distance_atr: primary?.entry_distance?.atr ?? null,
    research_score: c.research_score ?? null,
    priority: c.priority ?? null,
    eligibility_reasons: reasons,
  };
  if (c.instrument_type === 'ETF') {
    return { ...base, candidate_class: 'RESEARCH_ONLY', entry_eligibility: false };
  }
  if (c.data_quality === 'UNAVAILABLE') {
    return { ...base, candidate_class: 'INSUFFICIENT_DATA' };
  }
  // Account permission is a *class* boundary: a research-only name can never
  // be an entry candidate, however good the setup looks.
  if (c.trade_permission !== 'EXECUTABLE') {
    if (!reasons.includes('RESEARCH_ONLY_PERMISSION')) reasons.push('RESEARCH_ONLY_PERMISSION');
    return { ...base, candidate_class: 'RESEARCH_ONLY', entry_eligibility: false };
  }
  const stage = c.entry_stage ?? null;
  if (stage === null) {
    if (c.data_quality !== 'OK') return { ...base, candidate_class: 'INSUFFICIENT_DATA' };
    if (!reasons.includes('NO_ENTRY_EVIDENCE')) reasons.push('NO_ENTRY_EVIDENCE');
    return { ...base, candidate_class: 'RESEARCH_ONLY', entry_eligibility: false };
  }
  if (stage === 'INSUFFICIENT_DATA') {
    return { ...base, candidate_class: 'INSUFFICIENT_DATA', entry_eligibility: false };
  }
  if (stage === 'RISK_BLOCKED' || stage === 'INVALIDATED' || stage === 'EXPIRED') {
    return { ...base, candidate_class: 'RISK_REJECTED', entry_eligibility: false };
  }
  if (stage === 'PREPARING') {
    // PREPARING is researchable but is never listed as an entry candidate.
    return { ...base, candidate_class: 'PREPARING', entry_eligibility: false };
  }
  if (stage === 'EXTENDED') {
    return { ...base, candidate_class: 'PULLBACK_WAIT', entry_eligibility: false };
  }
  if (stage === 'PULLBACK_READY') {
    return { ...base, candidate_class: 'PULLBACK_WAIT', entry_eligibility: true };
  }
  // NEWLY_CONFIRMED
  if (c.entry_eligibility) return { ...base, candidate_class: 'NEW_ENTRY' };
  return { ...base, candidate_class: 'RISK_REJECTED', entry_eligibility: false };
}

/** Score first, then reward/risk and proximity, then the code: fully ordered. */
const byEntry = (a: ClassifiedCandidate, b: ClassifiedCandidate): number =>
  (b.entry_score ?? -1) - (a.entry_score ?? -1)
  || (b.risk_reward ?? -1) - (a.risk_reward ?? -1)
  || Math.abs(a.entry_distance_atr ?? 99) - Math.abs(b.entry_distance_atr ?? 99)
  || a.ts_code.localeCompare(b.ts_code);
const byPriority = (a: ClassifiedCandidate, b: ClassifiedCandidate): number =>
  (b.priority ?? -1) - (a.priority ?? -1) || a.ts_code.localeCompare(b.ts_code);

/**
 * Build the comparison view: legacy top-10, entry top-10 (or none), and every
 * high-ranked name the entry rules reject, with reasons. Deterministic and
 * side-effect free.
 */
export function buildEntryView(candidates: HotspotCandidate[], asOf: string): EntryView {
  const stocks = candidates
    .filter(c => c.instrument_type === 'STOCK')
    .map(classifyCandidate);
  const counts = Object.fromEntries(CLASS_ORDER.map(k => [k, 0])) as Record<CandidateClass, number>;
  for (const s of stocks) counts[s.candidate_class] += 1;

  const researchTop = [...stocks].sort(byPriority).slice(0, 10);
  // Eligible means the candidate's own deterministic verdict, not merely
  // belonging to a class that *can* be eligible: PULLBACK_WAIT also holds the
  // names that are extended and must wait.
  const eligible = stocks.filter(s => s.entry_eligibility);
  const entryTop = [...eligible].sort(byEntry).slice(0, 10);
  const preparing = stocks.filter(s => s.candidate_class === 'PREPARING').sort(byEntry).slice(0, 10);
  const researchTopCodes = new Set(researchTop.map(s => s.ts_code));
  const rejected = stocks
    .filter(s => researchTopCodes.has(s.ts_code) && !s.entry_eligibility)
    .sort(byPriority);

  return {
    as_of: asOf,
    rules_version: RANKING_RULES_VERSION,
    research_top10: researchTop.map(s => ({
      ts_code: s.ts_code, name: s.name, priority: s.priority, research_score: s.research_score,
    })),
    entry_top10: entryTop.map(s => {
      const c = candidates.find(x => x.ts_code === s.ts_code);
      const a = c?.entry_assessments?.[0] ?? null;
      // goal-1031 §2.1-5: a name can carry two families that contradict each
      // other (600919.SH on 2026-10-30: BREAKOUT risk/reward 8.62 vs TREND
      // 0.01). The representative stays "best stage"; the disagreement is shown
      // rather than hidden, because a reader who sees only one number cannot
      // tell that the other family rejected the same entry.
      const all = (c?.entry_assessments ?? []).filter(Boolean);
      return {
        ts_code: s.ts_code, name: s.name, candidate_class: s.candidate_class,
        entry_stage: s.entry_stage, entry_score: s.entry_score,
        confirmed_on: a?.confirmed_on ?? null, risk_reward: a?.risk_reward ?? null,
        strategy_family: a?.strategy_family ?? null,
        families_considered: all.length >= 2
          ? all.map(o => ({
            strategy_family: o.strategy_family, entry_stage: o.entry_stage,
            entry_eligibility: o.entry_eligibility, risk_reward: o.risk_reward,
          }))
          : [],
        eligibility_reasons: s.eligibility_reasons,
      };
    }),
    preparing_top: preparing.map(s => ({ ts_code: s.ts_code, name: s.name, entry_score: s.entry_score })),
    rejected_high_rank: rejected.map(s => ({
      ts_code: s.ts_code, name: s.name, priority: s.priority, research_score: s.research_score,
      candidate_class: s.candidate_class, entry_stage: s.entry_stage,
      rejection_reasons: s.eligibility_reasons,
    })),
    counts,
    definition_note:
      'research_top10 = legacy priority order (FOCUS semantics unchanged); entry_top10 = entry-eligible '
      + 'candidates only, ordered by entry_score, then risk/reward, then proximity to the reference, then '
      + 'code (zero is allowed). A fresh confirmation has nothing to subtract yet, so entry_score 100 means '
      + '"no penalty fired", not "best", and the ranking inside such a tie is decided by risk/reward; '
      + 'strategy_family names the representative family (rule: best stage) and families_considered lists the '
      + 'other families assessed for the same name, so a family that rejected the same entry is visible; '
      + 'preparing_top = unconfirmed patterns ranked the same way; '
      + 'rejected_high_rank = research top-10 failing the entry gates, with machine-readable reasons.',
  };
}
