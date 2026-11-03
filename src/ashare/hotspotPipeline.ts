import type { DatabaseSync } from 'node:sqlite';
import { evaluateHotspotSectors } from './hotspot.js';
import { saveHotspotSnapshot, snapshotContentHash, SNAPSHOT_HASH_BASIS } from './hotspotSnapshots.js';
import { dataState } from './dataReadiness.js';
import { topConstituents, weightCoverage } from './etfWeightStore.js';
import { ETF_CANDIDATE_DECLARATIONS } from './etfDeclarations.js';
import { scanMarket } from './analysis.js';
import { recentTradeDays } from './ingest.js';
import { computeRps } from './rps.js';
import {
  analyzeTechnicalV2, createTechnicalPrescreen, forcedResearchCodes, unavailableTechnicalView,
} from './technicalCandidatesV2.js';
import {
  HOTSPOT_CONFIG_VERSION, sectorLocalCode, type HotspotSnapshot, type CoverageSummary,
} from './hotspotTypes.js';
import type { HotspotConfig } from './hotspot.js';

/**
 * Daily research snapshot orchestrator — V2 is the only production path.
 *
 * One entry point wires the whole research surface for a single as-of day:
 *
 *   1. sector identification — evaluateHotspotSectors (SW L1 + THS themes)
 *   2. representative ETFs  — PIT constituents whose stocks belong to the
 *                             sector; calculated independently of any stock
 *                             ranking (an ETF is evidence, not a seed)
 *   3. full-market V2 scan  — ONE scanMarket pass feeds the per-family
 *                             prescreen; only the union is loaded again
 *   4. technical view       — five independent families + the single per-stock
 *                             research state
 *   5. persistence          — saveHotspotSnapshot (content-hash identical
 *                             regenerations replace, never fork history)
 *
 * Removed in this rebuild: the V1 candidate pool, its priority ranking, the
 * entry view and the per-candidate mirror. A stock's research record exists
 * once, in `technical_view.research_universe`.
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
  /** Set false for a dry run: compute everything, persist nothing. */
  persist?: boolean;
}

export interface HotspotPipelineResult {
  snapshot: HotspotSnapshot;
  saved: {
    content_hash: string; replaced: boolean;
    version_no: number; state: string; superseded_version: number | null; hash_basis: string;
  } | null;
  seconds: number;
  /**
   * goal-1032 publish gate. NOT_READY means the pipeline computed but refused to
   * persist: there is no honest snapshot for a day whose bars/quality gate fails.
   * DEGRADED publishes, and the mark travels inside `data_state.readiness`.
   */
  readiness: { status: 'READY' | 'DEGRADED' | 'NOT_READY'; reason: string | null };
  /**
   * Phase timings for the performance record. Diagnostic only — deliberately
   * OUTSIDE the snapshot body so it never perturbs content_hash.
   */
  timings: { sectors: number; rps: number; technical: number; write: number; total: number };
}

/** Industry/theme ETFs the research surface considers relevant by declaration. */
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

interface EtfRef { etf_code: string; name?: string; index_code?: string | null }

/**
 * Sector → representative ETFs, from PIT ETF constituents and sw_member.
 *
 * A sector is represented by an ETF only when one of that ETF's dated
 * constituents actually belongs to the sector on `asOf`. There is no ranking
 * input here at all: the mapping cannot tilt which stocks are researched, and
 * it is deterministic (sorted by etf_code) so the snapshot hash is stable.
 * THS themes have no member table in this database and therefore stay empty
 * rather than being inferred from names.
 */
function representativeEtfsBySector(
  db: DatabaseSync,
  asOf: string,
  sectors: Array<{ key: string; source: 'SW2021' | 'THS' }>,
  etfCodes: string[],
  etfNames: Record<string, string>,
  topN: number,
): Map<string, EtfRef[]> {
  const out = new Map<string, EtfRef[]>();
  const sw = sectors.filter(s => s.source === 'SW2021');
  if (sw.length === 0 || etfCodes.length === 0) return out;

  let memberRows: Array<{ ts_code: string; l1_code: string; in_date: string | null; out_date: string | null }> = [];
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sw_member'").get();
    if (exists) {
      memberRows = db.prepare('SELECT ts_code, l1_code, in_date, out_date FROM sw_member').all() as any[];
    }
  } catch { memberRows = []; }
  if (memberRows.length === 0) return out;

  const active = memberRows.filter(m =>
    (!m.in_date || m.in_date <= asOf) && (!m.out_date || m.out_date > asOf));
  const l1ByStock = new Map<string, Set<string>>();
  for (const m of active) {
    let set = l1ByStock.get(m.ts_code);
    if (!set) l1ByStock.set(m.ts_code, (set = new Set()));
    set.add(m.l1_code);
  }

  const bySector = new Map<string, Map<string, EtfRef>>();
  for (const sector of sw) bySector.set(sector.key, new Map());
  for (const etfCode of [...etfCodes].sort()) {
    let rows: Array<{ stock_code: string }> = [];
    try {
      rows = topConstituents(db, etfCode, asOf, topN);
    } catch { rows = []; }
    if (rows.length === 0) continue;
    const hit = new Set<string>();
    for (const r of rows) {
      if (r.stock_code === etfCode) continue;
      for (const l1 of l1ByStock.get(r.stock_code) ?? []) hit.add(l1);
    }
    if (hit.size === 0) continue;
    for (const sector of sw) {
      if (!hit.has(sectorLocalCode(sector.key))) continue;
      bySector.get(sector.key)!.set(etfCode, {
        etf_code: etfCode,
        ...(etfNames[etfCode] ? { name: etfNames[etfCode] } : {}),
        index_code: null,
      });
    }
  }
  for (const [key, m] of bySector) {
    if (m.size) out.set(key, [...m.values()].sort((a, b) => a.etf_code.localeCompare(b.etf_code)));
  }
  return out;
}

