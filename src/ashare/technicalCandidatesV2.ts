/**
 * Technical-analysis methodology V2 — discovery, analysis and rendering.
 *
 * Discovery is deliberately independent of the V1 entry machinery:
 *
 *   1. one full-market pass (the SAME `scanMarket` pass the legacy pool
 *      already pays for) records the stocks that pass the basic eligibility
 *      gates and, as a diagnostic, a cheap per-family prescreen vector;
 *   2. every eligible stock is loaded for the detailed five-family pattern
 *      analysis. The per-family/union capacity caps are NOT applied to that
 *      analysis: goal-1106 WP5 measured active patterns (CONFIRMED /
 *      FOLLOW_THROUGH / FORMING) missing from the capped union on every
 *      audited day, so the prescreen may only report, never gate.
 *
 * The prescreen never reads `FOCUS`, `priority`, `entry_score` or RPS as a
 * gate. A low-RPS name making a lower low with a higher DIF low is visible
 * here; that is the point of the redesign.
 */
import type { DatabaseSync } from 'node:sqlite';
import { scanMarket } from './analysis.js';
import { forEachStockBars } from './bars.js';
import { tradeDayGate } from './dataReadiness.js';
import { computeIndicators, type Bars, type IndicatorSet } from './indicators.js';
import { recentTradeDays } from './ingest.js';
import { regimeSeries, type Regime } from './market.js';
import type { RpsResult } from './rps.js';
import {
  TECHNICAL_FRAMEWORK_VERSION, TECHNICAL_FAMILIES, FAMILY_LABELS, METHODOLOGY_NOTE,
  buildPriceVolumeContext, compareCandidates, emptyStageCounts,
  researchReadiness, technicalImplementationFingerprint,
  type PatternInput, type PriceVolumeContext,
  type TechnicalCandidateV2, type TechnicalFamily, type TechnicalFamilyView,
  type TechnicalStage, type TechnicalViewV2,
} from './technicalFrameworkV2.js';
import { detectAllPatterns, PATTERN_DEFINITIONS_V2 } from './technicalPatternsV2.js';
import { buildResearchUniverse } from './technicalResearchStateV2.js';

/** Ranking capacity is a diagnostic, not a gate (goal-1106 WP5). */
export const TECHNICAL_CAPACITY = {
  perFamily: 120,
  union: 500,
  /** 20-day average turnover floor for the research list (亿元), cost control only. */
  minAmount20Yi: 0.5,
  /** Bars needed before any V2 family may speak. */
  minBars: 130,
} as const;

export const TECHNICAL_DISCOVERY_VERSION = 'technical-discovery-1.0.0';

// ---------------------------------------------------------------- prescreen

export interface PrescreenEntry {
  ts_code: string;
  name: string;
  rank: number;
}

export interface PrescreenResult {
  universe: number;
  /** Diagnostic only: what the legacy per-family ranking would have kept. */
  perFamily: Record<TechnicalFamily, PrescreenEntry[]>;
  /**
   * Every stock that passes the basic eligibility gates (no ST/delisting
   * marker, no missing adjustment factor, ≥130 bars, 20-day turnover ≥0.5亿).
   * This is the detailed-analysis universe; capacity caps never remove a name
   * from it.
   */
  eligible: PrescreenEntry[];
  /** Diagnostic only: entries the legacy ranking would have truncated. */
  capacity_limited: number;
}

export interface TechnicalPrescreen {
  /** Hook for `scanMarket`: copy numbers only, never retain bars/indicators. */
  observe(code: string, bars: Bars, x: IndicatorSet, i: number, row: {
    name: string; amount20_yi: number; ineligible_reason?: string;
  }): void;
  finish(): PrescreenResult;
}

const finite = (v: number | undefined | null): v is number => typeof v === 'number' && Number.isFinite(v);
const isSt = (name: string) => /ST|退/.test(name ?? '');

function minFrom(values: number[], from: number, to: number): number {
  let m = Infinity;
  for (let j = Math.max(0, from); j <= to; j++) if (finite(values[j]) && values[j] < m) m = values[j];
  return m;
}

