// goal-1030 WP6.3 / goal-1102: the schema-compatibility promise, mechanised.
//
// Adding a research state must not change what a client already sends. Before
// this file nothing asserted that: an edit that made `research_state` required
// would have passed every other test while breaking every existing caller. The
// table below is the frozen `inputSchema.required` of every exposed tool;
// changing an entry here is a breaking change and must be reviewed as one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ashareToolDefinitions, portfolioToolDefinitions } from '../build/ashare/definitions.js';

const FROZEN_REQUIRED = {
  // public (anon /mcp): 14 read-only market tools
  ashare_data_status: undefined,
  ashare_daily_report: undefined,
  ashare_watchlist: undefined,
  ashare_stock_analysis: ['ts_code'],
  ashare_sector_rank: undefined,
  ashare_factor_snapshot: ['ts_codes'],
  ashare_stock_history: ['ts_code'],
  ashare_financial_data: ['ts_code'],
  ashare_market_data: undefined,
  ashare_stock_basic: undefined,
  ashare_etf_quotes: undefined,
  ashare_etf_status: undefined,
  ashare_hotspot_sectors: undefined,
  ashare_hotspot_opportunities: undefined,
  // private (/private/mcp, OAuth): 12 account + research tools
  ashare_investment_research_bundle: undefined,
  ashare_portfolio_summary: undefined,
  ashare_portfolio_scenario: ['action'],
  ashare_portfolio_decision: ['action'],
  ashare_portfolio_daily_report: [],
  ashare_etf_candidates: [],
  ashare_portfolio_benchmarks: [],
  ashare_chatgpt_research_record_append: ['report_id', 'as_of_trade_date', 'independent_judgement', 'final_conclusion'],
  ashare_research_thesis_append: ['parent_record_id', 'target', 'direction', 'horizon', 'baseline_assessment'],
  ashare_research_eval: undefined,
  ashare_research_snapshot_get: undefined,
  ashare_research_combined_append: ['as_of_trade_date'],
};

const all = [...ashareToolDefinitions, ...portfolioToolDefinitions];

test('the required inputs of every exposed tool are frozen (additive changes only)', () => {
  assert.deepEqual(all.map(t => t.name).sort(), Object.keys(FROZEN_REQUIRED).sort(),
    'the exposed tool set itself is part of the promise');
  for (const tool of all) {
    assert.deepEqual(tool.inputSchema.required, FROZEN_REQUIRED[tool.name],
      `${tool.name}: required inputs changed — an older client would start failing`);
  }
});

test('the hotspot research filter is optional on the wire and keeps its V2 meaning', () => {
  const tool = ashareToolDefinitions.find(t => t.name === 'ashare_hotspot_opportunities');
  const props = tool.inputSchema.properties;
  for (const name of ['date', 'ts_code', 'research_state']) {
    assert.ok(name in props, `${name} must be advertised`);
    assert.ok(!(tool.inputSchema.required ?? []).includes(name),
      `${name} must stay optional: it narrows a read, it is not a new obligation`);
  }
  assert.deepEqual(props.research_state.enum,
    ['FOCUS', 'WATCH', 'EXTENDED', 'DETERIORATING', 'BLOCKED', 'INVALIDATED'],
    'the filter names the six research states; there is no pool or candidate_class vocabulary');
  // The deleted V1 filters must not come back as a compatibility alias.
  for (const gone of ['pool', 'entry_eligible', 'candidate_class']) {
    assert.equal(gone in props, false, `${gone} belongs to the removed V1 entry layer`);
  }
});

test('every public tool is still read-only and none of them touches the account database', () => {
  for (const tool of ashareToolDefinitions) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must stay read-only`);
    assert.equal(tool.securitySchemes, undefined, `${tool.name} must not require OAuth`);
  }
  // Private tools declare their scope; the write tools are the append-only ones.
  const writers = portfolioToolDefinitions.filter(t => t.annotations.readOnlyHint !== true).map(t => t.name).sort();
  assert.deepEqual(writers, [
    'ashare_chatgpt_research_record_append', 'ashare_research_combined_append', 'ashare_research_thesis_append',
  ], 'only research records may be appended; no portfolio or order write tool exists');
});
