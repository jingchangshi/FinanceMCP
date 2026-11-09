// Technical methodology V2 — live full-market recall (goal-1106 WP5).
//
// The legacy discovery ranked every stock in each family's cheap prescreen and
// analysed only the top 120 per family / 500 overall. That is a *proxy*: a
// stock can satisfy a family's real definition without satisfying the proxy,
// and the capacity cap can drop a genuine live pattern. This test measures the
// difference against the five deterministic detectors run over every eligible
// stock, and pins the production view to that ground truth.
//
// "Live" means a currently valid episode: FORMING / CONFIRMED / FOLLOW_THROUGH.
// FAILED / EXPIRED observations are historical records, not recall gaps, so
// they are deliberately excluded from the recall assertion.
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
const { regimeSeries } = await import('../build/ashare/market.js');
const { detectAllPatterns } = await import('../build/ashare/technicalPatternsV2.js');

const LIVE_STAGES = new Set(['FORMING', 'CONFIRMED', 'FOLLOW_THROUGH']);
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

const regimeMap = regimeSeries(DB, AS_OF);
const regime = regimeMap.get(AS_OF) ?? 'UNKNOWN';
const regimeAt = (d) => regimeMap.get(d) ?? null;
const eligibleCodes = prescreened.eligible.map((e) => e.ts_code);
const legacyUnion = new Set(TECHNICAL_FAMILIES.flatMap((f) => prescreened.perFamily[f].map((e) => e.ts_code)));

/** Ground truth: the five detectors over every eligible stock, same bars/window.
 *  Production reads each stock from its first bar so recursive indicators are
 *  seeded independently of the as-of; the ground truth must do the same. */
function fullDetection() {
  const observations = [];
  forEachStockBars(DB, '19000101', AS_OF, (code, bars) => {
    if ((bars.adjMissing ?? 0) > 0) return;
    if (bars.dates.length < TECHNICAL_CAPACITY.minBars) return;
    const i = bars.dates.length - 1;
    const x = computeIndicators(bars);
    if (!(x.amountMa20[i] / 1e5 >= TECHNICAL_CAPACITY.minAmount20Yi)) return;
    for (const obs of detectAllPatterns({
      code, bars, x, endIdx: i, asOf: AS_OF, regime, regimeAt, rps120: null,
      barsBehindAsOf: AS_OF === bars.dates[i] ? 0 : 1,
    })) {
      observations.push({ code, family: obs.family, strategy_id: obs.strategy_id, stage: obs.stage });
    }
  }, eligibleCodes);
  return observations;
}

const truth = fullDetection();
const truthLive = truth.filter((o) => LIVE_STAGES.has(o.stage));
const truthDead = truth.filter((o) => !LIVE_STAGES.has(o.stage));
const keyOf = (o) => `${o.code}|${o.strategy_id}|${o.stage}`;
const liveKeys = (familyCandidates) => new Set(
  familyCandidates.filter((c) => LIVE_STAGES.has(c.stage)).map((c) => `${c.ts_code}|${c.strategy_id}|${c.stage}`),
);
const viewKeys = new Set(view.families.flatMap((f) => [...liveKeys(f.candidates)]));
const truthLiveByFamily = Object.fromEntries(TECHNICAL_FAMILIES.map((f) => [f, truthLive.filter((o) => o.family === f)]));

test('every eligible stock is analysed; the legacy capacity cap no longer gates detection', () => {
  assert.equal(view.status, 'OK');
  assert.ok(prescreened.eligible.length > TECHNICAL_CAPACITY.union,
    `fixture must exceed the legacy union cap (eligible=${prescreened.eligible.length})`);
  assert.ok(prescreened.capacity_limited > 0,
    'the legacy ranking still reports its diagnostic truncation');
  assert.equal(view.coverage.preselected, prescreened.eligible.length);
  assert.equal(view.coverage.analyzed, prescreened.eligible.length,
    'analyzed must equal the full eligible universe, not the ranked union');
  assert.equal(view.coverage.capacity_limited, 0,
    'no stock is actually truncated; the legacy count is diagnostic only');
  assert.ok(legacyUnion.size < prescreened.eligible.length,
    'the legacy union must be strictly smaller than the eligible universe in this fixture');
});

test('no family is silently dropped and every family has live observations', () => {
  assert.deepEqual(view.families.map((f) => f.family), [...TECHNICAL_FAMILIES]);
  for (const family of TECHNICAL_FAMILIES) {
    assert.ok(truthLiveByFamily[family].length > 0,
      `fixture produced no live ${family} observations; the recall comparison would be vacuous`);
  }
  assert.ok(truthDead.length > 0, 'fixture should also exercise dead episodes for the completeness record');
});

test('the view recalls every LIVE detector observation over the eligible universe', () => {
  assert.ok(truthLive.length > 0);
  const missed = truthLive.filter((o) => !viewKeys.has(keyOf(o)));
  assert.deepEqual(
    missed.slice(0, 10).map((o) => `${o.code} ${o.family} ${o.strategy_id} ${o.stage}`),
    [],
    `missed ${missed.length} of ${truthLive.length} live observations`,
  );
  for (const family of TECHNICAL_FAMILIES) {
    const inView = view.families.find((f) => f.family === family).candidates
      .filter((c) => LIVE_STAGES.has(c.stage));
    assert.equal(inView.length, truthLiveByFamily[family].length,
      `${family}: live in view=${inView.length} full=${truthLiveByFamily[family].length}`);
  }
});

test('live recall differs from the legacy prescreen union, measurably, in every family', () => {
  // The old design analysed only the union of the ranked per-family lists. The
  // fixture is constructed so that live patterns exist outside that union; if
  // this assertion ever goes false the recall test above stops proving anything.
  const outside = truthLive.filter((o) => !legacyUnion.has(o.code));
  assert.ok(outside.length > 0, 'no live observation outside the legacy union: the recall gap is not exercised');
  for (const family of TECHNICAL_FAMILIES) {
    assert.ok(outside.some((o) => o.family === family),
      `family ${family} has no live observation outside the legacy union in this fixture`);
  }
});

test('the one-day production entry point has the same live recall', () => {
  assert.equal(dayView.status, 'OK');
  const keys = new Set(dayView.families.flatMap((f) => [...liveKeys(f.candidates)]));
  const missed = truthLive.filter((o) => !keys.has(keyOf(o)));
  assert.equal(missed.length, 0, `analyzeTechnicalDay missed ${missed.length} live observations`);
  assert.equal(dayView.coverage.analyzed, prescreened.eligible.length);
  assert.equal(dayView.coverage.capacity_limited, 0);
});
