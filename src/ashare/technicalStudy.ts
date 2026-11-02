/**
 * Independent, descriptive observation of the V2 candidate cohorts (goal-1102
 * WP5). This module makes NO model, forecasts nothing and searches no
 * parameters. It reuses the existing evaluator (`evaluation.ts`) exactly as
 * the V1 research path does: t+1 open entry, up-limit unbuyable, suspension /
 * down-limit exit deferral, fees + slippage, and fixed horizons.
 *
 * Three controls are kept beside the V2 cohort:
 *   - `V1_FOCUS`            — that day's legacy FOCUS pool (old methodology)
 *   - `RPS_TOP20`           — RPS120 alone, no technical filtering
 *   - `UNFILTERED_CONFIRMED`— V2 confirmations with the trading-state gate OFF
 *
 * Sample sizes are reported per family / stage / market regime, together with
 * the evaluator's own entry-block reasons. Small samples stay `UNVERIFIED`;
 * no significance or win-rate claim is made.
 */
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as Database } from 'node:sqlite';
import { ashareDbPath } from './db.js';
import { scanMarket } from './analysis.js';
import { computeRps } from './rps.js';
import { recentTradeDays } from './ingest.js';
import { evaluateEvents, summarizeEvaluation, type EvaluationEvent } from './evaluation.js';
import { HOTSPOT_EXPERIMENT_COSTS } from './hotspotTypes.js';
import { loadHotspotSnapshot } from './hotspotSnapshots.js';
import { analyzeTechnicalDay } from './technicalCandidatesV2.js';
import {
  TECHNICAL_FRAMEWORK_VERSION, type TechnicalFamily, type TechnicalStage,
} from './technicalFrameworkV2.js';

export const TECHNICAL_STUDY_VERSION = 'technical-study-1.0.0';
export const STUDY_HORIZONS = [3, 5, 10, 20] as const;

export interface TechnicalStudyOptions {
  /** V2-visible as-of dates. Only these dates' candidate sets are observed. */
  dates: string[];
  /** Data cutoff for forward evaluation; never extends a candidate's own as-of. */
  asOf?: string;
  horizons?: number[];
  /** Optional cap per date, applied deterministically after sorting. */
  maxCandidatesPerDate?: number;
}

export interface Sample {
  cohort: string;
  family: TechnicalFamily | null;
  stage: TechnicalStage | null;
  market_regime: string | null;
  horizon: number;
  events: number;
  summary: ReturnType<typeof summarizeEvaluation>;
}

