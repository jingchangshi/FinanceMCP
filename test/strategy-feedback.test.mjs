import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { appendEvent, contentHash, validateEvent } from '../build/portfolio/strategyFeedback.js';

const fixture = JSON.parse(readFileSync(new URL('./strategy-feedback-fixture.json', import.meta.url)));
test('synthetic event identities and append-only conflict', () => {
  let events = [];
  for (const {event, sha256} of fixture) {
    assert.equal(contentHash(event), sha256);
    events = appendEvent(events, event);
  }
  const copy = appendEvent(events, structuredClone(fixture[0].event));
  assert.equal(copy.length, events.length);
  copy[0].payload.result = 'TRIGGERED';
  assert.equal(events[0].payload.result, 'NOT_TRIGGERED');
  assert.throws(() => appendEvent(events, copy[0]), /conflicting/);
});
test('reject invalid fields, identifiers, timestamps and states', () => {
  const original = fixture[0].event;
  for (const mutate of [
    e => e.account_id = 'PRIVATE',
    e => e.payload.account = 'PRIVATE',
    e => e.payload = {'result|signal_id': 'TEST_SIGNAL'},
    e => e.payload.result = 'ACTUAL_FILL',
    e => e.occurred_at = '2026-02-30T00:00:00Z',
    e => e.recorded_at = '2025-01-01T00:00:00Z',
    e => e.release_hash = 'a'.repeat(64) + '\n',
    e => e.coverage.period_start = '2026-01-03',
    e => e.event_id = 'bad\n',
    e => e.event_type = 'toString',
  ]) { const event = structuredClone(original); mutate(event); assert.throws(() => validateEvent(event)); }
  const correction = structuredClone(fixture.at(-1).event);
  correction.payload.corrects_event_id = correction.event_id;
  assert.throws(() => validateEvent(correction));
});
test('both languages reject delimiter-colliding object keys', {skip: !process.env.TACTICORE_FEEDBACK_ROOT}, () => {
  const event = structuredClone(fixture[0].event);
  event.payload = {'result|signal_id': 'TEST_SIGNAL'};
  assert.throws(() => validateEvent(event));
  const script = 'import json,sys; from tacticore.strategy_feedback import validate_event; validate_event(json.load(sys.stdin))';
  const result = spawnSync('python3', ['-c', script], {cwd: process.env.TACTICORE_FEEDBACK_ROOT, input: JSON.stringify(event), encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ValueError: invalid payload/);
});
test('Python and TypeScript hash identical event content', {skip: !process.env.TACTICORE_FEEDBACK_ROOT}, () => {
  const script = 'import json,sys; from tacticore.strategy_feedback import content_hash; print(json.dumps([content_hash(x["event"]) for x in json.load(sys.stdin)]))';
  const result = spawnSync('python3', ['-c', script], {cwd: process.env.TACTICORE_FEEDBACK_ROOT, input: JSON.stringify(fixture), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), fixture.map(({event}) => contentHash(event)));
});
