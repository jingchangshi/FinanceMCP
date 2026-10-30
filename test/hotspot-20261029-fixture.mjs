// Shared loader for the frozen 2026-10-29 hotspot regression sample.
//
// The fixture is a read-only export of production (see
// scripts/export-hotspot-fixture.mjs): the exact snapshot payload plus the
// forward-adjusted bars of the 40 FOCUS stocks. Replays here must never import
// from a live DB; they exist so lifecycle and ranking regressions are provable
// on real data without touching production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hotspot-20261029');

export const AS_OF = '20261029';

export function loadFixture() {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  const bars = JSON.parse(fs.readFileSync(path.join(dir, 'bars.json'), 'utf8'));
  return { meta, snapshot, bars };
}

export function focusCandidates(snapshot) {
  return snapshot.candidates.filter(c => c.pool === 'FOCUS');
}

export function candidateByCode(snapshot, code) {
  const c = snapshot.candidates.find(x => x.ts_code === code);
  if (!c) throw new Error(`candidate not in fixture: ${code}`);
  return c;
}

export function candidateByName(snapshot, name) {
  const c = snapshot.candidates.find(x => x.name === name);
  if (!c) throw new Error(`candidate not in fixture: ${name}`);
  return c;
}

/**
 * Slice a stock's bars to the production scan window: dates >= the market's
 * 330th-from-last trade date. Stocks halted inside the window legitimately
 * carry fewer than 330 bars, exactly as `forEachStockBars` returns them.
 */
export function sliceToScanWindow(bars, windowStart) {
  const s = bars.dates.findIndex(d => d >= windowStart);
  if (s < 0) throw new Error(`window start ${windowStart} after last bar`);
  const cut = key => bars[key].slice(s);
  return {
    dates: cut('dates'), open: cut('open'), high: cut('high'), low: cut('low'),
    close: cut('close'), vol: cut('vol'), amount: cut('amount'),
    rawOpen: cut('rawOpen'), rawClose: cut('rawClose'), upLimit: cut('upLimit'),
    adjMissing: 0,
  };
}

/**
 * Replay the production strategy scan for one fixture stock over the frozen
 * window. RPS120 needs the full-market cross-section (not present offline), so
 * `tc_rps_hold` cannot fire here; every other strategy and the whole risk
 * overlay replay byte-for-byte against the stored snapshot.
 */
export async function replayStock(code, fixture) {
  const { computeIndicators } = await import('../build/ashare/indicators.js');
  const { detectStrategyEvents } = await import('../build/ashare/strategies.js');
  const b = sliceToScanWindow(fixture.bars[code], fixture.meta.scan_window_start);
  const x = computeIndicators(b);
  return { bars: b, indicators: x, scan: detectStrategyEvents(code, b, x, new Map(), b.dates.length - 1) };
}

export function dateIndex(bars) {
  return new Map(bars.dates.map((d, i) => [d, i]));
}
