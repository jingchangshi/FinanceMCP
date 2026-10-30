#!/usr/bin/env node
// WP5 end-to-end contract check: rebuild the 2026-10-29 snapshot with the
// current code, put it in a throwaway database, and call the real MCP tool
// (`runAshareTool('ashare_hotspot_opportunities', …)`) against it.
//
// Why a throwaway database: the production snapshot was written by an older
// image and carries no entry fields, so calling the tool on production today
// only proves the NOT_READY / old-shape path. This script proves the *new*
// payload shape survives the real tool serialisation — without writing anything
// to production. The production handle is `readOnly: true` and the pipeline is
// called with `persist: false`; the temp database lives under the OS temp dir
// and is deleted afterwards.
//
// Read-only with respect to production. Needs the Tushare token in the
// environment (`set -a && . deploy/ashare/.env && set +a`).
//
// Usage:
//   node scripts/entry-contract-sample.mjs [--db PATH] [--as-of YYYYMMDD] [--keep]
//   node scripts/entry-contract-sample.mjs --source stored    # pre-WP3 payload, degradation path
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB = '/home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite';
const arg = (n, d = null) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const dbPath = arg('--db', DEFAULT_DB);
const asOf = arg('--as-of', '20261029');
// `stored` replays the payload the older image actually wrote (no entry fields)
// so the "snapshot without entry_view" degradation is proven, not assumed.
const source = arg('--source', 'rebuild');

const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { openAshareDb } = await import('../build/ashare/db.js');

const prod = new DatabaseSync(dbPath, { readOnly: true });
let snap;
if (source === 'stored') {
  const row = prod.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(asOf);
  if (!row) throw new Error(`no stored snapshot for ${asOf}`);
  snap = JSON.parse(row.payload);
} else {
  snap = runHotspotPipeline(prod, asOf, { persist: false }).snapshot;
}
prod.close();

const dir = mkdtempSync(join(tmpdir(), 'entry-contract-'));
const scratch = join(dir, 'ashare.sqlite');
// The real migration code creates the scratch schema, so the tool's
// schemaCurrent() check passes exactly as it would on a migrated production DB.
const db = openAshareDb(scratch);
db.exec(`CREATE TABLE IF NOT EXISTS hotspot_snapshot (
  as_of TEXT NOT NULL, config_version TEXT NOT NULL, strategy_set_version TEXT,
  payload TEXT NOT NULL, content_hash TEXT, generated_at TEXT NOT NULL, coverage TEXT,
  PRIMARY KEY (as_of, config_version));`);
db.prepare(`INSERT INTO hotspot_snapshot
  (as_of, config_version, strategy_set_version, payload, content_hash, generated_at, coverage)
  VALUES (?,?,?,?,?,?,?)`).run(
  snap.as_of, snap.config_version, snap.strategy_set_version ?? null, JSON.stringify(snap),
  snap.content_hash ?? null, snap.generated_at ?? new Date().toISOString(),
  JSON.stringify(snap.counts ?? {}));
db.close();

// The tool resolves its database from the environment at call time.
process.env.ASHARE_DB_PATH = scratch;

const call = async args => {
  const r = await runAshareTool('ashare_hotspot_opportunities', args);
  return JSON.parse(r.content[0].text);
};

const all = await call({ date: asOf });
const eligible = await call({ date: asOf, entry_eligible: true });
const newEntry = await call({ date: asOf, candidate_class: 'NEW_ENTRY' });
const one = await call({ date: asOf, ts_code: '600926.SH' });

const first = eligible.candidates[0];
console.log('snapshot', all.as_of, 'config', snap.config_version, 'hash', all.content_hash);
console.log('counts', JSON.stringify(all.counts));
console.log('research_only', all.research_only, '| entry_view present:', all.entry_view !== null);
console.log('entry_view.counts', JSON.stringify(all.entry_view?.counts ?? null));
console.log('entry_top10', (all.entry_view?.entry_top10 ?? []).map(e => `${e.ts_code}:${e.entry_score}`).join(' '));
console.log('unfiltered candidates', all.candidates.length,
  '| entry_eligible=true →', eligible.candidates.length,
  '| candidate_class=NEW_ENTRY →', newEntry.candidates.length,
  '| single ts_code →', one.candidates.length);
console.log('entry_filter echoed', JSON.stringify(eligible.entry_filter));
console.log('row keys: entry_assessment in row =', 'entry_assessment' in (all.candidates[0] ?? {}),
  '| value =', JSON.stringify(all.candidates[0]?.entry_assessment),
  '| entry_assessments =', JSON.stringify(all.candidates[0]?.entry_assessments));
if (first) {
  console.log('\nfirst eligible candidate as serialised by the tool:');
  console.log(JSON.stringify(first, null, 1).slice(0, 2600));
} else {
  const sample = all.candidates.find(c => c.entry_assessment) ?? all.candidates[0];
  console.log('\nno entry-eligible row; first candidate as serialised by the tool:');
  console.log(JSON.stringify(sample, null, 1).slice(0, 1600));
}

const problems = [];
if (one.candidates.length !== 1) problems.push('ts_code filter did not return exactly one row');
if (all.research_only !== true) problems.push('research_only flag lost');
if (eligible.entry_filter?.entry_eligible !== true) problems.push('entry_filter not echoed');

if (source === 'stored') {
  // A snapshot written before goal-1030 WP3 must degrade, not invent: no
  // entry_view, no per-candidate assessment, and an empty eligible answer.
  if (all.entry_view !== null) problems.push('a pre-WP3 snapshot produced an entry_view');
  if (all.candidates.some(c => c.entry_assessment !== null)) problems.push('a pre-WP3 candidate produced an assessment');
  if (eligible.candidates.length !== 0) problems.push('a pre-WP3 snapshot produced entry-eligible candidates');
  if (all.candidates.length !== (snap.candidates ?? []).length) problems.push('candidate rows were dropped');
} else {
  if (!all.entry_view) problems.push('entry_view missing');
  if (!first) problems.push('no eligible candidate in the rebuilt snapshot');
  if (!first?.entry_assessment) problems.push('entry_assessment missing on a candidate');
  if (first && !(first.entry_assessment.ranking_contributions ?? []).length) problems.push('score parts missing');
  if (eligible.candidates.some(c => c.entry_assessment?.entry_eligibility !== true)) problems.push('entry_eligible filter leaked an ineligible row');
  // Candidate rows deliberately carry no `candidate_class` of their own (the class
  // lives in `entry_view`); the filter is checked against what the class means.
  if (newEntry.candidates.some(c => c.entry_assessment?.entry_stage !== 'NEWLY_CONFIRMED')) problems.push('candidate_class filter leaked another class');
  if (newEntry.candidates.length !== all.entry_view?.counts?.NEW_ENTRY) problems.push('NEW_ENTRY filter count disagrees with entry_view.counts');
}
console.log(problems.length ? `\nFAIL: ${problems.join('; ')}` : '\nOK: every contract expectation held');

if (arg('--keep')) console.log(`\nkept ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exitCode = problems.length ? 1 : 0;
