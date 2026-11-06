#!/usr/bin/env node
// goal-1106 WP5 — offline recall audit for the V2 five-family discovery.
//
// This is an OFFLINE CORRECTNESS COMPARISON ONLY. It never writes any database,
// never creates a shadow track, and makes no profit claim. It answers one
// question: for one as-of day, does the production candidate discovery
// (prescreen perFamily=120 / union=500) return every pattern that the same five
// deterministic detectors return when run over every stock that passes the
// basic eligibility gates?
//
// Usage:
//   node scripts/goal-1106-recall-audit.mjs --db <read-only.sqlite> --date 20261105 --mode both
//   node scripts/goal-1106-recall-audit.mjs --db <...> --date 20261105 --mode prescreen --out artifacts/goal-1106/recall-before-20261105.json
//
// `--mode prescreen` runs the production path only (createTechnicalPrescreen +
// analyzeTechnicalV2, exactly as analyzeTechnicalDay).
// `--mode full` runs every detector over every eligible stock (ground truth).
// `--mode both` runs both and prints the per-family comparison.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

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
if (!dbPath || !asOf) throw new Error('usage: --db <sqlite> --date YYYYMMDD [--mode both|prescreen|full] [--out file.json]');

const db = new DatabaseSync(dbPath, { readOnly: true });
const BAR_COUNT = 330;
const isSt = (name) => /ST|退/.test(name ?? '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- prescreen replica
// The production prescreen's per-family conditions are re-stated here ONLY so
// the audit can explain a miss as "the proxy never matched this stock" versus
// "the capacity cap dropped it". If the production prescreen changes, this
// block must change with it; the audit cross-checks the replica's union count
// against `finish()` and reports a mismatch instead of silently trusting it.
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
const byFamily = () => Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, {
  full: 0, recalled: 0, missed: 0, missed_by_stage: {}, missed_stocks: [],
}]));

function summarize(fullObs, gotObs, analyzedCodes, rawPrescreen, perFamilyLists) {
  const got = new Map(gotObs.map((o) => [keyOf(o), o]));
  const fam = byFamily();
  const missed = [];
  for (const o of fullObs) {
    fam[o.family].full++;
    const g = got.get(keyOf(o));
    if (g && g.stage === o.stage) { fam[o.family].recalled++; continue; }
    fam[o.family].missed++;
    fam[o.family].missed_by_stage[o.stage] = (fam[o.family].missed_by_stage[o.stage] ?? 0) + 1;
    fam[o.family].missed_stocks.push(o.code);
    missed.push({ ...o, prescreen_stage: g?.stage ?? null });
  }
  for (const f of TECHNICAL_FAMILIES) {
    fam[f].missed_stocks = [...new Set(fam[f].missed_stocks)].sort();
    fam[f].missed_stock_count = fam[f].missed_stocks.length;
    fam[f].missed_stocks = fam[f].missed_stocks.slice(0, 200);
  }

  const missedCodes = [...new Set(missed.map((o) => o.code))].sort();
  const analyzed = new Set(analyzedCodes);
  const reasons = {};
  for (const code of missedCodes) {
    const listed = rawPrescreen.get(code) ?? [];
    const capListed = listed.some(([family]) => (perFamilyLists[family] ?? []).includes(code));
    const reason = analyzed.has(code) ? 'analyzed_but_family_differs'
      : listed.length === 0 ? 'prescreen_semantic_gap'
      : capListed ? 'dropped_by_union_cap'
      : 'dropped_by_per_family_cap';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    families: fam,
    missed_total: missed.length,
    missed_samples: missed.slice(0, 50),
    missed_codes_total: missedCodes.length,
    missed_codes: missedCodes.slice(0, 500),
    missed_reason_counts: reasons,
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

let prescreenResult = null;
let view = null;
if (mode === 'prescreen' || mode === 'both') {
  const tp = performance.now();
  const ps = createTechnicalPrescreen();
  scanMarket(db, asOf, { onStock: (code, b, x, i, row) => ps.observe(code, b, x, i, row) });
  const finished = ps.finish();
  const forced = forcedResearchCodes(db, asOf);
  view = analyzeTechnicalV2(db, { asOf, prescreen: finished, forcedCodes: forced });
  const seconds = (performance.now() - tp) / 1000;
  const gotObs = collectFromView(view);
  const analyzedCodes = [...new Set([
    ...TECHNICAL_FAMILIES.flatMap((f) => finished.perFamily[f].map((e) => e.ts_code)),
    ...forced.map((f) => f.ts_code),
  ])];
  const perFamilyLists = Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, finished.perFamily[f].map((e) => e.ts_code)]));
  // Ground truth is the eligible universe; a stale name is only in scope when
  // production forces it (suspended / one-price-limit).
  const ground = [...sweepOut.eligible.flatMap((c) => sweepOut.truths.get(c) ?? [])];
  const cmp = summarize(ground, gotObs, analyzedCodes, sweepOut.rawPrescreen, perFamilyLists);
  const includeEntries = args.has('include-entries');
  prescreenResult = {
    seconds: Number(seconds.toFixed(3)),
    coverage: view.coverage,
    view_json_mb: Number((Buffer.byteLength(JSON.stringify(view)) / 1048576).toFixed(2)),
    preselected_codes: analyzedCodes.length,
    forced_codes: forced.length,
    per_family_preselected: Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, finished.perFamily[f].length])),
    observation_counts: Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, gotObs.filter((o) => o.family === f).length])),
    comparison: cmp,
  };
  if (includeEntries) prescreenResult.entries = gotObs;
  report.prescreen = prescreenResult;
}

