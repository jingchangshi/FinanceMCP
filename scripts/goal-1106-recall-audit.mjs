#!/usr/bin/env node
// goal-1106 WP5 — offline recall audit for the V2 five-family discovery.
//
// This is an OFFLINE CORRECTNESS COMPARISON ONLY. It never writes any database,
// never creates a shadow track, and makes no profit claim. It answers one
// question: for one as-of day, does candidate discovery return every
// CURRENTLY VALID pattern (FORMING / CONFIRMED / FOLLOW_THROUGH) that the same
// five deterministic detectors return when run over every stock that passes
// the basic eligibility gates? FAILED / EXPIRED episodes are reported
// separately as historical records, not as live recall.
//
// Usage:
//   node scripts/goal-1106-recall-audit.mjs --db <read-only.sqlite> --date 20261105 --mode both
//   node scripts/goal-1106-recall-audit.mjs --db <...> --date 20261105 --mode both --out artifacts/goal-1106/recall-20261105.json
//
// `--mode legacy`  : the capped 120/500 prescreen as the analysed universe.
// `--mode current` : the production path in the current build.
// `--mode both`    : runs both, prints live recall per family for each.
//
// The legacy universe comes from `createTechnicalPrescreen().finish()`'s
// per-family lists, which are retained as diagnostics even after the fix, so
// the before numbers are exact without rebuilding the old revision.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { computeIndicators } from '../build/ashare/indicators.js';
import { forEachStockBars } from '../build/ashare/bars.js';
import { scanMarket } from '../build/ashare/analysis.js';
import { recentTradeDays } from '../build/ashare/ingest.js';
import { regimeSeries } from '../build/ashare/market.js';
import { detectAllPatterns } from '../build/ashare/technicalPatternsV2.js';
import {
  createTechnicalPrescreen, analyzeTechnicalV2, forcedResearchCodes,
  TECHNICAL_CAPACITY,
} from '../build/ashare/technicalCandidatesV2.js';
import { TECHNICAL_FAMILIES } from '../build/ashare/technicalFrameworkV2.js';

const args = new Map();
for (let k = 2; k < process.argv.length; k += 2) {
  const key = process.argv[k];
  if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
  args.set(key.slice(2), process.argv[k + 1]);
}
const dbPath = args.get('db');
const asOf = args.get('date');
const mode = args.get('mode') ?? 'both';
if (!dbPath || !asOf) throw new Error('usage: --db <sqlite> --date YYYYMMDD [--mode both|legacy|current] [--out file.json]');