function maxFrom(values: number[], from: number, to: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, from); j <= to; j++) if (finite(values[j]) && values[j] > m) m = values[j];
  return m;
}

function argMinFrom(values: number[], from: number, to: number): number {
  let best = -1;
  for (let j = Math.max(0, from); j <= to; j++) if (finite(values[j]) && (best < 0 || values[j] < values[best])) best = j;
  return best;
}

/** Percentile of `current` inside the prior `period` widths (0..1), null if too few. */
function widthPercentile(widths: number[], i: number, current: number, period = 120): number | null {
  if (i < 1) return null;
  const window: number[] = [];
  for (let j = Math.max(0, i - period); j < i; j++) if (finite(widths[j])) window.push(widths[j]);
  if (window.length < 100) return null;
  return window.filter(v => v <= current).length / window.length;
}

/**
 * Prescreen collector. The caller passes `observe` as `scanMarket`'s onStock
 * hook, then calls `finish()`. Nothing here is a signal: the detailed pass
 * re-decides every family from the bars.
 */
export function createTechnicalPrescreen(): TechnicalPrescreen {
  const lists: Record<TechnicalFamily, Array<{ ts_code: string; name: string; metric: number }>> = {
    TREND_CONTINUATION: [], PLATFORM_BREAKOUT: [], REVERSAL: [], VOLATILITY_EXPANSION: [], MEAN_REVERSION: [],
  };
  let universe = 0;
  let capacityLimited = 0;
  const eligible: Array<{ ts_code: string; name: string }> = [];
  const push = (family: TechnicalFamily, code: string, name: string, metric: number): void => {
    lists[family].push({ ts_code: code, name, metric });
  };
  return {
    observe(code, b, x, i, row) {
      universe++;
      if (isSt(row.name)) return;
      if ((b.adjMissing ?? 0) > 0) return;
      if (b.dates.length < TECHNICAL_CAPACITY.minBars) return;
      if (!finite(row.amount20_yi) || row.amount20_yi < TECHNICAL_CAPACITY.minAmount20Yi) return;
      const c = b.close[i];
      const m20 = x.ma20[i], m60 = x.ma60[i], rsi = x.rsi14[i], bw = x.bollWidth[i];
      if (!finite(c)) return;
      eligible.push({ ts_code: code, name: row.name });
      const name = row.name;
      // Each condition is deliberately LOOSER than the detector: the detailed
      // pass makes the real decision, the prescreen only protects recall.
      if (finite(m20) && m20 > 0 && finite(m60) && m20 > m60) {
        push('TREND_CONTINUATION', code, name, Math.abs(c / m20 - 1));
      } else if (finite(m20) && finite(x.ma20[i - 5]) && m20 > x.ma20[i - 5] && c >= m20 * 0.98) {
        push('TREND_CONTINUATION', code, name, Math.abs(c / m20 - 1) + 0.5);
      }
      const high60 = maxFrom(b.high, i - 60, i - 1);
      if (finite(high60) && high60 > 0 && c >= high60 * 0.88
        && ((finite(bw) && bw <= 0.30) || c > high60)) {
        // A broken-out name that already expanded keeps its place; a still
        // accelerating run-up is ranked behind genuine platforms.
        const runup = finite(b.close[i - 20]) && b.close[i - 20] > 0 ? c / b.close[i - 20] - 1 : 1;
        push('PLATFORM_BREAKOUT', code, name, Math.max(0, high60 / c - 1) + (runup > 0.25 ? 1 : 0));
      }
      const low60Idx = argMinFrom(b.low, i - 60, i);
      const low120 = minFrom(b.low, i - 120, i);
      const recentLow = low60Idx >= i - 40;
      if ((finite(rsi) && rsi < 45) || recentLow || (finite(low120) && low120 > 0 && c <= low120 * 1.10)) {
        push('REVERSAL', code, name, finite(rsi) ? rsi : 100);
      }
      const bwPct = finite(bw) ? widthPercentile(x.bollWidth, i, bw) : null;
      if ((bwPct !== null && bwPct <= 0.35) || (finite(x.bollUp[i]) && c >= x.bollUp[i])) {
        push('VOLATILITY_EXPANSION', code, name, bwPct ?? 1);
      }
      let rsiLow12: number | null = null;
      for (let j = Math.max(0, i - 12); j <= i; j++) {
        if (finite(x.rsi14[j]) && (rsiLow12 === null || x.rsi14[j] < rsiLow12)) rsiLow12 = x.rsi14[j];
      }
      const touchedLowerBand = (() => {
        for (let j = Math.max(0, i - 12); j <= i; j++) {
          if (finite(b.close[j]) && finite(x.bollLow[j]) && b.close[j] <= x.bollLow[j] * 1.03) return true;
        }
        return false;
      })();
      if ((rsiLow12 !== null && rsiLow12 < 32) || touchedLowerBand || (finite(rsi) && rsi < 40)) {
        push('MEAN_REVERSION', code, name, finite(rsi) ? rsi : 100);
      }
    },
    finish() {
      const perFamily = {} as Record<TechnicalFamily, PrescreenEntry[]>;
      const ranked: Record<TechnicalFamily, PrescreenEntry[]> = {} as any;
      for (const family of TECHNICAL_FAMILIES) {
        const sorted = [...lists[family]].sort((a, b) => a.metric - b.metric || a.ts_code.localeCompare(b.ts_code));
        ranked[family] = sorted.slice(0, TECHNICAL_CAPACITY.perFamily)
          .map(({ ts_code, name }) => ({ ts_code, name, rank: 0 }));
        if (sorted.length > TECHNICAL_CAPACITY.perFamily) capacityLimited += sorted.length - TECHNICAL_CAPACITY.perFamily;
        perFamily[family] = ranked[family];
      }
      // Round-robin across families keeps the global cap from systematically
      // starving one family when the market is crowded.
      const codeSet = new Set<string>();
      const familySet: Record<TechnicalFamily, Set<string>> = {
        TREND_CONTINUATION: new Set(), PLATFORM_BREAKOUT: new Set(), REVERSAL: new Set(),
        VOLATILITY_EXPANSION: new Set(), MEAN_REVERSION: new Set(),
      };
      let added = true;
      for (let round = 0; added && codeSet.size < TECHNICAL_CAPACITY.union; round++) {
        added = false;
        for (const family of TECHNICAL_FAMILIES) {
          if (codeSet.size >= TECHNICAL_CAPACITY.union) break;
          const entry = ranked[family][round];
          if (!entry) continue;
          familySet[family].add(entry.ts_code);
          codeSet.add(entry.ts_code);
          added = true;
        }
      }
      for (const family of TECHNICAL_FAMILIES) {
        const kept = ranked[family].filter(e => familySet[family].has(e.ts_code));
        capacityLimited += ranked[family].length - kept.length;
        perFamily[family] = kept.map((e, k) => ({ ...e, rank: k + 1 }));
      }
      return {
        universe,
        perFamily,
        eligible: [...eligible].sort((a, b) => a.ts_code.localeCompare(b.ts_code))
          .map(({ ts_code, name }) => ({ ts_code, name, rank: 0 })),
        capacity_limited: capacityLimited,
      };
    },
  };
}

