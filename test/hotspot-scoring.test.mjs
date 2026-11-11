// Focused scoring regressions for hotspot factors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rps80Density } from '../build/ashare/hotspot.js';

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
