import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFeedbackEvents, initFeedbackStore, listFeedbackEvents } from '../build/portfolio/strategyFeedbackStore.js';
import { runStrategyFeedbackCli } from '../build/portfolio/strategyFeedbackCli.js';

const fixture = JSON.parse(readFileSync(new URL('./strategy-feedback-fixture.json', import.meta.url))).map(x => x.event);
const clone = x => structuredClone(x);

test('atomic append, idempotence, conflicts and immutable correction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initFeedbackStore(db);
    assert.deepEqual(appendFeedbackEvents(db, fixture), {inserted: fixture.length, duplicates: 0});
    assert.deepEqual(appendFeedbackEvents(db, fixture), {inserted: 0, duplicates: fixture.length});
    const fresh = clone(fixture[0]); fresh.event_id = 'fresh';
    const conflict = clone(fixture[0]); conflict.payload.result = 'TRIGGERED';
    assert.throws(() => appendFeedbackEvents(db, [fresh, conflict]), /conflicting/);
    assert.deepEqual(listFeedbackEvents(db), fixture);
    assert.throws(() => db.exec("UPDATE strategy_feedback_events SET event_json = '{}'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM strategy_feedback_events'), /append-only/);
    assert.throws(() => db.exec("INSERT OR REPLACE INTO strategy_feedback_events(event_id,event_json,content_hash) VALUES ('sig1','{}','x')"), /append-only/);
    assert.throws(() => db.exec("INSERT OR REPLACE INTO strategy_feedback_events(seq,event_id,event_json,content_hash) VALUES (1,'other','{}','x')"), /append-only/);
  } finally { db.close(); }
});

test('references require preceding matching type, scope and times', () => {
  for (const mutate of [
    e => e.payload.signal_event_id = 'missing',
    e => e.release_hash = 'c'.repeat(64),
    e => e.snapshot_hash = 'c'.repeat(64),
    e => e.coverage.universe_id = 'OTHER',
    e => e.coverage.period_start = '2025-12-31',
    e => e.occurred_at = '2026-01-02T11:00:00Z',
    e => { e.occurred_at = '2026-01-02T11:00:00Z'; e.recorded_at = '2026-01-02T11:01:00Z'; },
  ]) {
    const db = new DatabaseSync(':memory:'); initFeedbackStore(db);
    try { const decision = clone(fixture[2]); mutate(decision); assert.throws(() => appendFeedbackEvents(db, [fixture[0], decision])); assert.deepEqual(listFeedbackEvents(db), []); }
    finally { db.close(); }
  }
  const db = new DatabaseSync(':memory:'); initFeedbackStore(db);
  try { assert.throws(() => appendFeedbackEvents(db, [fixture[2], fixture[0]]), /reference/); }
  finally { db.close(); }
});

test('CLI requires confirmation, protects file, and imports JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-'));
  const db = join(dir, 'feedback.sqlite'), input = join(dir, 'events.jsonl');
  try {
    writeFileSync(input, fixture.map(JSON.stringify).join('\n') + '\n');
    assert.deepEqual(runStrategyFeedbackCli(['list', '--db', join(dir, 'missing.sqlite')]), []);
    assert.throws(() => runStrategyFeedbackCli(['import', '--db', db, '--file', input]), /confirm/);
    assert.equal(existsSync(db), false);
    assert.deepEqual(runStrategyFeedbackCli(['import', '--db', db, '--file', input, '--confirm']), {inserted: fixture.length, duplicates: 0});
    assert.deepEqual(runStrategyFeedbackCli(['list', '--db', db]), fixture);
    const link = join(dir, 'link'); symlinkSync(db, link);
    assert.throws(() => runStrategyFeedbackCli(['list', '--db', link]), /owner-only/);
    chmodSync(db, 0o644);
    assert.throws(() => runStrategyFeedbackCli(['list', '--db', db]), /owner-only/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('CLI default and environment paths create private directories only after confirmation', () => {
  const home = mkdtempSync(join(tmpdir(), 'feedback-home-'));
  const input = join(home, 'events.jsonl');
  const cli = new URL('../build/portfolio/strategyFeedbackCli.js', import.meta.url).pathname;
  const defaultDir = join(home, '.local', 'share', 'ashare-private');
  const envDb = join(home, 'custom', 'feedback.sqlite');
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env: {...process.env, HOME: home, ASHARE_STRATEGY_FEEDBACK_DB: '', ...env}});
  try {
    writeFileSync(input, JSON.stringify(fixture[0]) + '\n');
    assert.notEqual(run(['import', '--file', input]).status, 0);
    assert.equal(existsSync(defaultDir), false);
    assert.equal(run(['import', '--file', input, '--confirm']).status, 0);
    assert.equal(statSync(defaultDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(defaultDir, 'strategy-feedback.sqlite')).mode & 0o777, 0o600);
    assert.equal(run(['import', '--file', input, '--confirm'], {ASHARE_STRATEGY_FEEDBACK_DB: envDb}).status, 0);
    assert.equal(statSync(join(home, 'custom')).mode & 0o777, 0o700);
    const explicit = join(home, 'explicit', 'db.sqlite');
    assert.equal(run(['import', '--db', explicit, '--file', input, '--confirm'], {ASHARE_STRATEGY_FEEDBACK_DB: envDb}).status, 0);
    assert.equal(existsSync(explicit), true);
    rmSync(defaultDir, {recursive: true});
    mkdirSync(defaultDir, {mode: 0o700});
    assert.equal(run(['import', '--file', input, '--confirm']).status, 0);
    chmodSync(defaultDir, 0o755);
    assert.match(run(['list']).stderr, /directory must be owner-only/);
  } finally { rmSync(home, {recursive: true, force: true}); }
});
