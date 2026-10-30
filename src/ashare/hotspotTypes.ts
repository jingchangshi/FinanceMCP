/**
 * Shared types for the hotspot-industry × multi-strategy research layer
 * (goal-1028). This module is intentionally dependency-free and owns no I/O:
 * every hotspot module and both MCP tools import contracts from here so the
 * snapshot format, quality vocabulary and strategy metadata stay single-
 * sourced.
 *
 * Nothing in this file may re-declare a concept that already exists elsewhere:
 * `Regime` comes from market.ts, signal ids from signals.ts, eligibility from
 * analysis.ts. The hotspot layer composes those; it does not redefine them.
 */

export const HOTSPOT_SCHEMA_VERSION = 'hotspot-schema-1.0.0';
export const HOTSPOT_CONFIG_VERSION = 'hotspot-config-1.0.0';
export const HOTSPOT_STRATEGY_SET_VERSION = 'strategies-hs-1.1.0';

// ---------------------------------------------------------------- taxonomy

/**
 * Sector identity. Different sources are NEVER merged by name similarity:
 * each namespace keeps its own key space and only explicit, versioned
 * mappings may link them.
 *
 * - `SW2021:801080.SI` — Shenwan 2021 L1/L2 index code (authoritative industry key)
 * - `THS:885866.TI`    — Tonghuashun industry/concept index
 */
export type SectorKey = string;

export function swKey(indexCode: string): SectorKey {
  return `SW2021:${indexCode}`;
}

export function thsKey(tsCode: string): SectorKey {
  return `THS:${tsCode}`;
}

export function sectorSource(key: SectorKey): 'SW2021' | 'THS' | 'UNKNOWN' {
  if (key.startsWith('SW2021:')) return 'SW2021';
  if (key.startsWith('THS:')) return 'THS';
  return 'UNKNOWN';
}