const db = new DatabaseSync(dbPath, { readOnly: true });
const BAR_COUNT = 330;
const LIVE_STAGES = new Set(['FORMING', 'CONFIRMED', 'FOLLOW_THROUGH']);
const isSt = (name) => /ST|退/.test(name ?? '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- prescreen replica
// Re-stated only to explain WHY a live miss happened: "the proxy never matched
// this stock" (semantic gap) vs "ranked outside the 120/500 caps" (capacity).
// The legacy analysed universe itself is read from the production prescreen's
// retained per-family lists, not from this replica.
function minFrom(v, from, to) { let m = Infinity; for (let j = Math.max(0, from); j <= to; j++) if (finite(v[j]) && v[j] < m) m = v[j]; return m; }
function maxFrom(v, from, to) { let m = -Infinity; for (let j = Math.max(0, from); j <= to; j++) if (finite(v[j]) && v[j] > m) m = v[j]; return m; }
function argMinFrom(v, from, to) { let b = -1; for (let j = Math.max(0, from); j <= to; j++) if (finite(v[j]) && (b < 0 || v[j] < v[b])) b = j; return b; }
function widthPercentile(widths, i, current, period = 120) {
  if (i < 1) return null;
  const window = [];
  for (let j = Math.max(0, i - period); j < i; j++) if (finite(widths[j])) window.push(widths[j]);
  if (window.length < 100) return null;
  return window.filter((v) => v <= current).length / window.length;
}

/** Raw per-family prescreen membership, before any capacity cap. */
function prescreenFamilies(b, x, i, name, amount20Yi) {
  if (isSt(name)) return [];
  if ((b.adjMissing ?? 0) > 0) return [];
  if (b.dates.length < TECHNICAL_CAPACITY.minBars) return [];
  if (!finite(amount20Yi) || amount20Yi < TECHNICAL_CAPACITY.minAmount20Yi) return [];
  const c = b.close[i];
  const m20 = x.ma20[i], m60 = x.ma60[i], rsi = x.rsi14[i], bw = x.bollWidth[i];
  if (!finite(c)) return [];
  const out = [];
  if (finite(m20) && m20 > 0 && finite(m60) && m20 > m60) {
    out.push(['TREND_CONTINUATION', Math.abs(c / m20 - 1)]);
  } else if (finite(m20) && finite(x.ma20[i - 5]) && m20 > x.ma20[i - 5] && c >= m20 * 0.98) {
    out.push(['TREND_CONTINUATION', Math.abs(c / m20 - 1) + 0.5]);
  }
  const high60 = maxFrom(b.high, i - 60, i - 1);
  if (finite(high60) && high60 > 0 && c >= high60 * 0.88 && ((finite(bw) && bw <= 0.30) || c > high60)) {
    const runup = finite(b.close[i - 20]) && b.close[i - 20] > 0 ? c / b.close[i - 20] - 1 : 1;
    out.push(['PLATFORM_BREAKOUT', Math.max(0, high60 / c - 1) + (runup > 0.25 ? 1 : 0)]);
  }
  const low60Idx = argMinFrom(b.low, i - 60, i);
  const low120 = minFrom(b.low, i - 120, i);
  const recentLow = low60Idx >= i - 40;
  if ((finite(rsi) && rsi < 45) || recentLow || (finite(low120) && low120 > 0 && c <= low120 * 1.10)) {
    out.push(['REVERSAL', finite(rsi) ? rsi : 100]);
  }
  const bwPct = finite(bw) ? widthPercentile(x.bollWidth, i, bw) : null;
  if ((bwPct !== null && bwPct <= 0.35) || (finite(x.bollUp[i]) && c >= x.bollUp[i])) {
    out.push(['VOLATILITY_EXPANSION', bwPct ?? 1]);
  }
  let rsiLow12 = null;
  for (let j = Math.max(0, i - 12); j <= i; j++) if (finite(x.rsi14[j]) && (rsiLow12 === null || x.rsi14[j] < rsiLow12)) rsiLow12 = x.rsi14[j];
  let touchedLowerBand = false;
  for (let j = Math.max(0, i - 12); j <= i; j++) if (finite(b.close[j]) && finite(x.bollLow[j]) && b.close[j] <= x.bollLow[j] * 1.03) { touchedLowerBand = true; break; }
  if ((rsiLow12 !== null && rsiLow12 < 32) || touchedLowerBand || (finite(rsi) && rsi < 40)) {
    out.push(['MEAN_REVERSION', finite(rsi) ? rsi : 100]);
  }
  return out;
}

// ---------------------------------------------------------------- shared pass

const basic = new Map((db.prepare('SELECT ts_code, name FROM stock_basic').all()).map((r) => [r.ts_code, r.name]));
const days = recentTradeDays(db, asOf, BAR_COUNT);
const dayIndex = new Map(days.map((d, k) => [d, k]));
const start = days[0];
const regime = regimeSeries(db, asOf).get(asOf) ?? 'UNKNOWN';

function barsBehind(lastBar) {
  const a = dayIndex.get(asOf), b = dayIndex.get(lastBar);
  return a === undefined || b === undefined ? 0 : Math.max(0, a - b);
}

/** One sweep: eligibility, ground-truth observations and prescreen membership. */
function sweep() {
  const truths = new Map();          // code -> observations[]
  const eligible = [];               // codes passing the four basic gates
  const stale = [];                  // eligible but no as-of bar
  const rawPrescreen = new Map();    // code -> [[family, metric]]
  const gateCounts = { adj_missing: 0, insufficient_bars: 0, st: 0, low_amount: 0, no_as_of_bar: 0 };
  forEachStockBars(db, start, asOf, (code, b) => {
    const i = b.dates.length - 1;
    const name = basic.get(code) ?? code;
    if (isSt(name)) { gateCounts.st++; return; }
    if ((b.adjMissing ?? 0) > 0) { gateCounts.adj_missing++; return; }
    if (b.dates.length < TECHNICAL_CAPACITY.minBars) { gateCounts.insufficient_bars++; return; }
    const x = computeIndicators(b);
    const amount20Yi = x.amountMa20[i] / 1e5;
    if (!finite(amount20Yi) || amount20Yi < TECHNICAL_CAPACITY.minAmount20Yi) { gateCounts.low_amount++; return; }
    const hasAsOfBar = b.dates[i] === asOf;
    if (hasAsOfBar) eligible.push(code); else { stale.push(code); gateCounts.no_as_of_bar++; }
    rawPrescreen.set(code, prescreenFamilies(b, x, i, name, amount20Yi));
    truths.set(code, detectAllPatterns({
      code, bars: b, x, endIdx: i, asOf, regime,
      rps120: null, barsBehindAsOf: barsBehind(b.dates[i]),
    }).map((o) => ({ code, family: o.family, strategy_id: o.strategy_id, stage: o.stage, stage_detail: o.stage_detail, confirmed_on: o.confirmed_on ?? null })));
  });
  return { truths, eligible, stale, rawPrescreen, gateCounts };
}

function collectFromView(view) {
  const out = [];
  for (const f of view.families) {
    for (const c of f.candidates) {
      out.push({ code: c.ts_code, family: f.family, strategy_id: c.strategy_id, stage: c.stage, stage_detail: c.stage_detail, confirmed_on: c.confirmed_on ?? null });
    }
  }
  return out;
}

const keyOf = (o) => `${o.code}|${o.strategy_id}`;
const emptySide = () => ({ full: 0, recalled: 0, missed: 0, missed_by_stage: {}, missed_stocks: [], missed_stock_count: 0 });
const emptyFamily = () => ({ live: emptySide(), dead: emptySide() });
const emptyFamilies = () => Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, emptyFamily()]));

