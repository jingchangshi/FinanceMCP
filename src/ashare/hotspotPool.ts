import type { DatabaseSync } from 'node:sqlite';
import { scanMarket, scoreRows, SCORE_VERSION, type StockRow } from './analysis.js';
import { fundamentalsAsOf } from './fundamentals.js';
import { recentTradeDays } from './ingest.js';
import { computeRps } from './rps.js';
import { swMemberIndex, activeSwMembers } from './industryClassification.js';
import { hotspotTableExists } from './hotspotTables.js';
import type { PoolStrategyScan } from './strategies.js';
import type {
  HotspotSectorSnapshot, HotspotCandidate, EtfSourceRef, LeadershipType,
  TradePermission, DataQuality, SectorKey,
} from './hotspotTypes.js';
import { HOTSPOT_CONFIG_VERSION, HOTSPOT_STRATEGY_SET_VERSION } from './hotspotTypes.js';

/**
 * Dynamic candidate pool generation (goal-1028 §P2.2, architecture.md §5.2).
 *
 * Sources: industry leaders (SW members of selected sectors, ranked by the
 * existing score breakdown), market leaders (full-market RPS120 + trend),
 * ETF core constituents (injected PIT-aware lookup — this module never reads
 * basket quantities or unpublished rows itself), and the ETFs themselves.
 * Dedup key is `ts_code`; multi-ETF origins are retained, never double
 * counted. Focus-pool membership honors SCORE_RULES eligibility, the ≥1亿
 * 20-day amount floor, industry caps, and the real-account permission model
 * (non-mainboard stocks stay RESEARCH_ONLY — consistent with simulateFunded).
 */

export const MAINBOARD_RE = /^(60\d{4}\.SH|00\d{4}\.SZ)$/;

export interface PoolEtfConstituent {
  etf_code: string;
  stock_code: string;
  weight: number | null;
  source: 'index_weight' | 'fund_portfolio' | 'etf_basket_reference';
  effective_date: string | null;
  available_from: string | null;
  quality: DataQuality;
}

export interface PoolOptions {
  /** PIT-aware top constituents per ETF; injected so this module owns no ETF SQL. */
  etfConstituents: (etfCode: string) => PoolEtfConstituent[];
  /** ETFs considered relevant this day (industry/theme declarations + reverse-lookup hits). */
  etfCodes: string[];
  /** ETF names for display; missing ⇒ code used with a hint marker downstream. */
  etfNames?: Record<string, string>;
  /**
   * Lazy strategy scan over the seeded stock codes. Called at most once, after
   * seeds are collected and before candidates are assembled, so the caller
   * pays exactly one strategy pass and this module stays free of strategy SQL.
   * Ignored when `signalScan` is supplied directly (tests, replays).
   */
  signalScanProvider?: (codes: string[]) => PoolStrategyScan | null;
  focusMin?: number;
  focusMax?: number;
  rawMax?: number;
  industryCap?: number;
  leadersPerSector?: number;
  etfTopN?: number;
  marketLeaderTopN?: number;
}

export interface PoolResult {
  candidates: HotspotCandidate[];
  counts: { raw_pool: number; focus_pool: number; excluded: number; etf_candidates: number; with_signals: number };
  coverage: Array<{ dataset: string; rows: number; quality: DataQuality; reason?: string }>;
}

const DEFAULTS = {
  focusMin: 30, focusMax: 50, rawMax: 120, industryCap: 4,
  leadersPerSector: 3, etfTopN: 10, marketLeaderTopN: 10,
};

/** Real SW sector index keys look like `SW2021:801950.SI` (not the name tag `SW2021:industry:…`). */
const SW_INDEX_KEY = /^SW2021:\d{6}\.SI$/;

interface CandidateSeed {
  ts_code: string;
  name: string;
  leaderships: Set<LeadershipType>;
  leader_evidence: HotspotCandidate['leader_evidence'];
  sectors: Set<SectorKey>;
  etf_sources: EtfSourceRef[];
}

function tradePermissionOf(ts_code: string): { perm: TradePermission; reason: string } {
  return MAINBOARD_RE.test(ts_code)
    ? { perm: 'EXECUTABLE', reason: 'MAINBOARD_OK' }
    : { perm: 'RESEARCH_ONLY', reason: ts_code.startsWith('688') ? 'STAR_RESEARCH_ONLY' : ts_code.startsWith('30') || ts_code.startsWith('301') ? 'CHINEXT_RESEARCH_ONLY' : 'NON_MAINBOARD_RESEARCH_ONLY' };
}

