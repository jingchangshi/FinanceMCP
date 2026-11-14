import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const moduleUrl = process.env.RESEARCH_EXPORT_MODULE
  ? pathToFileURL(process.env.RESEARCH_EXPORT_MODULE).href
  : new URL('../build/ashare/researchExport.js', import.meta.url).href;
const { runResearchExport } = await import(moduleUrl);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'research-atomic-'));
  const db = new DatabaseSync(join(root, 'live.sqlite'));
  db.exec(`CREATE TABLE trade_cal(cal_date TEXT PRIMARY KEY, is_open INTEGER);
    INSERT INTO trade_cal VALUES ('20260109', 1);
    CREATE TABLE daily(ts_code TEXT PRIMARY KEY, trade_date TEXT, close REAL);
    INSERT INTO daily VALUES ('A', '20260109', 10);
    CREATE TABLE fund_daily(ts_code TEXT PRIMARY KEY, trade_date TEXT, close REAL);
    CREATE TABLE stock_basic(ts_code TEXT PRIMARY KEY, name TEXT);
    INSERT INTO stock_basic VALUES ('A', 'old');`);
  const options = { outputDir: join(root, 'out'), asOfTradeDate: '20260109', now: new Date('2026-01-10T00:00:00Z'), datasets: ['stock_basic', 'daily_bars'] };
  return { root, db, options, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
function verify(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const [file, digest] of Object.entries(manifest.content_hashes)) {
    assert.equal(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'), digest);
  }
  return manifest;
}
function noStages(root) {
  const stages = readdirSync(root).filter(x => x.startsWith('.out.research-export-'));
  const output = join(root, 'out');
  const target = existsSync(output) && lstatSync(output).isSymbolicLink() ? readlinkSync(output) : '';
  const published = target.startsWith('.out.research-export-') ? [target] : [];
  assert.deepEqual(stages, published);
}

test('publishes privately into an absent directory; identical retry preserves original manifest', () => {
  const f = fixture();
  try {
    const prepare = f.db.prepare.bind(f.db);
    let inspectedStage = false;
    f.db.prepare = sql => {
      if (sql.includes(' FROM "stock_basic"')) {
        const stage = readdirSync(f.root).find(name => name.startsWith('.out.research-export-'));
        assert.ok(stage);
        assert.equal(existsSync(f.options.outputDir), false);
        assert.equal(statSync(join(f.root, stage)).mode & 0o777, 0o700);
        inspectedStage = true;
      }
      return prepare(sql);
    };
    const first = runResearchExport(f.db, f.options);
    assert.ok(inspectedStage);
    f.db.prepare = prepare;
    assert.equal(statSync(f.options.outputDir).mode & 0o777, 0o700);
    const original = readFileSync(join(f.options.outputDir, 'manifest.json'));
    const retry = runResearchExport(f.db, { ...f.options, now: new Date('2026-01-11T00:00:00Z') });
    assert.deepEqual(retry, first);
    assert.deepEqual(readFileSync(join(f.options.outputDir, 'manifest.json')), original);
    assert.deepEqual(verify(f.options.outputDir), first);
    noStages(f.root);
    const other = join(f.root, 'new', 'out');
    runResearchExport(f.db, { ...f.options, outputDir: other });
    verify(other);
  } finally { f.close(); }
});

test('changed or damaged snapshots and arbitrary user files are never overwritten', () => {
  const f = fixture();
  try {
    runResearchExport(f.db, f.options);
    const original = readFileSync(join(f.options.outputDir, 'manifest.json'));
    const csv = readFileSync(join(f.options.outputDir, 'stock_basic.csv'));
    f.db.exec("UPDATE stock_basic SET name='new'");
    assert.throws(() => runResearchExport(f.db, f.options), /research_export_output_exists/);
    assert.deepEqual(readFileSync(join(f.options.outputDir, 'manifest.json')), original);
    assert.deepEqual(readFileSync(join(f.options.outputDir, 'stock_basic.csv')), csv);
    writeFileSync(join(f.options.outputDir, 'stock_basic.csv'), 'tampered');
    assert.throws(() => runResearchExport(f.db, f.options), /research_export_output_exists/);
    assert.equal(readFileSync(join(f.options.outputDir, 'stock_basic.csv'), 'utf8'), 'tampered');
    const other = join(f.root, 'occupied');
    mkdirSync(other);
    writeFileSync(join(other, 'personal'), 'keep');
    assert.throws(() => runResearchExport(f.db, { ...f.options, outputDir: other }), /research_export_output_exists/);
    assert.equal(readFileSync(join(other, 'personal'), 'utf8'), 'keep');
    noStages(f.root);
  } finally { f.close(); }
});

test('failure after writing a dataset leaves target untouched and removes staging', () => {
  const f = fixture();
  try {
    mkdirSync(f.options.outputDir);
    f.db.exec('DROP TABLE daily; CREATE TABLE daily(ts_code TEXT, trade_date TEXT, close REAL); INSERT INTO daily VALUES (\'A\', \'20260109\', 10)');
    assert.throws(() => runResearchExport(f.db, f.options), /requires a primary key/);
    assert.deepEqual(readdirSync(f.options.outputDir), []);
    noStages(f.root);
    f.db.exec('BEGIN; ROLLBACK');
  } finally { f.close(); }
});

test('commit failure does not publish and caller transactions are rejected without rollback', () => {
  const f = fixture();
  try {
    const exec = f.db.exec.bind(f.db);
    f.db.exec = sql => { if (sql === 'COMMIT') throw new Error('injected commit failure'); return exec(sql); };
    assert.throws(() => runResearchExport(f.db, f.options), /injected commit failure/);
    assert.equal(existsSync(f.options.outputDir), false);
    noStages(f.root);
    f.db.exec = exec;
    f.db.exec('BEGIN');
    f.db.exec("UPDATE stock_basic SET name='uncommitted'");
    assert.throws(() => runResearchExport(f.db, f.options), /research_export_existing_transaction/);
    assert.equal(existsSync(f.options.outputDir), false);
    assert.throws(() => f.db.exec('BEGIN'), /cannot start a transaction/);
    f.db.exec('ROLLBACK');
    runResearchExport(f.db, f.options);
    assert.match(readFileSync(join(f.options.outputDir, 'stock_basic.csv'), 'utf8'), /old/);
    assert.doesNotMatch(readFileSync(join(f.options.outputDir, 'stock_basic.csv'), 'utf8'), /uncommitted/);
  } finally { f.close(); }
});

test('existing empty directory is preserved, including its identity and permissions', () => {
  const f = fixture();
  try {
    mkdirSync(f.options.outputDir, { mode: 0o750 });
    const before = statSync(f.options.outputDir);
    assert.throws(() => runResearchExport(f.db, f.options), /research_export_output_exists/);
    const after = statSync(f.options.outputDir);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(readdirSync(f.options.outputDir), []);
    noStages(f.root);
  } finally { f.close(); }
});

test('rejects a writable parent, including one reached through a symlink', () => {
  const f = fixture();
  try {
    const unsafe = join(f.root, 'unsafe');
    const alias = join(f.root, 'alias');
    mkdirSync(unsafe);
    chmodSync(unsafe, 0o777);
    symlinkSync(unsafe, alias);
    for (const parent of [unsafe, alias]) {
      assert.throws(() => runResearchExport(f.db, { ...f.options, outputDir: join(parent, 'out') }), /research_export_unsafe_parent/);
    }
    assert.deepEqual(readdirSync(unsafe), []);
  } finally { f.close(); }
});

test('rejects a symlink output without touching its destination', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'target');
    mkdirSync(target);
    symlinkSync(target, f.options.outputDir);
    assert.throws(() => runResearchExport(f.db, f.options));
    assert.deepEqual(readdirSync(target), []);
    noStages(f.root);
  } finally { f.close(); }
});