function summarize(fullObs, producedObs, analyzedCodes, rawPrescreen, perFamilyLists) {
  const got = new Map(producedObs.map((o) => [keyOf(o), o]));
  const families = emptyFamilies();
  const missedLive = [];
  const missedDead = [];
  for (const o of fullObs) {
    const side = LIVE_STAGES.has(o.stage) ? families[o.family].live : families[o.family].dead;
    side.full++;
    const g = got.get(keyOf(o));
    if (g && g.stage === o.stage) { side.recalled++; continue; }
    side.missed++;
    side.missed_by_stage[o.stage] = (side.missed_by_stage[o.stage] ?? 0) + 1;
    side.missed_stocks.push(o.code);
    (LIVE_STAGES.has(o.stage) ? missedLive : missedDead).push({ ...o, produced_stage: g?.stage ?? null });
  }
  for (const f of TECHNICAL_FAMILIES) {
    for (const side of [families[f].live, families[f].dead]) {
      side.missed_stocks = [...new Set(side.missed_stocks)].sort();
      side.missed_stock_count = side.missed_stocks.length;
      side.missed_stocks = side.missed_stocks.slice(0, 200);
    }
  }

  // Reason attribution is based on the LIVE misses only.
  const analyzed = new Set(analyzedCodes);
  const reasons = {};
  const missedLiveCodes = [...new Set(missedLive.map((o) => o.code))].sort();
  for (const code of missedLiveCodes) {
    const listed = rawPrescreen.get(code) ?? [];
    const capListed = listed.some(([family]) => (perFamilyLists[family] ?? []).includes(code));
    const reason = analyzed.has(code) ? 'analyzed_but_family_differs'
      : listed.length === 0 ? 'prescreen_semantic_gap'
      : capListed ? 'dropped_by_union_cap'
      : 'dropped_by_per_family_cap';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  const totals = { live: emptySide(), dead: emptySide() };
  for (const f of TECHNICAL_FAMILIES) {
    for (const side of ['live', 'dead']) {
      totals[side].full += families[f][side].full;
      totals[side].recalled += families[f][side].recalled;
      totals[side].missed += families[f][side].missed;
      for (const [st, n] of Object.entries(families[f][side].missed_by_stage)) {
        totals[side].missed_by_stage[st] = (totals[side].missed_by_stage[st] ?? 0) + n;
      }
    }
  }
  totals.live.missed_stock_count = missedLiveCodes.length;
  totals.dead.missed_stock_count = new Set(missedDead.map((o) => o.code)).size;
  return {
    families,
    totals,
    live_missed_total: missedLive.length,
    live_missed_samples: missedLive.slice(0, 50),
    live_missed_codes_total: missedLiveCodes.length,
    live_missed_codes: missedLiveCodes.slice(0, 500),
    live_missed_reason_counts: reasons,
  };
}

const t0 = performance.now();
const sweepOut = sweep();
const sweepSeconds = (performance.now() - t0) / 1000;

const report = {
  audit: 'goal-1106-wp5-recall',
  mode,
  db: dbPath,
  as_of: asOf,
  regime,
  live_stages: [...LIVE_STAGES],
  capacity: TECHNICAL_CAPACITY,
  gate_counts: sweepOut.gateCounts,
  eligible: sweepOut.eligible.length,
  stale_eligible: sweepOut.stale.length,
  ground_truth: {
    analyzed: sweepOut.eligible.length,
    observations: [...sweepOut.truths.values()].reduce((n, a) => n + a.length, 0),
  },
  sweep_seconds: Number(sweepSeconds.toFixed(3)),
};

if (!['legacy', 'current', 'both'].includes(mode)) throw new Error(`unknown mode ${mode}`);

const tp = performance.now();
const ps = createTechnicalPrescreen();
scanMarket(db, asOf, { onStock: (code, b, x, i, row) => ps.observe(code, b, x, i, row) });
const finished = ps.finish();
const forced = forcedResearchCodes(db, asOf);
const view = analyzeTechnicalV2(db, { asOf, prescreen: finished, forcedCodes: forced });
const seconds = (performance.now() - tp) / 1000;

const perFamilyLists = Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, finished.perFamily[f].map((e) => e.ts_code)]));
const legacyUnion = [...new Set(TECHNICAL_FAMILIES.flatMap((f) => perFamilyLists[f]))].sort();
// The legacy production path analysed the union plus forced (suspended /
// one-price-limit) names; the simulation must include the same set.
const legacyCodes = [...new Set([...legacyUnion, ...forced.map((f) => f.ts_code)])];
const legacySet = new Set(legacyCodes);
const ground = [...sweepOut.eligible.flatMap((c) => sweepOut.truths.get(c) ?? [])];
const currentObs = collectFromView(view);
const currentCodes = [...new Set([...finished.eligible.map((e) => e.ts_code), ...forced.map((f) => f.ts_code)])];