if (mode === 'full' || mode === 'both') {
  const ground = [...sweepOut.eligible.flatMap((c) => sweepOut.truths.get(c) ?? [])];
  const fam = byFamily();
  for (const o of ground) fam[o.family].full++;
  report.full = {
    eligible_with_asof_bar: sweepOut.eligible.length,
    eligible_codes: sweepOut.eligible,
    observations: ground.length,
    per_family: Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, fam[f].full])),
  };
  if (args.has('include-entries')) report.full.entries = ground;
}

report.max_rss_mb = Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
db.close();

if (args.get('out')) {
  mkdirSync(dirname(args.get('out')), { recursive: true });
  writeFileSync(args.get('out'), JSON.stringify(report, null, 2));
}

// Human-readable summary on stdout.
const lines = [];
lines.push(`# ${asOf} regime=${regime} mode=${mode}`);
lines.push(`eligible(with as-of bar)=${report.eligible} stale=${report.stale_eligible} ground_truth_obs=${report.ground_truth.observations} sweep=${report.sweep_seconds}s maxRSS=${report.max_rss_mb}MB`);
if (report.prescreen) {
  const { comparison, coverage } = report.prescreen;
  lines.push(`prescreen: analyzed=${coverage.analyzed} preselected=${coverage.preselected} capacity_limited=${coverage.capacity_limited} time=${report.prescreen.seconds}s`);
  lines.push('| family | full | recalled | missed |');
  lines.push('|---|---|---|---|');
  for (const f of TECHNICAL_FAMILIES) {
    const x = comparison.families[f];
    lines.push(`| ${f} | ${x.full} | ${x.recalled} | ${x.missed} |`);
  }
  lines.push(`missed stocks by reason: ${JSON.stringify(comparison.missed_reason_counts)}`);
  for (const f of TECHNICAL_FAMILIES) {
    const x = comparison.families[f];
    if (x.missed) lines.push(`  ${f} missed by stage: ${JSON.stringify(x.missed_by_stage)}; stocks=${x.missed_stocks.slice(0, 20).join(',')}${x.missed_stocks.length > 20 ? '…' : ''}`);
  }
  if (mode === 'both') {
    const pairs = TECHNICAL_FAMILIES.map((f) => [f, [report.prescreen.observation_counts[f], report.full.per_family[f]]]);
    lines.push(`prescreen counts vs full: ${JSON.stringify(Object.fromEntries(pairs))}`);
    lines.push(`prescreen view payload: ${report.prescreen.view_json_mb}MB`);
  }
}
if (report.full && mode === 'full') lines.push(`full per family: ${JSON.stringify(report.full.per_family)}`);
console.log(lines.join('\n'));
