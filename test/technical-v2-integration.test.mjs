// Technical methodology V2 — integration seams (goal-1102).
//
// Covers what the unit tests cannot:
//   1. full-market discovery without any FOCUS/RPS seeding;
//   2. a one-price limit-down as-of bar never becomes research-ready or FOCUS;
//   3. a suspended name keeps its last bar date and never borrows the as-of date;
//   4. the daily pipeline writes one V2 snapshot and no V1 surface;
//   5. repeated runs serialize identically (deterministic view and universe);
//   6. the private bundle reads that one snapshot, including its identity.
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
const { isCurrentSnapshot } = await import('../build/ashare/hotspotSnapshots.js');
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
const stateOf = (code) => view.research_universe.stocks.find(s => s.ts_code === code);

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
  // One record per stock, and every record's state is one of the six.
  const codes = view.research_universe.stocks.map(s => s.ts_code);
  assert.equal(new Set(codes).size, codes.length, 'a stock must not appear twice');
  assert.equal(view.research_universe.counts.total, codes.length);
  for (const s of view.research_universe.stocks) {
    assert.ok(['FOCUS', 'WATCH', 'EXTENDED', 'DETERIORATING', 'BLOCKED', 'INVALIDATED'].includes(s.research_state));
  }
});

test('a known non-trading day refuses the view and names the last completed trading day', () => {
  // Saturday 20250104 is closed in the calendar; Friday 20250103 is open.
  db.prepare("INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES ('20250104', 0)").run();
  const weekend = analyzeTechnicalDay(db, '20250104');
  assert.equal(weekend.status, 'UNAVAILABLE');
  assert.match(weekend.reason, /20250104 非交易日/);
  assert.match(weekend.reason, /20250103/, 'the operator is pointed at the last completed trading day');
  assert.equal(weekend.research_universe.counts.total, 0, 'no weekend research universe is invented');
  assert.equal(weekend.research_universe.daily_highlights.length, 0);
});

test('one-price limit down is visible but never research_ready or FOCUS', () => {
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
  const s = stateOf(LIMIT_DOWN);
  if (s) {
    assert.equal(s.research_state, 'BLOCKED');
    assert.notEqual(s.research_state, 'FOCUS');
  }
  assert.ok(!view.research_universe.daily_highlights.includes(LIMIT_DOWN));
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
  const s = stateOf(SUSPENDED);
  if (s) {
    assert.equal(s.research_state, 'BLOCKED');
    assert.equal(s.trade_date, ctx.trade_date, 'the record must report the bar it actually read');
    for (const sig of s.signals) assert.notEqual(sig.confirmed_on, AS_OF, 'no fabricated same-day confirmation');
  }
  assert.ok(!view.research_universe.daily_highlights.includes(SUSPENDED));
});

test('every candidate carries a descriptive adjusted price position', () => {
  const required = [
    'close', 'ma20', 'ma60', 'atr14', 'rsi6', 'rsi14',
    'close_vs_ma20_pct', 'close_vs_ma20_atr', 'close_vs_ma60_pct',
    'ma20_above_ma60', 'ma20_rising',
    'reference_price', 'reference_kind', 'reference_distance_pct', 'reference_distance_atr',
    'bars_since_confirmation',
    'invalidation_level', 'invalidation_distance_pct', 'invalidation_distance_atr',
    'price_extension', 'price_extension_basis',
  ];
  let seen = 0;
  for (const f of view.families) {
    for (const c of f.candidates) {
      const p = c.price_position;
      assert.ok(p, `${c.ts_code} ${c.strategy_id} has no price position`);
      assert.equal(p.basis, 'adjusted_close', `${c.ts_code}: adjusted basis only`);
      for (const key of required) assert.ok(key in p, `${c.ts_code} ${c.strategy_id} missing ${key}`);
      assert.equal(typeof p.price_extension, 'boolean');
      assert.ok(Array.isArray(p.price_extension_basis) && p.price_extension_basis.length > 0);
      seen++;
    }
  }
  assert.ok(seen > 0, 'the view must contain candidates');
  for (const s of view.research_universe.stocks) {
    for (const sig of s.signals) assert.ok('price_position' in sig, `${s.ts_code} signal missing price_position`);
  }
});