const legacyObs = ground.filter((o) => legacySet.has(o.code));
const legacyCmp = summarize(ground, legacyObs, legacyCodes, sweepOut.rawPrescreen, perFamilyLists);
const currentCmp = summarize(ground, currentObs, currentCodes, sweepOut.rawPrescreen, perFamilyLists);

report.prescreen = {
  seconds: Number(seconds.toFixed(3)),
  coverage: view.coverage,
  view_json_mb: Number((Buffer.byteLength(JSON.stringify(view)) / 1048576).toFixed(2)),
  legacy_ranked_codes: legacyUnion.length,
  legacy_codes: legacyCodes.length,
  current_codes: currentCodes.length,
  legacy_capacity_diagnostic: finished.capacity_limited,
  per_family_preselected: Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, perFamilyLists[f].length])),
  observation_counts: {
    legacy: Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, legacyObs.filter((o) => o.family === f).length])),
    current: Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, currentObs.filter((o) => o.family === f).length])),
  },
  legacy: legacyCmp,
  current: currentCmp,
};
if (args.has('include-entries')) {
  report.prescreen.current_entries = currentObs;
  report.prescreen.legacy_entries = legacyObs;
}

report.max_rss_mb = Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
db.close();

if (args.get('out')) {
  mkdirSync(dirname(args.get('out')), { recursive: true });
  writeFileSync(args.get('out'), JSON.stringify(report, null, 2));
}

// Human-readable summary: LIVE recall first; dead history in a separate block.
const lines = [];
lines.push(`# ${asOf} regime=${regime} mode=${mode}`);
lines.push(`eligible(with as-of bar)=${report.eligible} stale=${report.stale_eligible} ground_truth_obs=${report.ground_truth.observations} sweep=${report.sweep_seconds}s maxRSS=${report.max_rss_mb}MB`);
lines.push(`legend: live=FORMING/CONFIRMED/FOLLOW_THROUGH; dead=FAILED/EXPIRED`);
lines.push(`analysed: legacy(120/500)=${legacyUnion.length}+${forced.length} forced=${legacyCodes.length} current(eligible)=${currentCodes.length} capacity_diagnostic=${finished.capacity_limited} payload=${report.prescreen.view_json_mb}MB time=${report.prescreen.seconds}s`);
for (const which of ['legacy', 'current']) {
  const cmp = report.prescreen[which];
  lines.push(`## ${which} — LIVE RECALL`);
  lines.push('| family | live full | live recalled | live missed | missed stages |');
  lines.push('|---|---:|---:|---:|---|');
  for (const f of TECHNICAL_FAMILIES) {
    const x = cmp.families[f].live;
    lines.push(`| ${f} | ${x.full} | ${x.recalled} | ${x.missed} | ${JSON.stringify(x.missed_by_stage)} |`);
  }
  lines.push(`| ALL | ${cmp.totals.live.full} | ${cmp.totals.live.recalled} | ${cmp.totals.live.missed} | ${JSON.stringify(cmp.totals.live.missed_by_stage)} |`);
  if (which === 'legacy') {
    lines.push(`live missed stock reasons: ${JSON.stringify(cmp.live_missed_reason_counts)}`);
    lines.push(`legacy DEAD HISTORY: full=${cmp.totals.dead.full} recalled=${cmp.totals.dead.recalled} missed=${cmp.totals.dead.missed} ${JSON.stringify(cmp.totals.dead.missed_by_stage)}`);
  }
}
console.log(lines.join('\n'));