// ---------------------------------------------------------------- analysis

export interface TechnicalAnalysisOptions {
  asOf: string;
  prescreen: PrescreenResult;
  /** RPS cross-section from the same pass, background only. */
  rps?: RpsResult | null;
  regime?: Regime | 'UNKNOWN';
  barCount?: number;
  /** Codes that must be evaluated even without an as-of bar (e.g. suspended names). */
  forcedCodes?: Array<{ ts_code: string; name?: string }>;
}

function nameMap(db: DatabaseSync, codes: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const chunk = 500;
  for (let k = 0; k < codes.length; k += chunk) {
    const part = codes.slice(k, k + chunk);
    if (!part.length) continue;
    const rows = db.prepare(`SELECT ts_code, name FROM stock_basic WHERE ts_code IN (${part.map(() => '?').join(',')})`)
      .all(...part) as Array<{ ts_code: string; name: string }>;
    for (const r of rows) out.set(r.ts_code, r.name);
  }
  return out;
}

function suspendedOn(db: DatabaseSync, asOf: string): Set<string> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suspend_d'").get();
  if (!exists) return new Set();
  return new Set((db.prepare('SELECT ts_code FROM suspend_d WHERE trade_date = ?').all(asOf) as Array<{ ts_code: string }>)
    .map(r => r.ts_code));
}

