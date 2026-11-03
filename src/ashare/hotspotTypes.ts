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

// ---------------------------------------------------------------- permissions

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

// ---------------------------------------------------------------- snapshot

/**
 * The V2 research snapshot. This is the ONLY shape the production pipeline
 * writes and the ONLY shape the public/private readers accept as current.
 *
 * Identity = `as_of` + `version_no` + `content_hash` + `implementation_fingerprint`.
 * `generated_at` is excluded from the hash (two runs over the same data must
 * agree); the fingerprint covers the compiled V2 modules that produced the view.
 * There is no candidate list here: per-stock research lives once inside
 * `technical_view.research_universe`.
 */
export interface HotspotSnapshot {
  as_of: string;
  /** Marker the readers require; a snapshot without it is archive, not current. */
  framework: 'V2_ONLY';
  framework_version: string;
  /** sha256 over the compiled technical V2 modules (see technicalFrameworkV2). */
  implementation_fingerprint: string;
  /** Sector-evaluation configuration identity (unchanged by the V2 rebuild). */
  config_version: string;
  content_hash: string;
  /** `data_state.readiness` mirrored at the top level for report headers. */
  data_quality: 'READY' | 'DEGRADED' | 'NOT_READY';
  /** The bar date the technical view actually read. Equals `as_of` on a normal day. */
  market_data_as_of: string | null;
  generated_at: string;
  sectors: HotspotSectorSnapshot;
  technical_view: import('./technicalFrameworkV2.js').TechnicalViewV2;
  coverage: CoverageSummary[];
  /**
   * goal-1032: what data this snapshot actually read. Hashed into
   * `content_hash` under basis v3 together with the V2 view and fingerprint.
   */
  data_state: import('./dataReadiness.js').DataState;
  /** Version-ledger position (assigned by the writer). */
  version_no?: number;
  /**
   * PUBLISHED = current pointer; SUPERSEDED = kept in the ledger, no longer the
   * pointer; CORRECTION = a later version that explicitly corrects an earlier
   * one (same three values as the ledger's CHECK constraint).
   */
  state?: 'PUBLISHED' | 'SUPERSEDED' | 'CORRECTION';
  /** Research-only marker: a snapshot is never a trade authorization. */
  research_only: true;
}

// ---------------------------------------------------------------- experiments

/** Shared cost model for BOTH arms; never varied per arm. */
export const HOTSPOT_EXPERIMENT_COSTS = {
  buyFeeBps: 15,
  sellFeeBps: 25,
  slippageBps: 10,
  maxExitDelay: 5,
} as const;
