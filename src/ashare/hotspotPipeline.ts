import type { DatabaseSync } from 'node:sqlite';
import { evaluateHotspotSectors } from './hotspot.js';
import { buildHotspotPool, type PoolEtfConstituent, type PoolOptions } from './hotspotPool.js';
import { scanPoolStrategies } from './strategies.js';
import { saveHotspotSnapshot, snapshotContentHash } from './hotspotSnapshots.js';
import { topConstituents, weightCoverage } from './etfWeightStore.js';
import { ETF_CANDIDATE_DECLARATIONS } from './etfDeclarations.js';
import { buildEntryView } from './entryRanking.js';
import {
  HOTSPOT_CONFIG_VERSION, HOTSPOT_STRATEGY_SET_VERSION,
  type HotspotSnapshot, type CoverageSummary,
} from './hotspotTypes.js';
import type { HotspotConfig } from './hotspot.js';

/**
 * Daily hotspot snapshot orchestrator (goal-1028 §P2.3 / architecture.md §5).
 *
 * One entry point wires the whole research surface for a single as-of day:
 *
 *   1. sector identification  — evaluateHotspotSectors (SW L1 + THS themes)
 *   2. ETF universe           — industry_theme declarations, PIT weight lookup
 *                              via etfWeightStore (never basket quantities)
 *   3. candidate pool         — buildHotspotPool (leaders + RPS + ETF core)
 *   4. strategy scan          — scanPoolStrategies over the seeded pool codes
 *   5. persistence            — saveHotspotSnapshot (content-hash identical
 *                              regenerations replace, never fork history)
 *
 * The pipeline only ever writes the NEW hotspot tables; watchlist, research
 * logs and formal snapshots are untouched. ETF weight reads are point-in-time
 * (available_from ≤ asOf, published rows only) and degrade to an empty
 * constituent list + UNAVAILABLE coverage when the store has no data — the
 * pipeline never fabricates constituents and never falls back to basket qty.
 */
export interface HotspotPipelineOptions {
  config?: HotspotConfig;
  /** ETFs considered relevant this day; default = industry_theme declarations. */
  etfCodes?: string[];
  etfNames?: Record<string, string>;
  /** Injected for tests; default reads etf_weight_snapshot (PIT-resolved). */
  etfConstituents?: (etfCode: string) => PoolEtfConstituent[];
  pool?: Partial<Omit<PoolOptions, 'etfConstituents' | 'etfCodes' | 'signalScanProvider'>>;
  /** Set false for a dry run: compute everything, persist nothing. */
  persist?: boolean;
}

export interface HotspotPipelineResult {
  snapshot: HotspotSnapshot;
  saved: { content_hash: string; candidates_written: number; replaced: boolean } | null;
  seconds: number;
  /**
   * Phase timings for acceptance E11 (performance record). Diagnostic only —
   * deliberately OUTSIDE the snapshot body so it never perturbs content_hash.
   * `pool` includes `scan` (the lazy strategy-scan provider runs inside the
   * pool build); `scan` is the provider's own span within `pool`.
   */
  timings: { sectors: number; pool: number; scan: number; write: number; total: number };
}

/** Industry/theme ETFs the pool considers relevant by declaration. */
export function defaultHotspotEtfCodes(): string[] {
  return ETF_CANDIDATE_DECLARATIONS
    .filter(d => d.category === 'industry_theme')
    .map(d => d.ts_code);
}

/** fund_basic.name when cached; the declared hint otherwise (marked as hint). */
function etfDisplayNames(db: DatabaseSync, codes: string[]): Record<string, string> {
  const hints = new Map(ETF_CANDIDATE_DECLARATIONS.map(d => [d.ts_code, d.name_hint]));
  const names: Record<string, string> = {};
  let fundBasic = false;
  try {
    fundBasic = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fund_basic'").get();
  } catch { fundBasic = false; }
  for (const code of codes) {
    if (fundBasic) {
      const row = db.prepare('SELECT name FROM fund_basic WHERE ts_code = ?').get(code) as { name?: string } | undefined;
      if (row?.name?.trim()) { names[code] = row.name.trim(); continue; }
    }
    const hint = hints.get(code);
    if (hint) names[code] = `${hint}（声明提示）`;
  }
  return names;
}

/** Default PIT constituent lookup backed by etf_weight_snapshot. */
function storeBackedConstituents(db: DatabaseSync, asOf: string, topN: number) {
  return (etfCode: string): PoolEtfConstituent[] =>
    topConstituents(db, etfCode, asOf, topN).map(r => ({
      etf_code: r.etf_code,
      stock_code: r.stock_code,
      weight: r.weight,
      source: r.source,
      effective_date: r.effective_date,
      available_from: r.available_from,
      quality: r.quality_status,
    }));
}