/**
 * SW2021 L1 membership as of `asOf`, for report readability and holding-overlap
 * disclosure only. It is never a discovery seed, a gate or a ranking input —
 * a stock with no mapped industry still gets its signals and its state.
 */
function sectorMembership(db: DatabaseSync, asOf: string, codes: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sw_member'").get();
  if (!exists || codes.length === 0) return out;
  const rows = db.prepare('SELECT ts_code, l1_code, in_date, out_date FROM sw_member').all() as Array<{
    ts_code: string; l1_code: string; in_date: string | null; out_date: string | null;
  }>;
  const wanted = new Set(codes);
  for (const r of rows) {
    if (!wanted.has(r.ts_code)) continue;
    if (r.in_date && r.in_date > asOf) continue;
    if (r.out_date && r.out_date <= asOf) continue;
    const list = out.get(r.ts_code);
    if (list) { if (!list.includes(`SW2021:${r.l1_code}`)) list.push(`SW2021:${r.l1_code}`); }
    else out.set(r.ts_code, [`SW2021:${r.l1_code}`]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

function calendarIndex(days: string[]): Map<string, number> {
  return new Map(days.map((d, i) => [d, i]));
}

/** Trade-day distance from the last bar to asOf on the exchange calendar. */
function barsBehind(lastBar: string, asOf: string, index: Map<string, number>): number {
  const a = index.get(asOf), b = index.get(lastBar);
  return a === undefined || b === undefined ? 0 : Math.max(0, a - b);
}

/**
 * Run the detailed V2 analysis for one as-of day over every eligible stock
 * (plus suspended / one-price-limit names the prescreen cannot observe).
 * Only bars with `trade_date <= asOf` are read (forEachStockBars guarantees
 * it); a stock without an as-of bar keeps its last bar and is marked stale.
 */
export function analyzeTechnicalV2(db: DatabaseSync, opts: TechnicalAnalysisOptions): TechnicalViewV2 {
  const asOf = opts.asOf;
  // A known closed day has no same-day research view. Refusing here (not only
  // in the publish gate) keeps every caller — pipeline, CLI preview, tests —
  // from reading Friday's bars under a Saturday as-of label (C13).
  const calendar = tradeDayGate(db, asOf);
  if (calendar.known && !calendar.open) {
    return unavailableTechnicalView(
      asOf,
      `${asOf} 非交易日：最近已完成交易日 ${calendar.previous ?? '未知'}，请以该交易日运行`,
    );
  }
  const barCount = opts.barCount ?? 330;
  const days = recentTradeDays(db, asOf, barCount); // ascending, ends at asOf
  const dayIndex = calendarIndex(days);
  // Recursive indicators (EMA/RSI/ATR) are seeded at their first bar, so a
  // rolling left edge re-seeds them on every as-of and can move a
  // near-threshold event by a day. Read each stock from its first bar up to
  // asOf instead: the seed then never depends on the as-of. The detectors still
  // look back only inside their own declared windows; `days` remains the
  // trading-day index for `barsBehindAsOf`.
  const HISTORY_START = '19000101';
  const suspended = suspendedOn(db, asOf);
  const regimeMap = opts.regime ? null : regimeSeries(db, asOf);
  const regime = opts.regime ?? regimeMap?.get(asOf) ?? 'UNKNOWN';
  const regimeAt = regimeMap ? (d: string) => regimeMap.get(d) ?? null : undefined;

  const forced = new Map<string, string>();
  for (const f of opts.forcedCodes ?? []) forced.set(f.ts_code, f.name ?? f.ts_code);
  const codeSet = new Set<string>([...forced.keys()]);
  // Every eligible name is analysed in full. The per-family prescreen lists are
  // retained for diagnostics only; using them here would re-introduce the
  // capacity truncation that WP5 measured as a recall loss.
  for (const e of opts.prescreen.eligible) codeSet.add(e.ts_code);
  const codes = [...codeSet].sort();
  const names = nameMap(db, codes);
  for (const [code, fallback] of forced) if (!names.has(code)) names.set(code, fallback);

  const candidates: TechnicalCandidateV2[] = [];
  const contexts = new Map<string, PriceVolumeContext>();
  const coverage = {
    universe: opts.prescreen.universe,
    preselected: codes.length,
    analyzed: 0,
    skipped_adj_missing: 0,
    skipped_insufficient: 0,
    capacity_limited: opts.prescreen.capacity_limited,
  };

  forEachStockBars(db, HISTORY_START, asOf, (code, bars) => {
    if ((bars.adjMissing ?? 0) > 0) { coverage.skipped_adj_missing++; return; }
    if (bars.dates.length < TECHNICAL_CAPACITY.minBars) { coverage.skipped_insufficient++; return; }
    const i = bars.dates.length - 1;
    const x = computeIndicators(bars);
    const lastBar = bars.dates[i];
    const behind = barsBehind(lastBar, asOf, dayIndex);
    const rps120 = opts.rps?.rows.get(code)?.rps[120] ?? null;
    const pctChg = i >= 1 && finite(bars.rawClose[i]) && finite(bars.rawClose[i - 1]) && bars.rawClose[i - 1] > 0
      ? bars.rawClose[i] / bars.rawClose[i - 1] - 1 : null;
    const volRatio = finite(x.volMa20[i]) && x.volMa20[i] > 0 ? bars.vol[i] / x.volMa20[i] : null;
    const atrPct = finite(x.atr14[i]) && finite(bars.close[i]) && bars.close[i] > 0 ? x.atr14[i] / bars.close[i] : null;
    const context = buildPriceVolumeContext({
      ts_code: code,
      name: names.get(code) ?? code,
      asOf,
      bars,
      endIdx: i,
      suspendedOnAsOf: suspended.has(code),
      barsBehindAsOf: behind,
      volumeRatio20: volRatio,
      atrPct,
      pctChg,
      rps120,
      market_regime: regime,
    });
    const input: PatternInput = {
      code, bars, x, endIdx: i, asOf, regime, regimeAt,
      rps120: null, barsBehindAsOf: behind,
    };
    const observations = detectAllPatterns(input);
    coverage.analyzed++;
    addRecentBreakoutFact(bars, i, context.notes);
    if (!observations.length) {
      // A forced (e.g. suspended) name still gets its shared context, so its
      // absence from every family is explained by a dated record rather than
      // silently omitted.
      if (forced.has(code)) contexts.set(code, context);
      return;
    }
    contexts.set(code, context);
    for (const obs of observations) {
      const readiness = researchReadiness(obs.stage, context.trading_status);
      const blockers = [...readiness.blockers];
      if (behind > 0 && !blockers.includes('NO_BAR_ON_AS_OF')) blockers.push('NO_BAR_ON_AS_OF');
      const dates = bars.dates;
      const formedIdx = obs.formed_on ? dates.indexOf(obs.formed_on) : -1;
      const confirmedIdx = obs.confirmed_on ? dates.indexOf(obs.confirmed_on) : -1;
      candidates.push({
        ...obs,
        ts_code: code,
        name: names.get(code) ?? code,
        trade_date: lastBar,
        as_of: asOf,
        confirmation_lag: formedIdx >= 0 && confirmedIdx >= 0 ? Math.max(0, confirmedIdx - formedIdx) : 0,
        market_regime: regime,
        price_volume_tags: context.price_volume_tags,
        trading_status: context.trading_status,
        research_ready: readiness.ready && blockers.length === 0,
        research_blockers: blockers,
        evidence_level: 'UNVERIFIED',
      });
    }
  }, codes);

  const families: TechnicalFamilyView[] = TECHNICAL_FAMILIES.map(family => {
    const list = candidates.filter(c => c.family === family).sort(compareCandidates);
    const counts = emptyStageCounts();
    for (const c of list) { counts[c.stage]++; counts.total++; if (c.research_ready) counts.research_ready++; }
    return {
      family,
      label: FAMILY_LABELS[family],
      definition: PATTERN_DEFINITIONS_V2[family] ?? '',
      candidates: list,
      counts,
    };
  });
  const contextList = [...contexts.values()].sort((a, b) => a.ts_code.localeCompare(b.ts_code));
  const sectorByCode = sectorMembership(db, asOf, contextList.map(c => c.ts_code));

  return {
    status: 'OK',
    reason: null,
    framework_version: TECHNICAL_FRAMEWORK_VERSION,
    implementation_fingerprint: technicalImplementationFingerprint(),
    as_of: asOf,
    market_regime: regime,
    methodology_note: METHODOLOGY_NOTE,
    contexts: contextList,
    families,
    research_universe: buildResearchUniverse({ as_of: asOf, contexts: contextList, families }, sectorByCode),
    coverage,
    evidence_level: 'UNVERIFIED',
    research_only: true,
  };
}

/** Explicit failure state: the snapshot still publishes, V2 says why it could not. */
export function unavailableTechnicalView(asOf: string, reason: string): TechnicalViewV2 {
  return {
    status: 'UNAVAILABLE',
    reason,
    framework_version: TECHNICAL_FRAMEWORK_VERSION,
    implementation_fingerprint: 'unavailable',
    as_of: asOf,
    market_regime: 'UNKNOWN',
    methodology_note: METHODOLOGY_NOTE,
    contexts: [],
    families: TECHNICAL_FAMILIES.map(family => ({
      family,
      label: FAMILY_LABELS[family],
      definition: '',
      candidates: [],
      counts: emptyStageCounts(),
    })),
    research_universe: {
      as_of: asOf,
      counts: { FOCUS: 0, WATCH: 0, EXTENDED: 0, DETERIORATING: 0, BLOCKED: 0, INVALIDATED: 0, total: 0 },
      stocks: [],
      daily_highlights: [],
    },
    coverage: {
      universe: 0, preselected: 0, analyzed: 0,
      skipped_adj_missing: 0, skipped_insufficient: 0, capacity_limited: 0,
    },
    evidence_level: 'UNVERIFIED',
    research_only: true,
  };
}

/** Suspended or one-price-limit names on `asOf` that the prescreen may not see. */
export function forcedResearchCodes(db: DatabaseSync, asOf: string): Array<{ ts_code: string; name?: string }> {
  const codes = new Set<string>(suspendedOn(db, asOf));
  // A one-price limit day is a trading-state fact that must be visible even
  // when the name fails the liquidity/pattern prescreen. It can never become
  // research_ready, but hiding it would also hide why.
  const onePrice = db.prepare(`
    SELECT d.ts_code FROM daily d
    JOIN stk_limit l ON l.ts_code = d.ts_code AND l.trade_date = d.trade_date
    WHERE d.trade_date = ?
      AND ABS(d.open - d.high) <= 0.005 AND ABS(d.high - d.low) <= 0.005 AND ABS(d.low - d.close) <= 0.005
      AND ((l.down_limit IS NOT NULL AND ABS(d.close - l.down_limit) <= 0.005)
        OR (l.up_limit IS NOT NULL AND ABS(d.close - l.up_limit) <= 0.005))`).all(asOf) as Array<{ ts_code: string }>;
  for (const r of onePrice) codes.add(r.ts_code);
  return [...codes].sort().map(ts_code => ({ ts_code }));
}

/**
 * Record a recent V1-style 60-day-high breakout as a dated FACT in the shared
 * context. V2's platform family may legitimately reject a rapid run-up, but
 * the historical breakout itself must not disappear from the record.
 */
function addRecentBreakoutFact(bars: Bars, i: number, notes: string[]): void {
  const found: string[] = [];
  for (let k = Math.max(61, i - 10); k <= i; k++) {
    const priorHigh = maxFrom(bars.high, k - 60, k - 1);
    if (!finite(priorHigh) || !finite(bars.close[k]) || bars.close[k] <= priorHigh) continue;
    if (finite(bars.close[k - 1]) && bars.close[k - 1] > priorHigh) continue; // not the first cross
    found.push(bars.dates[k]);
  }
  // Newest last; the window is at most 10 bars, so keep every first cross —
  // dropping the V1 confirmation date because a later re-break exists would
  // erase the historical fact this note is meant to preserve.
  for (const date of found) {
    notes.push(`${date} 收盘突破此前 60 日最高价（突破事实，非入场信号）`);
  }
}

/** One-day standalone analysis (read-only preview path). */
export function analyzeTechnicalDay(db: DatabaseSync, asOf: string, rps?: RpsResult | null): TechnicalViewV2 {
  const prescreen = createTechnicalPrescreen();
  scanMarket(db, asOf, { onStock: prescreen.observe });
  return analyzeTechnicalV2(db, {
    asOf,
    prescreen: prescreen.finish(),
    rps,
    forcedCodes: forcedResearchCodes(db, asOf),
  });
}

// ---------------------------------------------------------------- markdown

const stageLabel: Record<TechnicalStage, string> = {
  CONFIRMED: '确认', FOLLOW_THROUGH: '延续', FORMING: '形成中', FAILED: '失效', EXPIRED: '过期',
};

/** Compact Markdown rendering of one V2 view (preview only, no persistence). */
export function renderTechnicalViewMarkdown(view: TechnicalViewV2): string {
  const out: string[] = [];
  out.push(`# A股技术方法 V2 预览 ${view.as_of}`);
  out.push('');
  out.push(`- framework_version: \`${view.framework_version}\``);
  out.push(`- implementation_fingerprint: \`${view.implementation_fingerprint.slice(0, 16)}…\``);
  out.push(`- 市场环境: ${view.market_regime}`);
  out.push(`- 覆盖: 全市场 ${view.coverage.universe} 只，合格 ${view.coverage.preselected} 只，详析 ${view.coverage.analyzed} 只，预筛排名截断（仅诊断，不参与选股）${view.coverage.capacity_limited} 条`);
  out.push(`- 证据等级: ${view.evidence_level}（仅研究观察，不构成交易指令）`);
  out.push('');
  for (const f of view.families) {
    out.push(`## ${f.label} (${f.family})`);
    out.push('');
    out.push(`${f.definition}`);
    out.push('');
    if (!f.candidates.length) { out.push('无候选。'); out.push(''); continue; }
    out.push('| 阶段 | 代码 | 名称 | 数据日 | 策略 | 确认日 | research_ready | 阻塞原因 |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const c of f.candidates.slice(0, 15)) {
      out.push(`| ${stageLabel[c.stage]} | ${c.ts_code} | ${c.name} | ${c.trade_date} | ${c.strategy_id} | ${c.confirmed_on ?? '-'} | ${c.research_ready ? '是' : '否'} | ${c.research_blockers.join(',') || '-'} |`);
    }
    if (f.candidates.length > 15) out.push(`| … | 其余 ${f.candidates.length - 15} 条见 JSON | | | | | | |`);
    out.push('');
  }
  out.push('## 共享量价与交易状态（每股只陈述一次）');
  out.push('');
  if (!view.contexts.length) out.push('无。');
  else {
    out.push('| 代码 | 名称 | 数据日 | 落后交易日 | 交易状态 | 量价标签 | RPS120 | 说明 |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const c of view.contexts) {
      out.push(`| ${c.ts_code} | ${c.name} | ${c.trade_date} | ${c.bars_behind_as_of} | ${c.trading_status} | ${c.price_volume_tags.join(',') || '-'} | ${c.rps120 === null ? '-' : c.rps120.toFixed(0)} | ${c.notes.join('；') || '-'} |`);
    }
  }
  out.push('');
  out.push('> 同一股票可出现在多个策略族；共享量价信息只在上表陈述一次。不存在跨家族 100 分，也不把触轨当卖出信号。');
  return out.join('\n');
}
