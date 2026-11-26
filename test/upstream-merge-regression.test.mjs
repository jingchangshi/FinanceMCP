import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMACD } from '../build/tools/stockDataDetail/macd.js';

test('MACD lines stay aligned even for short and empty inputs', () => {
  for (const prices of [[], [1, 2, 3], Array.from({ length: 40 }, (_, i) => i + 1)]) {
    const result = calculateMACD(prices);
    assert.equal(result.dif.length, prices.length);
    assert.equal(result.dea.length, prices.length);
    assert.equal(result.macd.length, prices.length);
    result.macd.forEach((value, i) => assert.ok(Math.abs(value - 2 * (result.dif[i] - result.dea[i])) < 1e-12));
  }
});