/** Run the full hotspot research pipeline for one as-of day. */
export function runHotspotPipeline(
  db: DatabaseSync,
  asOf: string,
  opts: HotspotPipelineOptions = {},
): HotspotPipelineResult {
  const startedAt = Date.now();
  const timings = { sectors: 0, pool: 0, scan: 0, write: 0, total: 0 };
  const config = opts.config;
  const etfTopN = opts.pool?.etfTopN ?? 10;

  // 1. Sector identification (SW L1 + THS themes, ranked with state machine).
  const t0 = Date.now();
  const sectors = evaluateHotspotSectors(db, asOf, config);
  timings.sectors = (Date.now() - t0) / 1000;

  // 2. ETF universe + PIT constituent lookup.
  const etfCodes = opts.etfCodes ?? defaultHotspotEtfCodes();
  const etfNames = opts.etfNames ?? etfDisplayNames(db, etfCodes);
  const constituents = opts.etfConstituents ?? storeBackedConstituents(db, asOf, etfTopN + 10);

  // 3+4. Pool build with an injected lazy strategy scan: buildHotspotPool
  // collects the seed codes, then hands them to exactly one scanPoolStrategies
  // pass before assembling candidates — the market scan / RPS work is paid once.
  const poolOpts: PoolOptions = {
    ...opts.pool,
    etfConstituents: constituents,
    etfCodes,
    etfNames,
    signalScanProvider: (codes) => {
      if (!codes.length) return null;
      const t = Date.now();
      const scanResult = scanPoolStrategies(db, codes, asOf);
      timings.scan = (Date.now() - t) / 1000;
      return scanResult;
    },
  };
  const t1 = Date.now();
  const pool = buildHotspotPool(db, asOf, sectors, null, poolOpts);
  timings.pool = (Date.now() - t1) / 1000;

  // Representative ETFs per sector (goal P5.1): an ETF represents a sector
  // only when one of its PIT-resolved constituents stamped that sector in the
  // pool — evidence-based, never inferred from name similarity or category
  // declarations. Deterministic order (etf_code) so the snapshot hash stays
  // reproducible.
  const etfBySector = new Map<string, Map<string, { etf_code: string; name?: string; index_code?: string | null }>>();
  for (const c of pool.candidates) {
    if (c.instrument_type !== 'STOCK') continue;
    for (const key of c.sectors) {
      let m = etfBySector.get(key);
      if (!m) etfBySector.set(key, (m = new Map()));
      for (const e of c.etf_sources) {
        if (!m.has(e.etf_code)) {
          m.set(e.etf_code, {
            etf_code: e.etf_code,
            ...(etfNames[e.etf_code] ? { name: etfNames[e.etf_code] } : {}),
            index_code: e.index_code,
          });
        }
      }
    }
  }
  for (const s of sectors.sectors) {
    const m = etfBySector.get(s.key);
    if (m) s.representative_etfs = [...m.values()].sort((a, b) => a.etf_code.localeCompare(b.etf_code));
  }

  // 5. Assemble + persist. Coverage merges sector, pool and ETF-weight layers;
  // an absent weight store degrades coverage, never the candidate facts.
  //
  // Self-referential coverage fix (acceptance E9): the hotspot_snapshot /
  // hotspot_candidate entries describe THIS run's own write, not the table
  // state observed before it. Taken pre-write, the first write of a day hashes
  // as 0 rows while every identical rerun hashes as N — content-hash
  // reproducibility (data-contracts §4) would fail by construction. Both dry
  // runs and real runs therefore report the write outcome they produce: 1
  // snapshot row for (as_of, config_version) plus the candidate rows below.
  const selfCoverage = new Map<string, CoverageSummary>([
    ['hotspot_snapshot', { dataset: 'hotspot_snapshot', rows: 1, quality: 'OK' }],
    ['hotspot_candidate', { dataset: 'hotspot_candidate', rows: pool.candidates.length, quality: 'OK' }],
  ]);
  const applySelfCoverage = (list: CoverageSummary[]): CoverageSummary[] =>
    list.map(c => selfCoverage.get(c.dataset) ?? c);
  const sectorCoverage = applySelfCoverage(sectors.coverage);
  const coverage: CoverageSummary[] = applySelfCoverage([
    ...sectors.coverage,
    ...pool.coverage,
    ...weightCoverage(db, etfCodes, asOf),
  ]);
  // Keep the nested sectors payload in lockstep with the top-level coverage so
  // both hash inputs agree (sectors.coverage is itself part of the hash body).
  sectors.coverage = sectorCoverage;
  const body = {
    as_of: asOf,
    config_version: HOTSPOT_CONFIG_VERSION,
    strategy_set_version: HOTSPOT_STRATEGY_SET_VERSION,
    sectors,
    candidates: pool.candidates,
    counts: pool.counts,
    // Independent entry view (goal-1030 WP3): the legacy top-10 stays exactly
    // what priority produced; the entry top-10 may legitimately be empty.
    entry_view: buildEntryView(pool.candidates, asOf),
    coverage,
    research_only: true as const,
  };
  const snapshot: HotspotSnapshot = {
    ...body,
    content_hash: snapshotContentHash(body),
    generated_at: new Date().toISOString(),
  };
  const t2 = Date.now();
  const saved = opts.persist === false
    ? null
    : saveHotspotSnapshot(db, snapshot);
  timings.write = (Date.now() - t2) / 1000;
  timings.total = (Date.now() - startedAt) / 1000;
  return { snapshot, saved, seconds: timings.total, timings };
}
