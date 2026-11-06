// Technical methodology V2 — full-market recall (goal-1106 WP5).
//
// The legacy discovery ranked every stock in each family's cheap prescreen and
// analysed only the top 120 per family / 500 overall. That is a *proxy*: a
// stock can satisfy a family's real definition without satisfying the proxy,
// and the capacity cap can drop a genuine active pattern. This test measures
// the difference against the five deterministic detectors run over every
// eligible stock, and pins the production view to that ground truth.
//
// It is a behavioural invariant, not a fixture ranking: every observation the
// detectors produce for an eligible stock must appear in the published view,
// with the same stage, and no family may be silently dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'technical-v2-recall-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');

const { openAshareDb } = await import('../build/ashare/db.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');
const {
  TECHNICAL_CAPACITY, createTechnicalPrescreen, analyzeTechnicalV2, analyzeTechnicalDay,
} = await import('../build/ashare/technicalCandidatesV2.js');
const { TECHNICAL_FAMILIES } = await import('../build/ashare/technicalFrameworkV2.js');
const { scanMarket } = await import('../build/ashare/analysis.js');
const { forEachStockBars } = await import('../build/ashare/bars.js');
const { computeIndicators } = await import('../build/ashare/indicators.js');
const { recentTradeDays } = await import('../build/ashare/ingest.js');
const { regimeSeries } = await import('../build/ashare/market.js');
const { detectAllPatterns } = await import('../build/ashare/technicalPatternsV2.js');

const DATES = weekdays('20250101', 160);
const AS_OF = DATES.at(-1);
const DB = openAshareDb();
// 1100 synthetic names: comfortably past both legacy caps (120 / 500), and
// every stock clears the basic eligibility gates (bars, adj factor, turnover).
seedReferenceUniverse(DB, DATES);

const prescreen = createTechnicalPrescreen();
scanMarket(DB, AS_OF, { onStock: (code, bars, x, i, row) => prescreen.observe(code, bars, x, i, row) });
const prescreened = prescreen.finish();

const view = analyzeTechnicalV2(DB, { asOf: AS_OF, prescreen: prescreened });
const dayView = analyzeTechnicalDay(DB, AS_OF);

const days = recentTradeDays(DB, AS_OF, 330);
const regime = regimeSeries(DB, AS_OF).get(AS_OF) ?? 'UNKNOWN';
const eligibleCodes = prescreened.eligible.map((e) => e.ts_code);

/** Ground truth: the five detectors over every eligible stock, same bars/window. */
function fullDetection() {
  const observations = [];
  forEachStockBars(DB, days[0], AS_OF, (code, bars) => {
    if ((bars.adjMissing ?? 0) > 0) return;
    if (bars.dates.length < TECHNICAL_CAPACITY.minBars) return;
    const i = bars.dates.length - 1;
    const x = computeIndicators(bars);
    if (!(x.amountMa20[i] / 1e5 >= TECHNICAL_CAPACITY.minAmount20Yi)) return;
    for (const obs of detectAllPatterns({
      code, bars, x, endIdx: i, asOf: AS_OF, regime, rps120: null,
      barsBehindAsOf: AS_OF === bars.dates[i] ? 0 : 1,
    })) {
      observations.push({ code, family: obs.family, strategy_id: obs.strategy_id, stage: obs.stage });
    }
  }, eligibleCodes);
  return observations;
}

const truth = fullDetection();
const truthKey = (o) => `${o.code}|${o.strategy_id}|${o.stage}`;
const viewKeys = new Set(view.families.flatMap((f) => f.candidates.map((c) => `${c.ts_code}|${c.strategy_id}|${c.stage}`)));
const truthByFamily = Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, truth.filter((o) => o.family === f)]));
const viewByFamily = Object.fromEntries(view.families.map((f) => [f.family, f.candidates]));

test('every eligible stock is analysed; the legacy capacity cap no longer gates detection', () => {
  assert.equal(view.status, 'OK');
  assert.ok(prescreened.eligible.length > TECHNICAL_CAPACITY.union,
    `fixture must exceed the legacy union cap (eligible=${prescreened.eligible.length})`);
  assert.ok(prescreened.capacity_limited > 0,
    'the legacy ranking still reports truncation, so the caps remain observable');
  assert.equal(view.coverage.preselected, prescreened.eligible.length);
  assert.equal(view.coverage.analyzed, prescreened.eligible.length,
    'analyzed must equal the full eligible universe, not the ranked union');
  const legacyUnion = new Set(TECHNICAL_FAMILIES.flatMap((f) => prescreened.perFamily[f].map((e) => e.ts_code)));
  assert.ok(legacyUnion.size < prescreened.eligible.length,
    'the legacy union must be strictly smaller than the eligible universe in this fixture');
});

test('no family is silently dropped and every family has observations', () => {
  assert.deepEqual(view.families.map((f) => f.family), [...TECHNICAL_FAMILIES]);
  for (const family of TECHNICAL_FAMILIES) {
    assert.ok(viewByFamily[family], `family ${family} missing from the view`);
    assert.ok(truthByFamily[family].length > 0,
      `fixture produced no ${family} observations; the recall comparison would be vacuous`);
  }
});

test('the view recalls every detector observation over the eligible universe', () => {
  const missed = truth.filter((o) => !viewKeys.has(truthKey(o)));
  assert.deepEqual(
    missed.slice(0, 10).map((o) => `${o.code} ${o.family} ${o.strategy_id} ${o.stage}`),
    [],
    `missed ${missed.length} of ${truth.length} observations`,
  );
  for (const family of TECHNICAL_FAMILIES) {
    assert.equal(viewByFamily[family].length, truthByFamily[family].length,
      `${family}: view=${viewByFamily[family].length} full=${truthByFamily[family].length}`);
  }
});

test('recall differs from the legacy prescreen union, measurably', () => {
  // The old design analysed only the union of the ranked per-family lists. The
  // fixture is constructed so that real patterns exist outside that union; if
  // this assertion ever goes false the recall test above stops proving anything.
  const legacyUnion = new Set(TECHNICAL_FAMILIES.flatMap((f) => prescreened.perFamily[f].map((e) => e.ts_code)));
  const outside = truth.filter((o) => !legacyUnion.has(o.code));
  assert.ok(outside.length > 0, 'no observation outside the legacy union: the recall gap is not being exercised');
  for (const family of TECHNICAL_FAMILIES) {
    assert.ok(outside.some((o) => o.family === family),
      `family ${family} has no observation outside the legacy union in this fixture`);
  }
});

test('the one-day production entry point has the same full recall', () => {
  assert.equal(dayView.status, 'OK');
  const keys = new Set(dayView.families.flatMap((f) => f.candidates.map((c) => `${c.ts_code}|${c.strategy_id}|${c.stage}`)));
  const missed = truth.filter((o) => !keys.has(truthKey(o)));
  assert.equal(missed.length, 0, `analyzeTechnicalDay missed ${missed.length} observations`);
  assert.equal(dayView.coverage.analyzed, prescreened.eligible.length);
});