/** Run the full research pipeline for one as-of day. */
export function runHotspotPipeline(
  db: DatabaseSync,
  asOf: string,
  opts: HotspotPipelineOptions = {},
): HotspotPipelineResult {
  const startedAt = Date.now();
  const timings = { sectors: 0, rps: 0, technical: 0, write: 0, total: 0 };
  const config = opts.config;

  // 1. Sector identification (SW L1 + THS themes, ranked with state machine).
  const t0 = Date.now();
  const sectors = evaluateHotspotSectors(db, asOf, config);
  timings.sectors = (Date.now() - t0) / 1000;

  // 2. ETF universe + representative mapping (evidence only, never a seed).
  const etfCodes = opts.etfCodes ?? defaultHotspotEtfCodes();
  const etfNames = opts.etfNames ?? etfDisplayNames(db, etfCodes);
  const reps = representativeEtfsBySector(
    db, asOf, sectors.sectors.map(s => ({ key: s.key, source: s.source })), etfCodes, etfNames, 20);
  for (const s of sectors.sectors) {
    const list = reps.get(s.key) ?? [];
    if (list.length) s.representative_etfs = list;
  }

  // 3. One full-market pass feeds the per-family prescreen. RPS is a background
  //    feature only — no family gates on it, so a low-RPS reversal still enters.
  const prescreen = createTechnicalPrescreen();
  scanMarket(db, asOf, {
    onStock: (code, bars, x, i, row) => prescreen.observe(code, bars, x, i, row),
  });
  const t1 = Date.now();
  const days = recentTradeDays(db, asOf, 260);
  const rps = days.length > 1 ? computeRps(db, days[0], asOf) : null;
  timings.rps = (Date.now() - t1) / 1000;

  // 4. Technical methodology V2 (the only decision framework).
  const t2 = Date.now();
  let technicalView;
  try {
    technicalView = analyzeTechnicalV2(db, {
      asOf,
      prescreen: prescreen.finish(),
      rps,
      forcedCodes: forcedResearchCodes(db, asOf),
    });
  } catch (e) {
    technicalView = unavailableTechnicalView(asOf, e instanceof Error ? e.message : String(e));
  }
  timings.technical = (Date.now() - t2) / 1000;

  // 5. Assemble + persist.
  //
  // Self-referential coverage (acceptance E9): the hotspot_snapshot entry
  // describes THIS run's own write, not the table state observed before it.
  const selfCoverage = new Map<string, CoverageSummary>([
    ['hotspot_snapshot', { dataset: 'hotspot_snapshot', rows: 1, quality: 'OK' }],
  ]);
  const applySelfCoverage = (list: CoverageSummary[]): CoverageSummary[] =>
    list.map(c => selfCoverage.get(c.dataset) ?? c);
  const sectorCoverage = applySelfCoverage(sectors.coverage);
  const coverage: CoverageSummary[] = applySelfCoverage([
    ...sectors.coverage,
    ...weightCoverage(db, etfCodes, asOf),
  ]);
  // Keep the nested sectors payload in lockstep with the top-level coverage so
  // both hash inputs agree (sectors.coverage is itself part of the hash body).
  sectors.coverage = sectorCoverage;

  // goal-1032: the fingerprint of the data this run actually read. Computed
  // before the body so that it is part of `content_hash`, and read as a publish
  // gate so a NOT_READY day is never written.
  const state = dataState(db, asOf);
  const body = {
    as_of: asOf,
    framework: 'V2_ONLY' as const,
    framework_version: technicalView.framework_version,
    implementation_fingerprint: technicalView.implementation_fingerprint,
    config_version: HOTSPOT_CONFIG_VERSION,
    sectors,
    technical_view: technicalView,
    coverage,
    data_state: state,
    data_quality: state.readiness,
    market_data_as_of: state.fingerprint.bars.daily > 0 ? asOf : null,
    research_only: true as const,
  };
  const snapshot: HotspotSnapshot = {
    ...body,
    content_hash: snapshotContentHash(body),
    generated_at: new Date().toISOString(),
  };
  const t3 = Date.now();
  const saved = opts.persist === false || state.readiness === 'NOT_READY'
    ? null
    : saveHotspotSnapshot(db, snapshot);
  timings.write = (Date.now() - t3) / 1000;
  timings.total = (Date.now() - startedAt) / 1000;
  return {
    snapshot, saved, seconds: timings.total, timings,
    readiness: { status: state.readiness, reason: state.readiness_reason },
  };
}
