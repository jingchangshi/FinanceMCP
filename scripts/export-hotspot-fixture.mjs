#!/usr/bin/env node
// Export a frozen, reproducible regression sample for one hotspot trade day.
//
// The sample is read-only: the production DB is opened with `readOnly: true`
// and never written. What lands on disk is exactly what the pipeline produced
// for that day plus the forward-adjusted bars the lifecycle rules are evaluated
// on, so later tests can replay signal state without touching production.
//
// Usage:
//   node scripts/export-hotspot-fixture.mjs \
//     --db /home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite \
//     --as-of 20261029 --out test/fixtures/hotspot-20261029
//
// Output files:
//   meta.json      provenance (source file, size/mtime, snapshot hash, counts)
//   snapshot.json  the exact hotspot_snapshot payload
//   bars.json      forward-adjusted bars for every FOCUS stock, keyed by code
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { forEachStockBars } from '../build/ashare/bars.js';
import { recentTradeDays } from '../build/ashare/ingest.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('--db');
const asOf = arg('--as-of');
const outDir = arg('--out');
if (!dbPath || !asOf || !outDir) {
  console.error('usage: export-hotspot-fixture.mjs --db <path> --as-of <YYYYMMDD> --out <dir>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare(
  'SELECT as_of, config_version, strategy_set_version, content_hash, generated_at, coverage, payload FROM hotspot_snapshot WHERE as_of = ?',
).get(asOf);
if (!row) {
  console.error(`no hotspot_snapshot for ${asOf}`);
  process.exit(1);
}
const payload = JSON.parse(row.payload);
const focusCodes = payload.candidates.filter(c => c.pool === 'FOCUS').map(c => c.ts_code).sort();

// ~430 trading days of bars: enough warm-up for MA60/MACD/RPS-style rules and
// the 330-bar strategy window, ending exactly at the frozen day.
const start = '20250101';
const bars = {};
forEachStockBars(db, start, asOf, (code, b) => { bars[code] = b; }, focusCodes);

// The production strategy scan uses exactly the last 330 market trade days
// (`SCAN_BAR_COUNT`), not each stock's own last 330 bars. Record that window
// start so replays can slice identically even when a stock was suspended.
const windowStart = recentTradeDays(db, asOf, 330)[0];

const stat = fs.statSync(dbPath);
const meta = {
  as_of: asOf,
  exported_from: {
    db_path: dbPath,
    db_size: stat.size,
    db_mtime_iso: stat.mtime.toISOString(),
    snapshot_generated_at: row.generated_at,
    snapshot_content_hash: row.content_hash,
    config_version: row.config_version,
    strategy_set_version: row.strategy_set_version,
  },
  counts: payload.counts,
  focus_codes: focusCodes,
  bars_start: start,
  scan_window_start: windowStart,
  scan_window_bars: 330,
  bars_codes: Object.keys(bars).length,
  exported_by: 'scripts/export-hotspot-fixture.mjs',
  note: 'Real production data, read-only export. Never regenerate in place: the fixture is the regression baseline.',
};
meta.payload_sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'snapshot.json'), row.payload + '\n');
fs.writeFileSync(path.join(outDir, 'bars.json'), JSON.stringify(bars) + '\n');
console.log(JSON.stringify({
  out: outDir,
  as_of: asOf,
  focus: focusCodes.length,
  bars: Object.keys(bars).length,
  snapshot_hash: row.content_hash,
}, null, 2));
