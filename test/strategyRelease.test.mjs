import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStrategyRelease } from '../build/ashare/strategyRelease.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/strategy-release.json', import.meta.url), 'utf8'));
const canonical = x => typeof x === 'string' ? JSON.stringify(x) : Array.isArray(x)
  ? `[${x.map(canonical).join(',')}]`
  : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
const rehash = x => {
  const { content_hash, ...payload } = x;
  x.content_hash = createHash('sha256').update(canonical(payload)).digest('hex');
};

test('shared fixture validates without production approval', () => {
  assert.equal(validateStrategyRelease(fixture), 'f174eb2c37e1451d444ac1ea5e0962f39934e3b675ae2b374fc723bf10441555');
  assert.equal(fixture.production_admission, 'NOT_APPROVED');
});

test('Unicode scalar values hash identically without normalization; lone surrogates fail', () => {
  const cases = [
    [JSON.parse('"策略 \\ud83d\\ude00"'), 'c40a8a9e54e32b04ae0d74c0697c0721faa658fe58cf9e947f1cca3d7eba3b55'],
    ['café', '833f0749ad1f0c96ca59ba96f183c2ad64aae5a40d28413fccde241503fdef62'],
    ['café', 'ea653e22002647682f824e3e72f402fbe1ab4bfd81da64c260892ee9084ef5d0'],
  ];
  for (const [value, expected] of cases) {
    const release = structuredClone(fixture); release.rules[0] = value; rehash(release);
    assert.equal(validateStrategyRelease(release), expected);
    assert.equal(release.rules[0], value);
  }
  for (const value of ['\ud800', '\udc00']) {
    const release = structuredClone(fixture); release.rules[0] = value;
    assert.throws(() => validateStrategyRelease(release));
  }
});

test('merged field names cannot replace own required fields', () => {
  const release = structuredClone(fixture);
  release.applicability = Object.assign(
    Object.create({ environment: 'UNKNOWN', market: 'UNKNOWN' }),
    { 'environment|market': 'UNKNOWN' },
  );
  rehash(release);
  assert.throws(() => validateStrategyRelease(release));
});

test('tampering, missing fields and unknown states fail closed', () => {
  const cases = [
    x => { x.rules[0] += ' altered'; },
    x => { delete x.inputs.assets; rehash(x); },
    x => { x.research_status = 'UNKNOWN'; rehash(x); },
    x => { x.production_admission = 'APPROVED'; rehash(x); },
    x => { delete x.production_admission; rehash(x); },
    x => { x.inputs.end_date = '2020-02-30'; rehash(x); },
    x => { x.inputs.start_date = '2021-01-01'; rehash(x); },
    x => { x.parameters.lookback = 200; rehash(x); },
    x => { x.extra = 'ignored?'; rehash(x); },
    x => { x.evidence[0].sha256 = 'bad'; rehash(x); },
  ];
  for (const [group, fields] of Object.entries({
    strategy: ['implementation_sha256'], applicability: ['market', 'environment'],
    execution_assumptions: ['signal_timing', 'earliest_execution', 'exit', 'fees', 'lot_size'],
  })) {
    for (const field of fields) {
      const missing = structuredClone(fixture); delete missing[group][field]; rehash(missing);
      assert.throws(() => validateStrategyRelease(missing), `${group}.${field} missing`);
      const altered = structuredClone(fixture); altered[group][field] = 'changed';
      assert.throws(() => validateStrategyRelease(altered), `${group}.${field} tampered`);
    }
  }
  const invalidHash = structuredClone(fixture);
  invalidHash.strategy.implementation_sha256 = 'invalid'; rehash(invalidHash);
  assert.throws(() => validateStrategyRelease(invalidHash));
  const knownHash = structuredClone(fixture);
  knownHash.strategy.implementation_sha256 = 'b'.repeat(64); rehash(knownHash);
  assert.equal(validateStrategyRelease(knownHash), knownHash.content_hash);
  for (const mutate of cases) {
    const copy = structuredClone(fixture);
    mutate(copy);
    assert.throws(() => validateStrategyRelease(copy));
  }
});
