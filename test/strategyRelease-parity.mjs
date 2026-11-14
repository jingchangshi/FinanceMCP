// Run after npm run build: node test/strategyRelease-parity.mjs /path/to/tacticore/fixture.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStrategyRelease } from '../build/ashare/strategyRelease.js';

if (process.argv.length !== 3) throw new Error('Expected path to the TactiCore fixture');
const finance = readFileSync(new URL('./fixtures/strategy-release.json', import.meta.url));
const tacticore = readFileSync(process.argv[2]);
assert.ok(finance.equals(tacticore), 'StrategyRelease fixtures differ');
const hash = validateStrategyRelease(JSON.parse(finance.toString('utf8')));
assert.equal(validateStrategyRelease(JSON.parse(tacticore.toString('utf8'))), hash);
console.log(`StrategyRelease fixtures match; content hash ${hash}`);
