import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMACD } from '../build/tools/stockDataDetail/macd.js';
import { runFundManagerByName } from '../build/tools/fundManagerByName.js';
import { runWithRequestContext } from '../build/config.js';

test('MACD lines stay aligned even for short and empty inputs', () => {
  for (const prices of [[], [1, 2, 3], Array.from({ length: 40 }, (_, i) => i + 1)]) {
    const result = calculateMACD(prices);
    assert.equal(result.dif.length, prices.length);
    assert.equal(result.dea.length, prices.length);
    assert.equal(result.macd.length, prices.length);
    result.macd.forEach((value, i) => assert.ok(Math.abs(value - 2 * (result.dif[i] - result.dea[i])) < 1e-12));
  }
});

test('fund manager rejects a missing token without calling the provider', async () => {
  const originalToken = process.env.TUSHARE_TOKEN;
  const originalFetch = globalThis.fetch;
  delete process.env.TUSHARE_TOKEN;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected provider call'); };
  try {
    const result = await runFundManagerByName({ name: 'synthetic' });
    assert.match(result.content[0].text, /未设置 Tushare 凭证/);
    assert.equal(requests, 0);
    const scoped = await runWithRequestContext({ qverisApiKey: 'synthetic' }, () => runFundManagerByName({ name: 'synthetic' }));
    assert.match(scoped.content[0].text, /未设置 Tushare 凭证/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = originalToken;
  }
});
