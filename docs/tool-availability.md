# Credential-Scoped MCP Tools

FinanceMCP advertises only tools backed by sources available to the current
MCP request. The same source check runs before `tools/call`, so a client cannot
bypass discovery by submitting a hidden tool name directly.

## Source policy

- `qveris`: tools covered by the Qveris adapter's Discover/Inspect/Probe/Call
  route, including historical prices, indexes, macro data, company data, news,
  and CSI constituents.
- `twingly`: financial news search (`finance_news`, `hot_news_7x24`).
- `binance`: public crypto price tools (`stock_data`, `stock_data_minutes` when `market_type=crypto`).
- `web`: public finance news (`finance_news`).
- `local`: local-only utilities such as `current_timestamp`, plus A-share cache tools (`ashare_*`) under `FINANCE_TOOL_PROFILE`.

When a request carries one or more API credentials, only tools backed by those
credential sources are advertised. Explicit request credentials take priority
over server environment fallbacks, so a shared server-side token does not
expand another tenant's visible tool set.

When no credential is configured, only public and local tools are advertised.
For example:

- Qveris key only: Qveris-covered tools (`finance_news` + 9 market/macro/company/index/news tools).
- Twingly key only: `finance_news`, `hot_news_7x24`.
- Both keys: union of Qveris and Twingly tools.

Adding a new source requires updating its credential resolution in
`src/config.ts`, mapping covered tools in `src/dispatch.ts`, and adding list
and direct-call tests for the new credential combination.