export function buildHotspotPool(
  db: DatabaseSync,
  asOf: string,
  sectorSnapshot: HotspotSectorSnapshot,
  signalScan: PoolStrategyScan | null,
  opts: PoolOptions,
): PoolResult {
  const cfg = { ...DEFAULTS, ...opts };
  const scan = scanMarket(db, asOf);
  const rowsByCode = new Map(scan.rows.map(r => [r.ts_code, r]));
  // scoreRows writes score/rank/components onto the row objects (same
  // once-only convention as experimentA.selectPool) — pass scan.rows itself
  // so rowsByCode sees the scored objects.
  const breakdowns = scoreRows(scan.rows, scan.sectors, SCORE_VERSION);
  const fundamentals = fundamentalsAsOf(db, asOf);

  // RPS cross-section at asOf (market-leader ranking).
  const days = recentTradeDays(db, asOf, 260);
  const rps = days.length > 1 ? computeRps(db, days[0], asOf) : null;

  const seeds = new Map<string, CandidateSeed>();
  const seed = (ts: string, name: string): CandidateSeed => {
    let s = seeds.get(ts);
    if (!s) {
      s = { ts_code: ts, name, leaderships: new Set(), leader_evidence: [], sectors: new Set(), etf_sources: [] };
      seeds.set(ts, s);
    }
    return s;
  };

  const selectedSectors = sectorSnapshot.selected
    .map(k => sectorSnapshot.sectors.find(s => s.key === k))
    .filter((s): s is NonNullable<typeof s> => !!s);

  // ---- industry leaders: selected-sector members ranked by existing score.
  // SW members carry in_date/out_date (partial PIT via swMemberIndex). THS
  // members carry no time fields at all (NO_POINT_IN_TIME), so their membership
  // snapshot is usable only from the day we learned it (collected_at <= asOf):
  // a backfill as-of an earlier date contributes no THS leaders instead of
  // replaying current membership into the past (goal P2.3 / data-contracts §2).
  const swRows = hotspotTableExists(db, 'sw_member')
    ? (db.prepare('SELECT ts_code, l1_code, l2_code, l3_code, name, in_date, out_date, is_new FROM sw_member').all() as any[])
    : [];
  const thsMemberRows = hotspotTableExists(db, 'ths_member')
    ? (db.prepare('SELECT ts_code, con_code, collected_at FROM ths_member WHERE collected_at <= ?').all(asOf) as any[])
    : [];
  const thsMembersByIndex = new Map<string, Set<string>>();
  for (const r of thsMemberRows) {
    let set = thsMembersByIndex.get(r.ts_code);
    if (!set) thsMembersByIndex.set(r.ts_code, (set = new Set()));
    set.add(r.con_code);
  }

  const seedIndustryLeaders = (sector: { key: string; name: string }, members: Iterable<string>): void => {
    const ranked = [...members]
      .map(ts => rowsByCode.get(ts))
      .filter((r): r is StockRow => !!r && r.eligible)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.ts_code.localeCompare(b.ts_code))
      .slice(0, cfg.leadersPerSector);
    for (const r of ranked) {
      const s = seed(r.ts_code, r.name);
      s.leaderships.add('INDUSTRY_LEADER');
      s.sectors.add(sector.key);
      const bd = breakdowns.get(r.ts_code);
      s.leader_evidence.push({
        kind: 'INDUSTRY_LEADER',
        metric: `score:${SCORE_VERSION}`,
        value: r.score ?? null,
        note: sector.name + (bd ? ` components=${JSON.stringify(bd.components ?? {})}` : ''),
      });
    }
  };

  for (const sector of selectedSectors) {
    if (sector.key.startsWith('SW2021:')) {
      seedIndustryLeaders(sector, swMemberIndex(swRows, sector.key.slice('SW2021:'.length), asOf).keys());
    } else if (sector.key.startsWith('THS:')) {
      const members = thsMembersByIndex.get(sector.key.slice('THS:'.length));
      if (members) seedIndustryLeaders(sector, members);
    }
  }

  // ---- market leaders: RPS120 top among eligible
  if (rps) {
    const ranked = scan.rows
      .filter(r => r.eligible && (rps.rows.get(r.ts_code)?.rps[120] ?? null) !== null)
      .sort((a, b) => (rps.rows.get(b.ts_code)!.rps[120]! - rps.rows.get(a.ts_code)!.rps[120]!)
        || a.ts_code.localeCompare(b.ts_code))
      .slice(0, cfg.marketLeaderTopN);
    for (const r of ranked) {
      const s = seed(r.ts_code, r.name);
      s.leaderships.add('MARKET_LEADER');
      s.leader_evidence.push({
        kind: 'MARKET_LEADER', metric: 'rps120', value: rps.rows.get(r.ts_code)!.rps[120]!,
      });
      // Primary industry membership when known (stock_basic.industry is current-state; recorded as such).
      const ind = r.industry;
      if (ind) s.sectors.add(`SW2021:industry:${ind}`);
    }
  }

  // ---- ETF core constituents (injected, PIT-resolved by the caller)
  for (const etfCode of opts.etfCodes) {
    const constituents = cfg.etfConstituents(etfCode)
      .filter(c => c.quality !== 'UNAVAILABLE' && c.available_from !== null && c.available_from <= asOf)
      .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
      .slice(0, cfg.etfTopN);
    for (const c of constituents) {
      const row = rowsByCode.get(c.stock_code);
      const s = seed(c.stock_code, row?.name ?? c.stock_code);
      s.etf_sources.push({
        etf_code: etfCode, index_code: null, weight: c.weight,
        source: c.source, effective_date: c.effective_date, available_from: c.available_from,
        quality: c.quality,
      });
    }
  }

  // ---- SW industry membership for every seed (goal P2.5 行业覆盖).
  // The focus industry cap must bucket by each stock's real SW L1 industry;
  // otherwise the 67 ETF constituents — which carry no leader-stamped sector —
  // all collapse into a single pseudo-industry "UNMAPPED" and the cap strangles
  // the pool. Stamping is metadata + bucketing only: it never marks a sector as
  // "selected" (that comes from evaluateHotspotSectors) and uses the same PIT
  // filter as leader selection (activeSwMembers).
  const swL1ByCode = new Map<string, SectorKey>();
  for (const row of activeSwMembers(swRows, asOf)) {
    if (!swL1ByCode.has(row.ts_code)) swL1ByCode.set(row.ts_code, `SW2021:${row.l1_code}`);
  }
  for (const s of seeds.values()) {
    const key = swL1ByCode.get(s.ts_code);
    if (key && !s.sectors.has(key)) s.sectors.add(key);
  }

  // ---- assemble candidates
  // Lazy scan: the provider sees exactly the seeded stock codes (industry +
  // market leaders + ETF constituents) and runs at most once per pool build.
  let strategyScan = signalScan;
  if (!strategyScan && opts.signalScanProvider) {
    strategyScan = opts.signalScanProvider([...seeds.keys()]);
  }
  const signalByCode = new Map((strategyScan?.results ?? []).map(r => [r.ts_code, r]));
  const candidates: HotspotCandidate[] = [];
  for (const s of seeds.values()) {
    const row = rowsByCode.get(s.ts_code);
    const scanSignals = signalByCode.get(s.ts_code);
    const etfSet = new Set(s.etf_sources.map(e => e.etf_code));
    const multiEtf = etfSet.size >= 2;
    const { perm, reason } = tradePermissionOf(s.ts_code);
    const f = fundamentals.get(s.ts_code);

    // Inclusion logic for RAW/FOCUS.
    const eligible = row?.eligible ?? false;
    const liquid = (row?.amount20_yi ?? 0) >= 1; // ≥ 1亿 20日均额
    const sectorKeys = [...s.sectors];
    // Focus industry-cap bucket: a real SW L1 index key first, then a THS
    // theme, then the current-state industry name tag. The name tag must not
    // outrank a real index key, and THS-only stocks must not collapse into
    // UNMAPPED with everyone else (UNMAPPED is genuinely for unknowns only).
    const primarySector = sectorKeys.find(k => SW_INDEX_KEY.test(k))
      ?? sectorKeys.find(k => k.startsWith('THS:'))
      ?? sectorKeys.find(k => k.startsWith('SW2021:'))
      ?? null;

    let pool: HotspotCandidate['pool'] = 'EXCLUDED';
    let inclusion = '';
    let exclusion: string | undefined;
    if (!row) { exclusion = 'not_in_scan_market'; }
    else if (!eligible) { exclusion = row.ineligible_reason ?? 'ineligible'; }
    else if (!liquid && s.etf_sources.length === 0) { exclusion = 'below_liquidity_floor'; }
    else { pool = 'RAW'; inclusion = [...s.leaderships].join('+') || 'etf_constituent'; }
    if (pool === 'EXCLUDED' && !exclusion) exclusion = 'unknown';

    // Priority: score percentile + rps + signals − risk-overlay penalty, all
    // recorded. Each risk event weighs the same as each signal (±5, both
    // capped at 15): a conflicted name is demoted, never silently kept beside
    // an equally-scored clean one (strategies.ts: pool ranking penalizes
    // conflicted names). Floor at 0 — a heavy risk load ranks at the bottom,
    // not below "unknown priority".
    const score = row?.score ?? null;
    const rps120 = rps ? (rps.rows.get(s.ts_code)?.rps[120] ?? null) : null;
    // Lifecycle (goal-1030 WP1): only signals whose contract still holds count.
    // `confirmed` means confirmed on the as-of bar itself and counts too.
    const sigCount = scanSignals?.events.filter(e => e.status === 'active' || e.status === 'confirmed').length ?? 0;
    // The legacy priority formula consumed one entry per risk *firing*; the wire
    // now carries episodes, so keep the raw count for a byte-compatible rollout.
    const riskCount = (scanSignals?.risk_firings ?? scanSignals?.risk_events ?? []).length;
    const priority = score !== null || rps120 !== null
      ? Math.max(0, Math.round(((score !== null ? Math.max(0, Math.min(100, (score ?? 0) * 100)) : 50) * 0.5
        + (rps120 ?? 50) * 0.35 + Math.min(15, sigCount * 5) - Math.min(15, riskCount * 5)) * 100) / 100)
      : null;

    candidates.push({
      as_of: asOf,
      ts_code: s.ts_code,
      name: s.name,
      instrument_type: 'STOCK',
      primary_sector: primarySector,
      sectors: sectorKeys,
      etf_sources: s.etf_sources,
      multi_etf: multiEtf,
      leaderships: [...s.leaderships],
      leader_evidence: s.leader_evidence,
      signals: (scanSignals?.events ?? []).map(e => ({
        strategy_id: e.strategy_id, family: e.family, direction: e.direction,
        confirmed_on: e.confirmed_on, formed_on: e.formed_on,
        confirmation_lag: e.confirmation_lag,
        invalidation: e.invalidation ? `${e.invalidation.on}:${e.invalidation.reason}` : e.invalidation_conditions,
        status: e.status,
        signal_id: e.signal_id ?? `${e.ts_code}:${e.strategy_id}:${e.confirmed_on}`,
        strategy_version: e.strategy_version,
        last_validated_on: e.last_validated_on ?? asOf,
        invalidated_on: e.invalidated_on ?? null,
        expired_on: e.expired_on ?? null,
        invalidation_reason: e.invalidation_reason ?? null,
        signal_age_trade_days: e.signal_age_trade_days ?? null,
        max_age_trade_days: e.max_age_trade_days ?? null,
        conflicting_risks: e.conflicting_risks ?? [],
        source_data_as_of: e.source_data_as_of ?? asOf,
      })),
      forming: scanSignals?.forming ?? [],
      signal_counts: (() => {
        const c: Record<string, number> = {
          total: 0, confirmed: 0, active: 0, invalidated: 0, expired: 0, insufficient_data: 0,
        };
        for (const e of scanSignals?.events ?? []) { c[e.status] += 1; c.total += 1; }
        return c as HotspotCandidate['signal_counts'];
      })(),
      risk_events: (scanSignals?.risk_events ?? []).map(r => ({
        id: r.id, on: r.on, last_on: r.last_on ?? r.on, bars: r.bars ?? 1,
      })),
      trade_permission: perm,
      trade_permission_reason: reason,
      pool,
      inclusion_reason: inclusion,
      exclusion_reason: exclusion,
      priority,
      priority_reason: `score(${score ?? 'n/a'})*0.5 + rps120(${rps120 ?? 'n/a'})*0.35 + signals(${sigCount})*5 - risk(${riskCount})*5`,
      data_quality: pool === 'EXCLUDED' ? 'DEGRADED' : 'OK',
    });
    void f; // fundamentals reserved for INDUSTRY_LEADER evidence enrichment in v2
  }

  // ---- ETFs themselves as research candidates
  for (const etfCode of opts.etfCodes) {
    const name = opts.etfNames?.[etfCode] ?? etfCode;
    candidates.push({
      as_of: asOf, ts_code: etfCode, name, instrument_type: 'ETF',
      primary_sector: null, sectors: [], etf_sources: [], multi_etf: false,
      leaderships: [], leader_evidence: [], signals: [], risk_events: [],
      forming: [],
      signal_counts: { total: 0, confirmed: 0, active: 0, invalidated: 0, expired: 0, insufficient_data: 0 },
      trade_permission: 'EXECUTABLE', trade_permission_reason: 'ETF_UNIVERSAL',
      pool: 'RAW', inclusion_reason: 'relevant_etf',
      priority: null, priority_reason: 'etf vehicle; no stock ranking applies',
      data_quality: 'OK',
    });
  }

  // ---- focus selection with industry cap (stocks only)
  const stocks = candidates.filter(c => c.pool === 'RAW' && c.instrument_type === 'STOCK');
  const industryCount = new Map<string, number>();
  const focusCodes = new Set<string>();
  for (const c of [...stocks].sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1) || a.ts_code.localeCompare(b.ts_code))) {
    if (focusCodes.size >= cfg.focusMax) break;
    const bucket = c.primary_sector ?? 'UNMAPPED';
    const used = industryCount.get(bucket) ?? 0;
    if (used >= cfg.industryCap) continue;
    // Executable-or-research both allowed in focus; permission is carried per row.
    industryCount.set(bucket, used + 1);
    focusCodes.add(c.ts_code);
  }
  for (const c of candidates) {
    if (c.instrument_type === 'STOCK' && c.pool === 'RAW') {
      if (focusCodes.has(c.ts_code)) {
        c.pool = 'FOCUS';
        c.inclusion_reason = `${c.inclusion_reason}|focus#${[...focusCodes].indexOf(c.ts_code) + 1}`;
      } else if (industryCount.get(c.primary_sector ?? 'UNMAPPED') !== undefined
        && (industryCount.get(c.primary_sector ?? 'UNMAPPED') ?? 0) >= cfg.industryCap
        && c.priority !== null) {
        c.exclusion_reason = 'industry_cap';
        c.pool = 'EXCLUDED';
      } else {
        c.exclusion_reason = 'below_focus_cutoff';
        c.pool = 'EXCLUDED';
      }
    }
  }

  const counts = {
    raw_pool: candidates.filter(c => c.pool !== 'EXCLUDED' && c.instrument_type === 'STOCK').length,
    focus_pool: candidates.filter(c => c.pool === 'FOCUS').length,
    excluded: candidates.filter(c => c.pool === 'EXCLUDED').length,
    etf_candidates: candidates.filter(c => c.instrument_type === 'ETF').length,
    with_signals: candidates.filter(c => c.signals.length > 0).length,
  };
  const coverage = [
    { dataset: 'scan_market', rows: scan.rows.length, quality: 'OK' as DataQuality },
    { dataset: 'rps_cross_section', rows: rps?.universe ?? 0, quality: (rps?.universe ?? 0) > 0 ? 'OK' as DataQuality : 'UNAVAILABLE' as DataQuality, ...(rps?.universe ? {} : { reason: 'insufficient_history' }) },
    { dataset: 'strategy_scan', rows: strategyScan?.coverage.scanned ?? 0, quality: strategyScan ? 'OK' as DataQuality : 'UNAVAILABLE' as DataQuality, ...(strategyScan ? {} : { reason: 'not_run' }) },
  ];
  return { candidates, counts, coverage };
}

export const POOL_CONFIG_VERSION = HOTSPOT_CONFIG_VERSION;
export const POOL_STRATEGY_SET_VERSION = HOTSPOT_STRATEGY_SET_VERSION;
