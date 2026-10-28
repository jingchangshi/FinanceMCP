# Tushare Interface Coverage Status

## Snapshot

- Official Tushare MCP interfaces observed: `258`
- Local registered MCP tools: `19`
- Official interfaces currently covered: `91`
- Official interfaces not yet covered: `167`
- Coverage ratio: `35.27%`

This file is the **safe, committed coverage snapshot** for the repo. It should be updated after every interface-expansion batch.

The local-only artifacts under `reports/` may contain richer extraction detail and temporary analysis, but they are not the canonical committed status because that directory is intentionally excluded from pushes.

## Current Public Tool Surface

| Tool | Role | Notes |
|---|---|---|
| `current_timestamp` | local utility | no upstream data source |
| `finance_news` | external news search | Baidu crawler, not Tushare |
| `stock_data` | multi-market historical bars | Tushare + Binance |
| `stock_data_minutes` | minute bars | Tushare + Binance |
| `index_data` | index daily/weekly/monthly/global/basic/valuation | Tushare aggregate |
| `macro_econ` | macro indicators | Tushare aggregate |
| `company_performance` | company financial and market snapshot data | Tushare aggregate |
| `fund_data` | fund, ETF-adjacent, company, sales, and factor data | Tushare aggregate |
| `fund_manager_by_name` | manager lookup | Tushare aggregate |
| `convertible_bond` | convertible bond lifecycle, rating, coupon, and holder data | Tushare aggregate |
| `block_trade` | block trade data | Tushare aggregate |
| `money_flow` | stock/market/sector/northbound/connect/THS flows | Tushare aggregate |
| `margin_trade` | margin and securities lending | Tushare aggregate |
| `company_performance_hk` | HK financial statements | Tushare aggregate |
| `company_performance_us` | US financial statements | Tushare aggregate |
| `csi_index_constituents` | CSI constituents + valuation/quality summary | multi-call aggregate |
| `dragon_tiger_inst` | institution activity on dragon-tiger list | Tushare aggregate |
| `hot_news_7x24` | fast news | Tushare `news` |
| `futures_data` | futures positioning | Tushare aggregate |

## Official Interfaces Currently Covered

`adj_factor`, `balancesheet`, `block_trade`, `cashflow`, `cb_basic`, `cb_call`, `cb_daily`, `cb_issue`, `cb_rate`, `cb_rating`, `cb_share`, `cn_cpi`, `cn_gdp`, `cn_m`, `cn_pmi`, `cn_ppi`, `daily`, `daily_basic`, `dividend`, `express`, `fina_audit`, `fina_indicator`, `fina_mainbz`, `forecast`, `fund_adj`, `fund_basic`, `fund_company`, `fund_daily`, `fund_div`, `fund_factor_pro`, `fund_manager`, `fund_nav`, `fund_portfolio`, `fund_sales_vol`, `fund_share`, `fut_daily`, `fut_holding`, `fx_daily`, `hibor`, `hk_balancesheet`, `hk_cashflow`, `hk_daily`, `hk_hold`, `hk_income`, `hsgt_top10`, `income`, `index_basic`, `index_daily`, `index_dailybasic`, `index_global`, `index_monthly`, `index_weekly`, `index_weight`, `libor`, `margin`, `margin_detail`, `margin_secs`, `moneyflow`, `moneyflow_cnt_ths`, `moneyflow_hsgt`, `moneyflow_ind_dc`, `moneyflow_mkt_dc`, `moneyflow_ths`, `monthly`, `new_share`, `news`, `opt_daily`, `pledge_detail`, `pledge_stat`, `repo_daily`, `repurchase`, `share_float`, `shibor`, `shibor_quote`, `slb_len_mm`, `stk_holdernumber`, `stk_holdertrade`, `stk_managers`, `stk_mins`, `stock_basic`, `stock_company`, `top10_cb_holders`, `top10_floatholders`, `top10_holders`, `top_inst`, `us_balancesheet`, `us_cashflow`, `us_daily`, `us_fina_indicator`, `us_income`, `weekly`

## Recent Expansion History

### V1

Added or newly exposed through the public aggregate surface:

- `weekly`
- `monthly`
- `index_basic`
- `daily_basic` as explicit `company_performance` branch
- `stock_basic` as explicit `company_performance` branch (`stk_basic`)

Architecture work completed:

- shared `dispatch.ts`
- shared `timestampTool.ts`
- HTTP/stdio parity fix for `money_flow`

### V2

Added or newly exposed through the public aggregate surface:

- `index_dailybasic`
- `hk_hold`
- `hsgt_top10`
- `cb_call`
- `cb_share`
- `new_share`
- `fut_holding`

Architecture work completed:

- shared `tushareClient.ts` for V2 codepaths
- `index_data` table-oriented daily/valuation output
- schema cleanup for `money_flow` and `company_performance`
- new high-level tool `futures_data`

### V3

Added or newly exposed through the public aggregate surface:

- `index_weekly`
- `index_monthly`
- `index_global`
- `moneyflow_hsgt`
- `moneyflow_ths`
- `moneyflow_cnt_ths`
- `cb_rate`
- `cb_rating`
- `top10_cb_holders`
- `fund_company`
- `fund_adj`
- `fund_sales_vol`
- `fund_factor_pro`

Architecture work completed:

