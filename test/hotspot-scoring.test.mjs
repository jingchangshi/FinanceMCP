// Focused scoring regressions for hotspot factors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rps80Density, evaluateHotspotSectors, DEFAULT_HOTSPOT_CONFIG } from '../build/ashare/hotspot.js';
import { openAshareDb } from '../build/ashare/db.js';
import { ensureHotspotSchema } from '../build/ashare/hotspotTables.js';

test('RPS80 density uses only members with an available 120-bar RPS value', () => {
  const members = ['a', 'b', 'c', 'd', 'e'];
  const available = new Set(['a', 'b', 'c', 'd']);
  const above80 = new Set(['a', 'b', 'e']); // e has no valid 120-bar RPS.
  assert.equal(rps80Density(members, available, above80, 3), 0.5);
});

test('RPS80 density is unavailable when eligible-member coverage is below minimum', () => {
  const members = ['a', 'b', 'c'];
  const available = new Set(['a']);
  const above80 = new Set(['a']);
  assert.equal(rps80Density(members, available, above80, 2), null);
  assert.equal(rps80Density(members, new Set(), above80, 1), null);
});

test('negative drawdown percentiles reward shallower drawdowns in current and historical ranks', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const day = db.prepare('INSERT INTO trade_cal (cal_date, is_open) VALUES (?, 1)');
  const sector = db.prepare("INSERT INTO sw_classify (index_code, level, name, collected_at) VALUES (?, 'L1', ?, 'test')");
  const bar = db.prepare("INSERT INTO sw_index_daily (ts_code, trade_date, close, synced_at) VALUES (?, ?, ?, 'test')");
  const dates = Array.from({ length: 70 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10).replaceAll('-', '');
    day.run(date);
    return date;
  });
  for (const [code, close, start] of [['deep', 70, 0], ['middle', 80, 0], ['flat1', 100, 0], ['flat2', 100, 0], ['short', 100, 11]]) {
    sector.run(code, code);
    for (let i = start; i < dates.length; i++) bar.run(code, dates[i], i < 60 ? 100 : close);
  }
  const snapshot = evaluateHotspotSectors(db, dates.at(-1), { ...DEFAULT_HOTSPOT_CONFIG, weights: { vol_dd: 1 } });
  const rows = Object.fromEntries(snapshot.sectors.map(s => [s.name, s]));
  for (const [name, raw, z] of [['deep', -0.3, 0], ['middle', -0.2, 1 / 3], ['flat1', 0, 5 / 6], ['flat2', 0, 5 / 6]]) {
    const factor = rows[name].factors[0];
    assert.ok(Math.abs(factor.raw - raw) < 1e-12);
    assert.ok(Math.abs(factor.z - z) < 1e-12);
    assert.equal(rows[name].strength, factor.z);
  }
  assert.ok(rows.flat1.rank < rows.middle.rank && rows.middle.rank < rows.deep.rank);
  assert.ok(rows.flat1.rank_5d_ago < rows.middle.rank_5d_ago && rows.middle.rank_5d_ago < rows.deep.rank_5d_ago);
  assert.equal(rows.short.factors[0].raw, null);
  assert.equal(rows.short.factors[0].z, null);
  assert.equal(rows.short.strength, null);
});

test('sector and member metrics exclude stale bars and report eligible denominators', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const calendar = db.prepare('INSERT INTO trade_cal (cal_date, is_open) VALUES (?, 1)');
  const sector = db.prepare("INSERT INTO sw_classify (index_code, level, name, collected_at) VALUES (?, 'L1', ?, 'test')");
  const index = db.prepare("INSERT INTO sw_index_daily (ts_code, trade_date, close, synced_at) VALUES (?, ?, 100, 'test')");
  const basic = db.prepare('INSERT INTO stock_basic (ts_code) VALUES (?)');
  const member = db.prepare("INSERT INTO sw_member (ts_code, l1_code, l2_code, l3_code, in_date, collected_at) VALUES (?, 'fresh', 'l2', 'l3', '20200101', 'test')");
  const daily = db.prepare('INSERT INTO daily (ts_code, trade_date, close) VALUES (?, ?, ?)');
  const adj = db.prepare('INSERT INTO adj_factor (ts_code, trade_date, adj_factor) VALUES (?, ?, 1)');
  const dates = Array.from({ length: 65 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10).replaceAll('-', ''));
  for (const code of ['fresh', 'stale', 'other', 'other2']) sector.run(code, code);
  for (const code of ['up', 'staleStock', 'unknown']) { basic.run(code); member.run(code); }
  dates.forEach((date, i) => {
    calendar.run(date);
    for (const code of ['fresh', 'stale', 'other', 'other2']) if (code !== 'stale' || i < 64) index.run(code, date);
    for (const code of ['up', 'staleStock', 'unknown']) {
      if (code === 'staleStock' && i === 64) continue;
      daily.run(code, date, code === 'unknown' && i === 63 ? null : code === 'up' ? 10 + i : 10);
      adj.run(code, date);
    }
  });
  const snapshot = evaluateHotspotSectors(db, dates.at(-1), { ...DEFAULT_HOTSPOT_CONFIG, minMembers: 1 });
  const fresh = snapshot.sectors.find(s => s.name === 'fresh');
  const stale = snapshot.sectors.find(s => s.name === 'stale');
  const factor = id => fresh.factors.find(f => f.id === id).raw;
  assert.equal(stale.state, 'UNKNOWN');
  assert.equal(stale.rank, null);
  assert.ok(stale.quality_notes.some(n => n.reason === 'stale_index_bar'));
  assert.equal(factor('breadth'), 1);
  assert.equal(factor('above_ma20_ratio'), 1);
  assert.equal(factor('excess_streak'), null);
  assert.ok(fresh.quality_notes.some(n => n.reason === 'member_metrics_coverage' && /members=3, breadth=1, ma20=1, ma60=1, rps120=0/.test(n.detail)));
  assert.equal(snapshot.coverage.find(c => c.dataset === 'sector_rank_eligible').rows, 3);
});
