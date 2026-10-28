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
export const HOTSPOT_STRATEGY_SET_VERSION = 'strategies-hs-1.0.0';

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
  status: 'active' | 'invalidated' | 'matured';
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
   * Risk-overlay annotations (trend_breakdown / macd_bear_divergence /
   * overheated) observed for this name. Never entry candidates, never counted
   * in `signals` or `with_signals`; surfaced so a bull event racing a bear
   * risk signal stays visible (strategy-spec §2 "只作为候选的风险标注") and so
   * pool ranking can penalize conflicted names (strategies.ts header).
   */
  risk_events: Array<{ id: string; on: string }>;
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
  invalidation_conditions: string;
  invalidation?: { on: string; reason: string } | null;
  status: 'active' | 'invalidated';
  risk_flags: string[];
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