export function sectorLocalCode(key: SectorKey): string {
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

/**
 * Theme classification per source. `SW_INDUSTRY_*` is the standard industry
 * primary key; THS kinds are recorded as what the upstream `type` field says
 * plus a rule-versioned refinement — never merged across sources.
 */
export type ThemeKind =
  | 'SW_INDUSTRY_L1'
  | 'SW_INDUSTRY_L2'
  | 'SW_INDUSTRY_L3'
  | 'THS_INDUSTRY'
  | 'THS_CONCEPT'
  | 'THS_STYLE'
  | 'THS_SAMPLE'
  | 'UNKNOWN';

/** Rule version for THS theme-kind refinement (name-based, source-local only). */
export const THS_THEME_RULE_VERSION = 'ths-theme-kind-1.0.0';

// ---------------------------------------------------------------- quality

/**
 * Data quality vocabulary shared with the ETF layer (`EtfQualityStatus`
 * values are a strict subset-shaped usage of the same words; this type is
 * about a research fact, not an ETF product).
 */
export type DataQuality = 'OK' | 'DEGRADED' | 'UNAVAILABLE' | 'NO_POINT_IN_TIME';

export interface QualityNote {
  quality: DataQuality;
  /** Machine-readable reason, e.g. 'no_published_at', 'member_snapshot_only'. */
  reason: string;
  detail?: string;
}

export interface CoverageSummary {
  dataset: string;
  rows: number;
  quality: DataQuality;
  reason?: string;
}

// ---------------------------------------------------------------- hotspot sectors

export type IndustryState = 'EMERGING' | 'LEADING' | 'WEAKENING' | 'NEUTRAL' | 'UNKNOWN';

export const INDUSTRY_STATES: readonly IndustryState[] =
  ['EMERGING', 'LEADING', 'WEAKENING', 'NEUTRAL', 'UNKNOWN'] as const;

export interface HotspotFactor {
  /** Stable factor id, e.g. 'ret_20', 'excess_60'. */
  id: string;
  /** Raw value as computed (units documented per factor in strategy-spec). */
  raw: number | null;
  /** Cross-sectional percentile 0..1 (null when not computable). */
  z: number | null;
  quality: DataQuality;
}

export interface HotspotSector {
  key: SectorKey;
  name: string;
  kind: ThemeKind;
  source: 'SW2021' | 'THS';
  state: IndustryState;
  /** 1 = strongest on the composite ranking. Null when UNKNOWN. */
  rank: number | null;
  rank_5d_ago: number | null;
  rank_20d_ago: number | null;
  /** Composite strength 0..1 (percentile of pre-registered weighted factors). */
  strength: number | null;
  factors: HotspotFactor[];
  /** Human-readable reason the sector entered the hotspot set. */
  entry_reason: string;
  /** Counter-evidence and risk statements; never empty for a selected sector. */
  counter_evidence: string[];
  data_quality: DataQuality;
  quality_notes: QualityNote[];
  representative_etfs: Array<{ etf_code: string; name?: string; index_code?: string | null }>;
  updated_at?: string;
}

export interface HotspotSectorSnapshot {
  as_of: string;
  config_version: string;
  /** All evaluated sectors (not only selected), so ranking is auditable. */
  sectors: HotspotSector[];
  /** Selected hotspot capacity set, ordered by rank. Capacity, not a quota. */
  selected: SectorKey[];
  coverage: CoverageSummary[];
}

// ---------------------------------------------------------------- candidates

export type LeadershipType = 'INDUSTRY_LEADER' | 'MARKET_LEADER';
export type InstrumentType = 'STOCK' | 'ETF';
/** Account trading permission; non-mainboard stocks stay research-only. */
export type TradePermission = 'EXECUTABLE' | 'RESEARCH_ONLY';

/**
 * Mainboard detection used by the real-account permission model. Pure and
 * shared: the entry layer must reach the same verdict as the pool.
 */
export const MAINBOARD_RE = /^(60\d{4}\.SH|00\d{4}\.SZ)$/;

export function tradePermissionOf(ts_code: string): { perm: TradePermission; reason: string } {
  return MAINBOARD_RE.test(ts_code)
    ? { perm: 'EXECUTABLE', reason: 'MAINBOARD_OK' }
    : {
      perm: 'RESEARCH_ONLY',
      reason: ts_code.startsWith('688') ? 'STAR_RESEARCH_ONLY'
        : ts_code.startsWith('30') || ts_code.startsWith('301') ? 'CHINEXT_RESEARCH_ONLY'
          : 'NON_MAINBOARD_RESEARCH_ONLY',
    };
}

export interface EtfSourceRef {
  etf_code: string;
  index_code: string | null;
  /** Fund weight at the snapshot's effective date; null for basket-only refs. */
  weight: number | null;
  source: 'index_weight' | 'fund_portfolio' | 'etf_basket_reference';
  effective_date: string | null;
  available_from: string | null;
  quality: DataQuality;
}

export interface CandidateSignalSummary {
  strategy_id: string;
  family: string;
  direction: 'bullish' | 'bearish' | 'risk';
  /** Confirmation date (never backfilled to formation date). */
  confirmed_on: string;
  /** Earliest bar the pattern started forming, informational only. */
  formed_on?: string | null;
  /**
   * Bars of confirmation lag (confirmIndex − formation bar), carried into the
   * snapshot so `confirmed_on ≥ formed_on` is externally checkable (acceptance
   * E7) without re-running the scan.
   */
  confirmation_lag?: number;
  invalidation: string;
  status: 'confirmed' | 'active' | 'invalidated' | 'expired' | 'insufficient_data' | 'matured';
  /** goal-1030 WP1 lifecycle fields (all deterministic at as_of). */
  signal_id?: string;
  strategy_version?: string;
  last_validated_on?: string;
  invalidated_on?: string | null;
  expired_on?: string | null;
  invalidation_reason?: string | null;
  signal_age_trade_days?: number | null;
  max_age_trade_days?: number | null;
  conflicting_risks?: string[];
  source_data_as_of?: string;
}

export interface HotspotCandidate {
  as_of: string;
  ts_code: string;
  name: string;
  instrument_type: InstrumentType;
  /** Primary SW2021 L1 key when known. */
  primary_sector: SectorKey | null;
  /** All sector/theme memberships retained; never used to double count. */
  sectors: SectorKey[];
  /** Dedup happens on ts_code; every ETF origin is kept here. */
  etf_sources: EtfSourceRef[];
  /** True when ≥2 important ETFs hold the same stock. */
  multi_etf: boolean;
  leaderships: LeadershipType[];
  /** Score / rank evidence when the name was selected as a leader. */
  leader_evidence: Array<{ kind: LeadershipType; metric: string; value: number | null; note?: string }>;
  signals: CandidateSignalSummary[];
  /**
   * Unconfirmed patterns visible at as_of (goal-1030 WP2 PREPARING). Never
   * entry evidence on their own and never counted in `signals`.
   */
  forming?: FormingSignal[];
  /** Deterministic status tally over `signals` (audit trail, history included). */
  signal_counts?: Record<SignalStatus | 'total', number>;
  /** goal-1030 WP2: current entry-timing research verdict (never a trade order). */
  entry_stage?: EntryStage | null;
  entry_eligibility?: boolean;
  entry_score?: number | null;
  entry_assessments?: EntryAssessment[];
  entry_rejection_reasons?: string[];
  /**
   * Risk-overlay annotations (trend_breakdown / macd_bear_divergence /
   * overheated) observed for this name. Never entry candidates, never counted
   * in `signals` or `with_signals`; surfaced so a bull event racing a bear
   * risk signal stays visible (strategy-spec §2 "只作为候选的风险标注") and so
   * pool ranking can penalize conflicted names (strategies.ts header).
   */
  risk_events: Array<{ id: string; on: string; last_on?: string; bars?: number }>;
  trade_permission: TradePermission;
  /** e.g. 'MAINBOARD_OK', 'CHINEXT_RESEARCH_ONLY', 'STAR_RESEARCH_ONLY'. */
  trade_permission_reason: string;
  /** Pool membership: 'FOCUS' (30–50), 'RAW' (60–120), 'EXCLUDED'. */
  pool: 'FOCUS' | 'RAW' | 'EXCLUDED';
  inclusion_reason: string;
  exclusion_reason?: string;
  /** Combined priority for research attention; ordering reason recorded. */
  priority: number | null;
  priority_reason: string;
  /**
   * goal-1030 WP3: the frozen analysis score (0..1) this name carried when the
   * pool was built. Reported beside `priority` so the research ranking stays
   * auditable; it never feeds the entry ranking.
   */
  research_score?: number | null;
  data_quality: DataQuality;
}

export interface HotspotSnapshot {
  as_of: string;
  config_version: string;
  strategy_set_version: string;
  content_hash: string;
  generated_at: string;
  sectors: HotspotSectorSnapshot;
  candidates: HotspotCandidate[];
  counts: {
    raw_pool: number;
    focus_pool: number;
    excluded: number;
    etf_candidates: number;
    with_signals: number;
  };
  coverage: CoverageSummary[];
  /**
   * goal-1030 WP3: same-day comparison of the legacy research ranking against
   * the independent entry ranking. Optional so old snapshots stay readable.
   */
  entry_view?: EntryView;
  /** Research-only marker: a snapshot is never a trade authorization. */
  research_only: true;
}

// ---------------------------------------------------------------- strategies

export type StrategyFamily = 'TREND_CONTINUATION' | 'BREAKOUT' | 'REVERSAL';
export type SignalDirection = 'bullish' | 'bearish' | 'risk';

export interface StrategyDef {
  strategy_id: string;
  strategy_version: string;
  family: StrategyFamily;
  required_indicators: string[];
  /** Minimum bars of history before the strategy may emit anything. */
  minimum_history: number;
  /**
   * Descriptive regime applicability — NOT a forced gate. A strategy may
   * legitimately emit in any regime; the field documents the environment the
   * hypothesis was written for and is carried into the evidence.
   */
  market_regime: 'uptrend' | 'downtrend' | 'range' | 'ANY';
  trigger_conditions: string;
  confirmation_conditions: string;
  invalidation_conditions: string;
  risk_flags: string[];
}

export type SignalStatus = 'confirmed' | 'active' | 'invalidated' | 'expired' | 'insufficient_data';

export interface SignalEvent {
  ts_code: string;
  strategy_id: string;
  strategy_version: string;
  family: StrategyFamily;
  direction: SignalDirection;
  /** Date the signal became confirmable (close of this bar). Never backdated. */
  confirmed_on: string;
  /** Formation date if different; informational only. */
  formed_on: string | null;
  /**
   * Bars after the pattern low/close that were required to confirm. A value
   * > 0 documents why confirmed_on ≠ formed_on.
   */
  confirmation_lag: number;
  evidence: Record<string, number | string | boolean | null>;
  /**
   * goal-1031 §2.1-3: the strategy's own *entry* predicates, carried so the
   * entry assessment can state what was met instead of reusing the exit text.
   * Optional because hand-built fixtures predate the field.
   */
  trigger_conditions?: string;
  confirmation_conditions?: string;
  invalidation_conditions: string;
  invalidation?: { on: string; reason: string } | null;
  /**
   * Lifecycle state (goal-1030 WP1). `confirmed` = confirmed on the as-of bar;
   * `active` = confirmed earlier and the contract still holds.
   */
  status: SignalStatus;
  risk_flags: string[];
  /** Deterministic identity: `${ts_code}:${strategy_id}:${confirmed_on}`. */
  signal_id?: string;
  /** Last bar at which the contract was evaluated (equals as-of after a scan). */
  last_validated_on?: string;
  invalidated_on?: string | null;
  /** Bar at which the frozen observation window elapsed (status `expired`). */
  expired_on?: string | null;
  /** Machine-readable rule id that fired, e.g. `trend_breakdown`. */
  invalidation_reason?: string | null;
  /** Trade days between confirmed_on and the as-of bar. */
  signal_age_trade_days?: number | null;
  /** Risk episodes (id@first_on) observed after confirmation — soft evidence. */
  conflicting_risks?: string[];
  /** Last market bar visible to the engine. */
  source_data_as_of?: string;
  /** Strategy observation window in trade days (frozen per lifecycle version). */
  max_age_trade_days?: number | null;
}

/** A pattern that is forming but has not confirmed — never counts as evidence. */
export interface FormingSignal {
  strategy_id: string;
  family: StrategyFamily;
  /** First bar at which the forming state was observable. */
  since: string;
  evidence: Record<string, number | string | boolean | null>;
}

/** A risk overlay episode: consecutive firing bars collapsed into one event. */
export interface RiskEpisode {
  id: 'trend_breakdown' | 'macd_bear_divergence' | 'overheated';
  /** First firing day (kept as `on` for backward compatibility). */
  on: string;
  last_on: string;
  /** Number of firing bars inside the episode. */
  bars: number;
}

// ---------------------------------------------------------------- entry assessment (goal-1030 WP2)

/**
 * Research stages for an entry window. Deliberately NOT a trade signal: the
 * vocabulary separates "worth studying now" from "worth owning".
 */
export type EntryStage =
  | 'PREPARING'
  | 'NEWLY_CONFIRMED'
  | 'PULLBACK_READY'
  | 'EXTENDED'
  | 'RISK_BLOCKED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'INSUFFICIENT_DATA';

export type EntryFamily = 'REVERSAL' | 'BREAKOUT' | 'TREND_CONTINUATION';

/**
 * One deterministic arithmetic term behind `entry_score`. `raw` is the
 * untruncated input so the score is reproducible by hand.
 */
export interface ScoreContribution {
  factor: string;
  raw: number | null;
  weight: number | null;
  points: number;
}

export interface EntryTrigger {
  /** Human-readable condition that would still need to be met. */
  condition: string;
  /** Entry reference price (null when the trigger is purely indicator-based). */
  reference_price: number | null;
  reference_kind: 'confirmation_close' | 'ma20' | 'prior_high' | 'upper_band' | 'neckline' | null;
}

export interface EntryDistance {
  price: number | null;
  pct: number | null;
  atr: number | null;
}

/** Objective, pre-defined upside estimate — never an invented target price. */
export interface RewardEstimate {
  kind: 'measured_move' | 'prior_high' | 'resistance' | 'none';
  price: number | null;
  distance: number | null;
  pct: number | null;
  note: string;
}

export interface EntryAssessment {
  strategy_family: EntryFamily;
  entry_stage: EntryStage;
  entry_eligibility: boolean;
  /** Open signal identities for this family (active/confirmed). */
  active_signal_ids: string[];
  /** Other family members that confirmed but are not the representative. */
  supporting_signal_ids: string[];
  representative_signal_id: string | null;
  confirmed_on: string | null;
  last_validated_on: string | null;
  invalidated_on: string | null;
  signal_age_trade_days: number | null;
  entry_trigger: EntryTrigger;
  entry_distance: EntryDistance;
  invalidation_condition: { code: string | null; level: number | null; description: string };
  objective_risk_distance: EntryDistance;
  risk_distance_reason: string | null;
  /**
   * What `objective_risk_distance` actually measures (goal-1031 §2.1-2): the
   * distance to the *invalidation trigger*, not a maximum loss. A gap through
   * the level realises more than this number, so it must never be read as the
   * worst case. Null when there is no level at all.
   */
  risk_basis: 'invalidation_trigger' | null;
  /** One plain sentence saying how to read the risk distance. */
  risk_note: string;
  reward_estimate: RewardEstimate;
  /** reward.distance / risk.distance; null when either side is unknown. */
  risk_reward: number | null;
  risk_reward_uncertainty: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  hard_invalidations: string[];
  soft_risk_warnings: string[];
  entry_score: number | null;
  ranking_contributions: ScoreContribution[];
  rejection_reasons: string[];
  data_quality: DataQuality;
  as_of_trade_date: string;
  analysis_version: string;
}

/** Candidate-level roll-up over the three families. */
export interface CandidateEntry {
  entry_stage: EntryStage | null;
  entry_eligibility: boolean;
  entry_score: number | null;
  rejection_reasons: string[];
  entry_assessments: EntryAssessment[];
  analysis_version: string;
}

/** Research classes required by goal-1030 WP3. */
export type CandidateClass =
  | 'RESEARCH_ONLY'
  | 'PREPARING'
  | 'NEW_ENTRY'
  | 'PULLBACK_WAIT'
  | 'RISK_REJECTED'
  | 'INSUFFICIENT_DATA';

/** Same-day comparison of the legacy ranking against entry eligibility. */
export interface EntryView {
  as_of: string;
  rules_version: string;
  research_top10: Array<{ ts_code: string; name: string; priority: number | null; research_score: number | null }>;
  entry_top10: Array<{
    ts_code: string; name: string; candidate_class: CandidateClass;
    entry_stage: EntryStage | null; entry_score: number | null;
    confirmed_on: string | null; risk_reward: number | null; eligibility_reasons: string[];
  }>;
  preparing_top: Array<{ ts_code: string; name: string; entry_score: number | null }>;
  rejected_high_rank: Array<{
    ts_code: string; name: string; priority: number | null; research_score: number | null;
    candidate_class: CandidateClass; entry_stage: EntryStage | null; rejection_reasons: string[];
  }>;
  counts: Record<CandidateClass, number>;
  definition_note: string;
}

// ---------------------------------------------------------------- experiments

export const CHAMPION_ARM = 'CHAMPION_WL_1_0_0' as const;
export const CHALLENGER_ARM = 'CHALLENGER_HOTSPOT_MULTISTRATEGY' as const;
export type ExperimentArm = typeof CHAMPION_ARM | typeof CHALLENGER_ARM;

/** Shared cost model for BOTH arms; never varied per arm. */
export const HOTSPOT_EXPERIMENT_COSTS = {
  buyFeeBps: 15,
  sellFeeBps: 25,
  slippageBps: 10,
  maxExitDelay: 5,
} as const;