- preserved the V1/V2 shared dispatcher path for stdio and HTTP
- kept new coverage inside existing aggregate tools instead of adding endpoint-shaped public tools
- refreshed the local `reports/tushare-mcp` coverage artifacts through `scripts/generate_tushare_coverage_report.js`

### Goal-1028（2026-10-28，研究层消费，非公开工具面扩张）

本轮热点行业 × 多策略研究系统（AShareInvestor `hotspot-sync`）在**服务端研究层**
消费了下列接口。这些接口**未**加入公开聚合工具面（`Current Public Tool Surface`
与 Snapshot 覆盖数字**不变**——覆盖数只计公开暴露的接口），但数据能力与
PIT（点时）语义已实测，如实记录如下。

**真实联网同步实测（2026-10-28，goal-1028 `hotspot-sync`）**：

| 接口 | 实测行数 | 说明 |
|---|---|---|
| `sw_classify` | 511 | 申万 2021 L1/L2/L3 分类目录 |
| `sw_member` | 5,922 | 全市场成分，`index_member_all` 一次取全 |
| `sw_index_daily` | 8,091 | 申万指数日线 |
| `ths_index` | 2,159 | 同花顺概念/行业/事件/风格目录 |
| `ths_member` | 41,845 | 同花顺成分（无时点，见下） |
| `ths_index_daily` | 6,816 | 同花顺指数日线 |

以上为**真实拉取数据**，非估算。ETF 权重采集同步实测：9 只行业主题 ETF →
`etf_weight_snapshot` **480 行**（1 只来自 `index_weight` + 8 只来自
`fund_portfolio`），真实写入。

**接口 PIT / 可得性发现**：

| 接口 | 角色 | PIT / 可得性 | 发现 |
|---|---|---|---|
| `index_member_all` | 申万全量成分一次取全 | **PARTIAL PIT** | 上游 `out_date` 全为 NULL、`is_new` 恒为 `'Y'`——只有"在册"成分，无调出历史。列照存，等上游填；不伪造调出日期 |
| `ths_member` | 同花顺成分 | **NO_POINT_IN_TIME** | 上游**无任何时间字段**。禁止用它回填历史（回填只会伪造时点）；仅当日主题标注可用。`hotspotPool` 仅在 `collected_at <= as_of` 守卫下使用——同步当日可用，历史回放诚实降级为"无 THS 龙头可选" |
| `ths_daily` | 同花顺指数日线 | 正常日线，**缺 amount** | 字段列表**无 `amount`**（实测字段：`ts_code,trade_date,open,high,low,close,pre_close,avg_price,change,pct_change,vol,turnover_rate`）→ `amount_trend` 因子对 THS 来源板块**诚实不可得**：`SELECT NULL AS amount`，权重在可用因子上重归一化。对比 `sw_daily` **有** amount |
| `fund_portfolio` | 基金季度/半年持仓 | 可得性 = `ann_date` | 天然滞后报告期末；`ann_date` 为 null 的行在写入时被**拒绝**（不伪造时点）。披露滞后是上游事实，非采集失败 |
| `index_weight` | 指数月度权重 | 可得性 = `trade_date`（权重日） | 权重日即发布可得日；用于行业 ETF（如中证指数月度权重） |
| `etf_sh_cons` / `etf_sz_cons` | ETF 申赎篮子 | 不适用 | 申赎篮子 `qty` **≠** 投资权重，**永不**进入 `etf_weight_snapshot`；`basketNotWeightGuard` 无条件拦截 |
| `index_classify` | 指数分类目录 | **PENDING / 待验证** | L3 覆盖度需真实同步确认 L3 行数——goal-1028 **未**实测该接口，不宣称覆盖 |

Architecture work completed:

- 新增服务端研究层同步入口 `hotspot-sync`（申万 + 同花顺目录/成分/日线），**不**接入 daily 管道、**不**计入公开工具面
- `ths_member` / `index_member_all` / `ths_daily` 的 PIT 限制在 `data-contracts.md` 与 `tushare-interface-coverage.md` 同步如实登记

## Highest-Priority Remaining Families

These are the best next expansion areas under the current architecture style:

1. `market_reference`
   Current likely next candidates: `trade_cal`, `hs_const`, `hk_basic`, `us_basic`, `hk_tradecal`, `us_tradecal`

2. `theme_board_data`
   Current likely next candidates: `concept`, `concept_detail`, `ths_index`, `ths_member`, `ths_daily`, `ths_hot`, `dc_index`, `dc_member`, `dc_daily`, `dc_hot`

3. `market_state`
   Current likely next candidates: `suspend`, `suspend_d`, `stk_limit`, `limit_list`, `limit_list_d`, `limit_step`, `stk_auction`, `stk_premarket`

4. `stock_data` / `stock_data_minutes`
   Current likely next candidates: `us_daily_adj`, `hk_daily_adj`, `stk_week_month_adj`, `rt_min`, `rt_min_daily`, `hk_mins`, `opt_mins`, `ft_mins`

5. Existing specialist tools
   Current likely next candidates: `cb_price_chg`, `yc_cb`, `cb_factor_pro`, `fut_basic`, `fut_settle`, `fut_wsr`, `margin_target`, `slb_len`, `slb_sec`, `slb_sec_detail`

## Update Rule

After each accepted batch:

1. update this file
2. update the local-only `reports/` snapshot if you generated one
3. verify cloud and local repo copies are aligned
4. keep the numbers in this file honest