test('TactiCore contract and research frames load the actual symlink publication', {
  skip: !process.env.TACTICORE_ROOT || !process.env.TACTICORE_PYTHON,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-tacticore-'));
  const previousDir = process.env.ASHARE_DATA_DIR;
  const previousPath = process.env.ASHARE_DB_PATH;
  let db;
  try {
    process.env.ASHARE_DATA_DIR = root;
    process.env.ASHARE_DB_PATH = join(root, 'live.sqlite');
    const { openAshareDb } = await import(new URL('./db.js', moduleUrl));
    db = openAshareDb();
    db.exec(`INSERT INTO trade_cal(cal_date,is_open) VALUES ('20260109',1);
      INSERT INTO stock_basic(ts_code,symbol,name,list_date,list_status) VALUES ('600000.SH','600000','Example','20180101','L');
      INSERT INTO fund_basic(ts_code,name,fund_type,list_date,market) VALUES ('510300.SH','ETF','ETF','20120101','SH');
      INSERT INTO daily(ts_code,trade_date,close) VALUES ('600000.SH','20260109',10);
      INSERT INTO fund_daily(ts_code,trade_date,close) VALUES ('510300.SH','20260109',4);`);
    const outputDir = join(root, 'snapshot');
    const manifest = runResearchExport(db, { outputDir, asOfTradeDate: '20260109', now: new Date('2026-01-10T00:00:00Z') });
    assert.ok(lstatSync(outputDir).isSymbolicLink());
    const python = `import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom research.ashare.data.contract import load_snapshot_manifest, verify_snapshot_content\nfrom research.ashare.data.adapter import load_research_frames\np=Path(sys.argv[2])\nm=load_snapshot_manifest(p)\nverify_snapshot_content(m)\nf=load_research_frames(p)\nassert f.manifest.snapshot_id == m.snapshot_id\nassert {'600000.SH','510300.SH'} <= set(f.prices.columns)\nprint(m.snapshot_id)`;
    const result = spawnSync(process.env.TACTICORE_PYTHON, ['-I', '-c', python, process.env.TACTICORE_ROOT, outputDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), manifest.snapshot_id);
  } finally {
    db?.close();
    if (previousDir === undefined) delete process.env.ASHARE_DATA_DIR; else process.env.ASHARE_DATA_DIR = previousDir;
    if (previousPath === undefined) delete process.env.ASHARE_DB_PATH; else process.env.ASHARE_DB_PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent different exports have one winner and a complete snapshot', async () => {
  const f = fixture();
  try {
    const code = `import { DatabaseSync } from 'node:sqlite';
      const {runResearchExport}=await import(process.argv[1]);
      const db=new DatabaseSync(process.argv[2],{readOnly:true});
      try {runResearchExport(db,{outputDir:process.argv[3],asOfTradeDate:'20260109',now:new Date('2026-01-10T00:00:00Z'),datasets:process.argv[4].split(',')});}
      catch(e) {if (!String(e).includes('research_export_output_exists')) throw e; process.exitCode=2;} finally {db.close();}`;
    const launch = datasets => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code, moduleUrl, join(f.root, 'live.sqlite'), f.options.outputDir, datasets], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; p.stderr.on('data', chunk => { stderr += chunk; });
      p.on('error', reject); p.on('close', status => resolve({ status, stderr }));
    });
    const results = await Promise.all([launch('stock_basic'), launch('daily_bars')]);
    assert.deepEqual(results.map(x => x.status).sort(), [0, 2], JSON.stringify(results));
    assert.equal(verify(f.options.outputDir).dataset_manifest.length, 1);
    noStages(f.root);
  } finally { f.close(); }
});