export interface TechnicalStudyResult {
  command: 'technical-study';
  version: string;
  framework_version: string;
  evidence_level: 'UNVERIFIED';
  research_only: true;
  as_of: string;
  dates: string[];
  horizons: number[];
  costs: typeof HOTSPOT_EXPERIMENT_COSTS;
  samples: Sample[];
  controls: Sample[];
  per_date: Array<{
    date: string;
    market_regime: string;
    ready_by_family: Record<string, number>;
    blocked: Record<string, number>;
    total_candidates: number;
  }>;
  notes: string[];
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function latestTradeDay(db: DatabaseSync): string {
  const row = db.prepare('SELECT MAX(cal_date) AS d FROM trade_cal WHERE is_open = 1').get() as { d: string | null } | undefined;
  if (!row?.d) throw new Error('trade_cal 无交易日，无法确定观察截止日');
  return row.d;
}

function sample(db: DatabaseSync, cohort: string, events: EvaluationEvent[], asOf: string, horizon: number,
  family: TechnicalFamily | null = null, stage: TechnicalStage | null = null, marketRegime: string | null = null): Sample | null {
  if (!events.length) return null;
  const report = evaluateEvents(db, events, { asOf, horizon, ...HOTSPOT_EXPERIMENT_COSTS });
  return { cohort, family, stage, market_regime: marketRegime, horizon, events: events.length, summary: report.summary };
}

/**
 * Run the descriptive study. The caller owns the (read-only) connection; this
 * function performs no writes and no persistence.
 */
export function runTechnicalStudy(db: DatabaseSync, opts: TechnicalStudyOptions): TechnicalStudyResult {
  if (!opts.dates.length) throw new Error('technical-study 至少需要一个日期');
  const asOf = opts.asOf ?? latestTradeDay(db);
  const horizons = opts.horizons ?? [...STUDY_HORIZONS];
  for (const h of horizons) if (!Number.isInteger(h) || h < 2) throw new Error(`horizon 必须是 >=2 的整数: ${h}`);
  const dates = uniq(opts.dates).sort();
  const cap = opts.maxCandidatesPerDate ?? 200;

  // Every requested date must be a real V2-visible trading day with an as-of bar set.
  const known = new Set(recentTradeDays(db, asOf, 3000));
  for (const d of dates) if (!known.has(d)) throw new Error(`${d} 不是 ${asOf} 之前的交易日，拒绝观察`);

  const samples: Sample[] = [];
  const controls: Sample[] = [];
  const perDate: TechnicalStudyResult['per_date'] = [];

  for (const date of dates) {
    const view = analyzeTechnicalDay(db, date);
    const all = view.families.flatMap(f => f.candidates);
    const live = all.filter(c => c.stage === 'CONFIRMED' || c.stage === 'FOLLOW_THROUGH')
      .filter(c => c.research_ready);
    // The cap is per family: a global slice would let the first family consume
    // the whole budget and silently drop the other four from the study.
    const ready = view.families.flatMap(f => live.filter(c => c.family === f.family).slice(0, cap));
    const readyByFamily: Record<string, number> = {};
    for (const c of ready) readyByFamily[c.family] = (readyByFamily[c.family] ?? 0) + 1;
    const blocked: Record<string, number> = {};
    for (const c of all) {
      if (c.research_ready) continue;
      for (const b of c.research_blockers) blocked[b] = (blocked[b] ?? 0) + 1;
    }
    perDate.push({
      date, market_regime: view.market_regime, ready_by_family: readyByFamily,
      blocked, total_candidates: all.length,
    });

    // Primary: research-ready V2 confirmations, per family and per stage.
    for (const horizon of horizons) {
      for (const family of view.families) {
        const rows = ready.filter(c => c.family === family.family);
        const s = sample(db, 'V2_RESEARCH_READY', rows.map(c => ({
          date, ts_code: c.ts_code, signals: [c.family, c.stage],
        })), asOf, horizon, family.family, null, view.market_regime);
        if (s) samples.push(s);
        for (const stage of ['CONFIRMED', 'FOLLOW_THROUGH'] as const) {
          const st = rows.filter(c => c.stage === stage);
          const ss = sample(db, 'V2_RESEARCH_READY', st.map(c => ({
            date, ts_code: c.ts_code, signals: [c.family, c.stage],
          })), asOf, horizon, family.family, stage, view.market_regime);
          if (ss) samples.push(ss);
        }
      }
    }

    // Control 1: unfiltered V2 confirmations (trading-state gate deliberately off).
    for (const horizon of horizons) {
      const unfiltered = uniq(all
        .filter(c => c.stage === 'CONFIRMED' || c.stage === 'FOLLOW_THROUGH')
        .map(c => c.ts_code)).sort();
      const s = sample(db, 'UNFILTERED_CONFIRMED', unfiltered.slice(0, cap).map(ts_code => ({ date, ts_code })),
        asOf, horizon);
      if (s) controls.push(s);
    }

    // Control 2: legacy V1 FOCUS pool from the stored snapshot (no rewrite).
    const snap = loadHotspotSnapshot(db, date);
    if (snap) {
      const focus = uniq(snap.candidates.filter(c => c.pool === 'FOCUS' && c.instrument_type === 'STOCK')
        .map(c => c.ts_code)).sort().slice(0, cap);
      for (const horizon of horizons) {
        const s = sample(db, 'V1_FOCUS', focus.map(ts_code => ({ date, ts_code })), asOf, horizon);
        if (s) controls.push(s);
      }
    }

    // Control 3: RPS120 alone (top 20), no technical or entry filtering.
    const scan = scanMarket(db, date);
    const days = recentTradeDays(db, date, 260);
    const rps = days.length > 1 ? computeRps(db, days[0], date) : null;
    if (rps) {
      const top = scan.rows
        .filter(r => (rps.rows.get(r.ts_code)?.rps[120] ?? null) !== null)
        .sort((a, b) => (rps.rows.get(b.ts_code)!.rps[120]! - rps.rows.get(a.ts_code)!.rps[120]!)
          || a.ts_code.localeCompare(b.ts_code))
        .slice(0, 20)
        .map(r => r.ts_code);
      for (const horizon of horizons) {
        const s = sample(db, 'RPS_TOP20', top.map(ts_code => ({ date, ts_code })), asOf, horizon);
        if (s) controls.push(s);
      }
    }
  }

  return {
    command: 'technical-study',
    version: TECHNICAL_STUDY_VERSION,
    framework_version: TECHNICAL_FRAMEWORK_VERSION,
    evidence_level: 'UNVERIFIED',
    research_only: true,
    as_of: asOf,
    dates,
    horizons,
    costs: HOTSPOT_EXPERIMENT_COSTS,
    samples,
    controls,
    per_date: perDate,
    notes: [
      '描述性观察：仅统计已完成的 T+h 收盘退出；未到期样本保持 pending，不视为收益。',
      '样本可能重叠、重复股票与同族多候选，不构成独立样本，也不做显著性结论。',
      'V1_FOCUS / RPS_TOP20 / UNFILTERED_CONFIRMED 是对照，不是推荐组合。',
      '停牌、一字跌停与买入约束由 evaluation.ts 统一处理；其计数在各样本的 denominators 中。',
    ],
  };
}

/** Parse the argv tail for the `technical-study` CLI. */
export function runTechnicalStudyCommand(argv: string[]): TechnicalStudyResult {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dateList = (arg('dates') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const start = arg('start'), end = arg('end');
  if (!dateList.length && !(start && end)) {
    throw new Error('technical-study 需要 --dates YYYYMMDD[,YYYYMMDD...] 或 --start/--end');
  }
  if (dateList.some(d => !/^\d{8}$/.test(d))) throw new Error('--dates 需要逗号分隔的 YYYYMMDD');
  const db = new Database(arg('db')?.trim() || ashareDbPath(), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 15000; PRAGMA temp_store = MEMORY;');
    const dates = dateList.length ? dateList
      : recentTradeDays(db, end!, 3000).filter(d => d >= start!);
    const horizons = (arg('horizons') ?? '3,5,10,20').split(',').map(Number);
    return runTechnicalStudy(db, {
      dates, asOf: arg('as-of'), horizons,
      maxCandidatesPerDate: arg('max') ? Number(arg('max')) : undefined,
    });
  } finally {
    db.close();
  }
}
