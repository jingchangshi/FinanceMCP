// P2-9: the policy FinanceMCP enforces and the signed release TactiCore publishes
// must be the same contract. A drift here is silent by construction: the runtime
// falls back to hard-coded defaults when a parameter is missing or malformed, so a
// release/code mismatch would not fail any existing test — it would just trade a
// different policy than the one that was signed off.
//
// Fixture policy (deliberate): the release file lives in two repositories and only
// one of them is present in a standalone FinanceMCP checkout. The test skips with a
// reason instead of failing there, because "the other repo is not checked out here"
// is not evidence of drift. Run both repos together (or set TACTICORE_ROOT /
// ASHARE_INVESTOR_ROOT) to get the assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const { loadApprovedV3Policy } = await import('../build/portfolio/v3Policy.js');

const TACTICORE_ROOT = process.env.TACTICORE_ROOT?.trim() || '/home/jcshi/workspace/TactiCore';
const ASHARE_INVESTOR_ROOT = process.env.ASHARE_INVESTOR_ROOT?.trim() || '/home/jcshi/workspace/AShareInvestor';
const RELEASE_NAME = 'v3_offensive_policy_release_v3.2.0.json';
const TACTICORE_RELEASE = `${TACTICORE_ROOT}/research/ashare/releases/${RELEASE_NAME}`;
const INVESTOR_RELEASE = `${ASHARE_INVESTOR_ROOT}/docs/v3-offensive-system/fee-profiles/${RELEASE_NAME}`;

/** Compare a policy field to an integer parameter.
 *
 * The release stores every parameter as a string to avoid cross-language numeric
 * formatting ambiguity; the runtime parses it. Both halves are checked: a
 * non-integer string in the release is a malformed release even if the numeric
 * value would have looked right, and a runtime fallback is caught as a mismatch. */
function integerParam(parameters, key) {
  const raw = parameters[key];
  assert.equal(typeof raw, 'string', `release parameter ${key} must be a string`);
  assert.match(raw, /^-?\d+$/, `release parameter ${key} must be an integer string, got ${JSON.stringify(raw)}`);
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value), `release parameter ${key} is out of safe integer range`);
  return value;
}

test('runtime V3 policy fields match the signed release JSON', t => {
  if (!existsSync(TACTICORE_RELEASE)) {
    t.skip(`TactiCore release not found at ${TACTICORE_RELEASE}; skipping cross-repo consistency in a standalone FinanceMCP checkout`);
    return;
  }
  // A runtime override would make this test compare a different release with the
  // signed JSON — the one thing the test must not do.
  const savedOverride = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  t.after(() => {
    if (savedOverride !== undefined) process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedOverride;
  });

  const policy = loadApprovedV3Policy();
  const raw = readFileSync(TACTICORE_RELEASE);
  const release = JSON.parse(raw.toString('utf8'));
  const parameters = release.parameters;

  // Identity: the code must be enforcing the release it claims to enforce.
  assert.equal(policy.approved, true, 'the loaded policy must be approved for the account');
  assert.equal(policy.strategy_id, release.strategy.id);
  const expectedVersion = release.strategy.version.startsWith('v')
    ? release.strategy.version : `v${release.strategy.version}`;
  assert.equal(policy.version, expectedVersion);
  assert.equal(policy.content_hash, release.content_hash,
    'the runtime hash must be the signed release content hash, not a locally re-signed one');

  // Every exposed scalar/string field that has a release parameter. The mapping is
  // explicit (not derived from the interface) so a rename cannot silently make a
  // field unasserted.
  const fieldParams = {
    stock_max_positions: 'stock_max_positions',
    stock_max_single_weight_bps: 'stock_max_single_weight_bps',
    stock_risk_budget_bps: 'stock_risk_budget_per_trade_bps',
    l1_warn_drawdown_bps: 'l1_warn_drawdown_bps',
    l2_normal_trigger_drawdown_bps: 'l2_hard_lifeline_drawdown_bps',
    l2_preemptive_deconcentration_trigger_drawdown_bps: 'l2_preemptive_trigger_drawdown_bps',
    l2_deconcentration_post_breaker_equity_bps: 'l2_deconcentration_post_breaker_equity_bps',
    l2_lock_trade_days: 'l2_lock_trade_days',
    deconcentration_keep_weight_bps: 'deconcentration_keep_weight_bps',
    deconcentration_support_breakdown_confirm_days: 'deconcentration_support_breakdown_confirm_days',
    grind_tactical_slot_bps: 'grind_tactical_slot_bps',
    grind_reload_min_discount_bps: 'grind_reload_min_discount_bps',
    grind_reload_rsi14_max: 'grind_reload_rsi14_max',
    grind_reload_bias20_max_bps: 'grind_reload_bias20_max_bps',
    grind_take_profit_bps: 'grind_take_profit_bps',
    grind_drift_harvest_trigger_bps: 'grind_drift_harvest_trigger_bps',
  };
  for (const [field, key] of Object.entries(fieldParams)) {
    assert.equal(policy[field], integerParam(parameters, key),
      `${field} must equal release parameter ${key}`);
  }
  assert.equal(policy.defensive_bond_reservoir_etf, parameters.defensive_bond_reservoir_etf);
  assert.equal(policy.deconcentration_mode, parameters.deconcentration_mode);

  // Execution bounds that have no release parameter are code-defined, not signed
  // policy. They are asserted only as usable numbers, so this test does not invent
  // a release field that the signed JSON does not contain.
  for (const field of ['l2_normal_post_breaker_equity_bps', 'stock_min_order_cny', 'stock_price_cap_cny']) {
    assert.ok(Number.isSafeInteger(policy[field]) && policy[field] > 0,
      `${field} must remain a positive integer execution bound`);
  }

  // The two derived booleans must follow the release, not a stale hard-coded flag.
  assert.equal(policy.bp1_pullback_enabled, parameters.bp1_pullback_status === 'ENABLED');
  assert.equal(policy.bp2_breakout_enabled, parameters.bp2_breakout_status === 'ENABLED');
  assert.equal(policy.bp2_breakout_status, parameters.bp2_breakout_status);

  // The AShareInvestor copy is the human-facing signed artifact; a divergence
  // between the two checked-in copies means one of them was edited without the other.
  if (existsSync(INVESTOR_RELEASE)) {
    assert.ok(readFileSync(INVESTOR_RELEASE).equals(raw),
      `release copies differ byte-for-byte: ${TACTICORE_RELEASE} vs ${INVESTOR_RELEASE}`);
  }
});
