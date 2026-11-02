// Technical methodology V2 — integration seams (goal-1102).
//
// Covers what the unit tests cannot:
//   1. full-market discovery without any FOCUS/RPS seeding;
//   2. a one-price limit-down as-of bar never becomes research_ready;
//   3. a suspended name keeps its last bar date and never borrows the as-of date;
//   4. the daily pipeline embeds `technical_view_v2` in the snapshot;
//   5. repeated runs serialize identically (deterministic candidates/contexts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'technical-v2-int-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');
const { analyzeTechnicalDay, renderTechnicalViewMarkdown } = await import('../build/ashare/technicalCandidatesV2.js');
const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const { buildHotspotState } = await import('../build/portfolio/researchBundle.js');

const DATES = weekdays('20250101', 160);
const AS_OF = DATES.at(-1);
const LIMIT_DOWN = '600010.SH';
const SUSPENDED = '600011.SH';

const db = openAshareDb();
seedReferenceUniverse(db, DATES);

// One-price limit down on the as-of bar (raw OHLC all equal the down limit).
const limitRow = db.prepare('SELECT close FROM daily WHERE ts_code = ? AND trade_date = ?').get(LIMIT_DOWN, AS_OF);
const down = Math.round(limitRow.close * 0.9 * 100) / 100;
db.prepare(`UPDATE daily SET open = ?, high = ?, low = ?, close = ?, pct_chg = -10
  WHERE ts_code = ? AND trade_date = ?`).run(down, down, down, down, LIMIT_DOWN, AS_OF);
db.prepare('UPDATE stk_limit SET down_limit = ? WHERE ts_code = ? AND trade_date = ?')
  .run(down, LIMIT_DOWN, AS_OF);

// Suspended on the as-of bar: no daily/adj/limit row, but a suspend_d record.
for (const table of ['daily', 'adj_factor', 'stk_limit']) {
  db.prepare(`DELETE FROM ${table} WHERE ts_code = ? AND trade_date = ?`).run(SUSPENDED, AS_OF);
}
upsertRows(db, 'suspend_d', ['ts_code', 'trade_date', 'suspend_timing'],
  [{ ts_code: SUSPENDED, trade_date: AS_OF, suspend_timing: 'S' }]);

const view = analyzeTechnicalDay(db, AS_OF);

test('full-market discovery produces all five families with no FOCUS seed', () => {
  assert.equal(view.status, 'OK');
  assert.equal(view.research_only, true);
  assert.equal(view.evidence_level, 'UNVERIFIED');
  assert.deepEqual(view.families.map(f => f.family), [
    'TREND_CONTINUATION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'VOLATILITY_EXPANSION', 'MEAN_REVERSION',
  ]);
  assert.ok(view.coverage.universe > 1000, `universe=${view.coverage.universe}`);
  assert.ok(view.coverage.preselected > 0);
  assert.ok(view.coverage.preselected <= 500);
});

test('one-price limit down is visible but never research_ready', () => {
  const ctx = view.contexts.find(c => c.ts_code === LIMIT_DOWN);
  assert.ok(ctx, 'limit-down name must have a shared context');
  assert.equal(ctx.trading_status, 'ONE_PRICE_LIMIT_DOWN');
  assert.equal(ctx.trade_date, AS_OF);
  assert.ok(ctx.price_volume_tags.includes('ONE_PRICE_LIMIT_DOWN'));
  for (const f of view.families) {
    for (const c of f.candidates.filter(x => x.ts_code === LIMIT_DOWN)) {
      assert.equal(c.research_ready, false);
      assert.ok(c.research_blockers.includes('ONE_PRICE_LIMIT_DOWN'));
    }
  }
});

test('suspended name keeps its last bar date and cannot be confirmed for the as-of day', () => {
  const ctx = view.contexts.find(c => c.ts_code === SUSPENDED);
  assert.ok(ctx, 'suspended name must have a shared context');
  assert.equal(ctx.trading_status, 'SUSPENDED');
  assert.notEqual(ctx.trade_date, AS_OF);
  assert.ok(ctx.bars_behind_as_of >= 1);
  for (const f of view.families) {
    for (const c of f.candidates.filter(x => x.ts_code === SUSPENDED)) {
      assert.equal(c.research_ready, false);
      assert.ok(c.research_blockers.includes('SUSPENDED'));
    }
  }
});

test('repeated analysis is deterministic in candidates and contexts', () => {
  const again = analyzeTechnicalDay(db, AS_OF);
  assert.deepEqual(again.families, view.families);
  assert.deepEqual(again.contexts, view.contexts);
  assert.equal(again.coverage.preselected, view.coverage.preselected);
});

test('daily pipeline embeds the V2 view and keeps legacy fields intact', () => {
  const result = runHotspotPipeline(db, AS_OF, { persist: false, etfCodes: [] });
  const snap = result.snapshot;
  assert.ok(snap.technical_view_v2, 'snapshot must carry technical_view_v2');
  assert.equal(snap.technical_view_v2.status, 'OK');
  assert.equal(snap.technical_view_v2.as_of, AS_OF);
  assert.equal(snap.technical_view_v2.families.length, 5);
  // V1 surfaces are still present and untouched in shape.
  assert.ok(Array.isArray(snap.candidates));
  assert.ok('entry_view' in snap);
  assert.ok('counts' in snap);
  assert.equal(snap.research_only, true);
});

test('markdown preview states stages and shared context once', () => {
  const md = renderTechnicalViewMarkdown(view);
  assert.match(md, /A股技术方法 V2 预览/);
  assert.match(md, /共享量价与交易状态/);
  assert.match(md, /UNVERIFIED/);
  assert.match(md, /不存在跨家族 100 分/);
});

test('private research bundle carries the same V2 view as the snapshot', () => {
  const result = runHotspotPipeline(db, AS_OF, { persist: true, etfCodes: [] });
  assert.ok(result.saved, `snapshot must be persisted (readiness=${result.readiness.status})`);
  const block = buildHotspotState({ db, asOf: AS_OF });
  assert.equal(block.status, 'OK');
  assert.equal(block.version_no, result.saved.version_no);
  assert.ok(block.technical_view_v2, 'bundle must carry technical_view_v2');
  // The persisted payload goes through JSON, which normalises -0 to 0; compare
  // the serialised form so the assertion is about content, not float identity.
  assert.deepEqual(JSON.parse(JSON.stringify(block.technical_view_v2.families)),
    JSON.parse(JSON.stringify(result.snapshot.technical_view_v2.families)));
  assert.equal(block.technical_view_v2.implementation_fingerprint,
    result.snapshot.technical_view_v2.implementation_fingerprint);
});