test('repeated analysis is deterministic in families, contexts and the research universe', () => {
  const again = analyzeTechnicalDay(db, AS_OF);
  assert.deepEqual(again.families, view.families);
  assert.deepEqual(again.contexts, view.contexts);
  assert.deepEqual(again.research_universe, view.research_universe);
  assert.equal(again.coverage.preselected, view.coverage.preselected);
});

test('the daily pipeline writes one V2 snapshot and keeps no V1 surface', () => {
  const result = runHotspotPipeline(db, AS_OF, { persist: false, etfCodes: [] });
  const snap = result.snapshot;
  assert.equal(snap.framework, 'V2_ONLY');
  assert.equal(snap.framework_version, view.framework_version);
  assert.equal(snap.implementation_fingerprint, view.implementation_fingerprint);
  assert.ok(snap.technical_view, 'snapshot must carry the V2 view');
  assert.equal(snap.technical_view.status, 'OK');
  assert.equal(snap.technical_view.as_of, AS_OF);
  assert.equal(snap.technical_view.families.length, 5);
  assert.equal(snap.technical_view.research_universe.as_of, AS_OF);
  // The per-stock record exists once, inside the view — no duplicated pool.
  for (const gone of ['candidates', 'entry_view', 'counts', 'pool', 'priority', 'research_universe']) {
    assert.equal(gone in snap, false, `snapshot must not carry a top-level ${gone}`);
  }
  assert.equal(snap.research_only, true);
  assert.equal(snap.data_quality, result.readiness.status);
  assert.equal(snap.market_data_as_of, AS_OF);
  assert.equal(isCurrentSnapshot(snap), true);
  // Timings are outside the snapshot body so they cannot perturb content_hash.
  assert.equal('timings' in snap, false);
  for (const k of ['sectors', 'rps', 'technical', 'write', 'total']) assert.equal(typeof result.timings[k], 'number');
});

test('markdown preview states stages and shared context once', () => {
  const md = renderTechnicalViewMarkdown(view);
  assert.match(md, /A股技术方法 V2 预览/);
  assert.match(md, /共享量价与交易状态/);
  assert.match(md, /UNVERIFIED/);
  assert.match(md, /不存在跨家族 100 分/);
});

test('private research bundle reads the same snapshot and carries its identity', () => {
  const result = runHotspotPipeline(db, AS_OF, { persist: true, etfCodes: [] });
  assert.ok(result.saved, `snapshot must be persisted (readiness=${result.readiness.status})`);
  assert.equal(result.saved.hash_basis, 'v3');
  const block = buildHotspotState({ db, asOf: AS_OF });
  assert.equal(block.status, 'OK');
  assert.equal(block.schema, 'ashare-hotspot-research/2.0');
  assert.equal(block.snapshot.as_of, AS_OF);
  assert.equal(block.snapshot.version_no, result.saved.version_no);
  assert.equal(block.snapshot.content_hash, result.saved.content_hash);
  assert.equal(block.snapshot.implementation_fingerprint, view.implementation_fingerprint);
  assert.deepEqual(block.research_state_counts, view.research_universe.counts);
  assert.ok(block.daily_highlights.length <= 5);
  for (const s of block.daily_highlights) {
    assert.ok(s.research_state === 'FOCUS' || s.research_state === 'WATCH');
  }
  // A V1-era bundle field must not exist as a compatibility alias.
  for (const gone of ['candidates', 'entry_view', 'technical_view_v2']) {
    assert.equal(gone in block, false, `bundle must not expose ${gone}`);
  }
});
