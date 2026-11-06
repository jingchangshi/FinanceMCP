# goal-1106 WP5 — 全市场候选召回审计（V2 技术族）

离线正确性对照，仅用于验证计算是否漏检。**不写入生产库、不建立 Shadow Run、不构成收益或有效性结论。**

- 数据源：`/home/jcshi/.local/share/ashare-v1/backups/ashare.20261105T142010Z.sqlite`（只读打开）
- 审计脚本：`scripts/goal-1106-recall-audit.mjs`
- 原始结果：`artifacts/goal-1106/recall-{before,after}-<date>.json`
- 审计日期（6 个交易日）：

| 日期 | 市场截面（全 A 股） | 沪深300 当日 | 选取理由 |
|---|---|---|---|
| 20261015 | 上涨占比 7.7%，均值 -2.85% | -1.23% | 极端下跌日（广度最差） |
| 20261026 | 上涨占比 40.4%，均值 -0.62% | -0.04% | 横盘/分化日 |
| 20261029 | 上涨占比 14.0%，均值 -2.65% | -1.03% | 指定日，下跌日 |
| 20261102 | 上涨占比 84.0%，均值 +2.40% | +0.79% | 指定日，普涨日 |
| 20261104 | 上涨占比 83.8%，均值 +2.83% | +2.31% | 指定日，普涨日 |
| 20261105 | 上涨占比 87.4%，均值 +2.30% | +0.29% | 指定日，普涨日 |

`src/ashare/market.ts` 的 60 日 regime 标签在上述窗口内均为 `downtrend`，因此“不同市场环境”按**当日横截面广度**区分：20261015（极端下跌）对 20261026（横盘/分化），并覆盖指定日。该区分会影响 `MEAN_REVERSION` 的 `backgroundDown` 分支判断，属于真实的检测器输入差异。

## 方法

1. **基线（before）**：HEAD `451d4f3` 的生产发现路径——`createTechnicalPrescreen()`（perFamily=120、union=500）→ `analyzeTechnicalV2()`，与 `analyzeTechnicalDay` 完全一致。
2. **真值（ground truth）**：对每个通过基本门槛（非 ST/退、`adjMissing=0`、≥130 根 K 线、20 日均成交额 ≥0.5 亿、当日有 bar）的股票，直接运行五个确定性检测器 `detectAllPatterns()`；同一 330 交易日窗口、同一 `regimeSeries`、同一 `computeIndicators`。
3. 比较键：`code | strategy_id | stage`。漏检 = 真值中存在、而生产视图不存在（含 stage 不一致；实际未出现 stage 不一致）。
4. 漏检归因：预筛语义从未命中（`prescreen_semantic_gap`）、perFamily 排名截断（`dropped_by_per_family_cap`）、union 轮转截断（`dropped_by_union_cap`）。审计脚本在本地复刻了预筛条件，仅用于归因；实际视图与真值均由生产代码 `detectAllPatterns` 产出。

## Before / After 结果

`full` = 真值形态数；`before` = 基线召回；`active miss` = 基线漏掉的 FORMING/CONFIRMED/FOLLOW_THROUGH（当前仍有效的形态）；`after` = 修复后召回。

### 20261015（极端下跌日）

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 3999 | 465 | 3534 | 532 | 3999 | 0 |
| PLATFORM_BREAKOUT | 800 | 124 | 676 | 21 | 800 | 0 |
| REVERSAL | 6899 | 847 | 6052 | 1591 | 6899 | 0 |
| VOLATILITY_EXPANSION | 2654 | 345 | 2309 | 316 | 2654 | 0 |
| MEAN_REVERSION | 3184 | 360 | 2824 | 2068 | 3184 | 0 |

### 20261026（横盘/分化日）

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4056 | 460 | 3596 | 375 | 4056 | 0 |
| PLATFORM_BREAKOUT | 868 | 132 | 736 | 51 | 868 | 0 |
| REVERSAL | 7149 | 800 | 6349 | 1951 | 7149 | 0 |
| VOLATILITY_EXPANSION | 2741 | 369 | 2372 | 370 | 2741 | 0 |
| MEAN_REVERSION | 2851 | 383 | 2468 | 1971 | 2851 | 0 |

### 20261029

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4038 | 461 | 3577 | 258 | 4038 | 0 |
| PLATFORM_BREAKOUT | 812 | 155 | 657 | 20 | 812 | 0 |
| REVERSAL | 7190 | 811 | 6379 | 2123 | 7190 | 0 |
| VOLATILITY_EXPANSION | 2660 | 386 | 2274 | 278 | 2660 | 0 |
| MEAN_REVERSION | 2946 | 396 | 2550 | 2127 | 2946 | 0 |

### 20261102

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4046 | 470 | 3576 | 233 | 4046 | 0 |
| PLATFORM_BREAKOUT | 800 | 146 | 654 | 38 | 800 | 0 |
| REVERSAL | 7213 | 833 | 6380 | 1635 | 7213 | 0 |
| VOLATILITY_EXPANSION | 2675 | 396 | 2279 | 285 | 2675 | 0 |
| MEAN_REVERSION | 3094 | 392 | 2702 | 2426 | 3094 | 0 |

### 20261104

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4077 | 463 | 3614 | 303 | 4077 | 0 |
| PLATFORM_BREAKOUT | 759 | 145 | 614 | 38 | 759 | 0 |
| REVERSAL | 7280 | 819 | 6461 | 1741 | 7280 | 0 |
| VOLATILITY_EXPANSION | 2739 | 396 | 2343 | 445 | 2739 | 0 |
| MEAN_REVERSION | 3045 | 385 | 2660 | 2360 | 3045 | 0 |

### 20261105

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4080 | 475 | 3605 | 403 | 4080 | 0 |
| PLATFORM_BREAKOUT | 743 | 141 | 602 | 53 | 743 | 0 |
| REVERSAL | 7292 | 809 | 6483 | 1982 | 7292 | 0 |
| VOLATILITY_EXPANSION | 2857 | 402 | 2455 | 588 | 2857 | 0 |
| MEAN_REVERSION | 3119 | 391 | 2728 | 2356 | 3119 | 0 |

### 漏检数量与归因（before）

| 日期 | 漏检形态总数 | 其中 active | 漏检唯一股票 | dropped_by_per_family_cap | dropped_by_union_cap | prescreen_semantic_gap |
|---|---:|---:|---:|---:|---:|---:|
| 20261015 | 15395 | 4528 | 3575 | 3573 | 0 | 2 |
| 20261026 | 15521 | 4718 | 3643 | 3642 | 0 | 1 |
| 20261029 | 15437 | 4806 | 3622 | 3620 | 0 | 2 |
| 20261102 | 15591 | 4617 | 3627 | 3623 | 0 | 4 |
| 20261104 | 15692 | 4887 | 3666 | 3662 | 0 | 4 |
| 20261105 | 15873 | 5382 | 3657 | 3651 | 0 | 6 |

结论：

- 漏检主体是**perFamily=120 排名截断**，而非 union=500 轮转；每只被漏掉的股票都至少真实命中了某一族的形态定义。
- 另有 1–6 只股票完全不命中预筛代理条件（语义缺口），说明“预筛条件比检测器更宽”的假设并不成立；仅提高容量上限不能修复这类漏检。
- 修复后 6 个日期、5 个族全部 100% 召回。

## 运行时与内存

审计进程同时跑了“真值扫描”和“生产路径”，因此 RSS 大于生产单次运行。

| 日期 | 合格股票 | before analyzed | after analyzed | before 生产路径耗时 | after 生产路径耗时 | before maxRSS | after maxRSS | after 视图 JSON |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 20261015 | 4046 | 482 | 4057 | 11.94s | 18.64s | 301.5 MB | 479.3 MB | 35.29 MB |
| 20261026 | 4105 | 471 | 4114 | 11.61s | 19.15s | 313.4 MB | 498.8 MB | 35.54 MB |
| 20261029 | 4087 | 473 | 4095 | 10.93s | 18.69s | 327.0 MB | 505.2 MB | 35.43 MB |
| 20261102 | 4099 | 481 | 4108 | 10.29s | 18.70s | 345.9 MB | 516.3 MB | 35.70 MB |
| 20261104 | 4131 | 473 | 4139 | 11.11s | 19.97s | 294.3 MB | 497.2 MB | 35.86 MB |
| 20261105 | 4134 | 484 | 4141 | 10.09s | 19.58s | 297.4 MB | 484.1 MB | 36.14 MB |

- 生产路径耗时增量约 +8 秒/日（+70%），来自 4,100 只股票而非 ~480 只的指标与五族检测。
- 未引入缓存：`scanMarket` 预筛与 `analyzeTechnicalV2` 各计算一次指标；缓存指标可再省约 4–6 秒，但会把 `IndicatorSet`（约 40 KB/股）常驻内存，峰值内存更高，故未采用。可后续按需优化。
- **产物体积是本次修复的主要运维代价**：视图 payload 从约 3–5 MB 增至约 36 MB，`research_universe` 从约 900 只增至 4,141 只。原因是检测器会为几乎每只股票保留历史 FAILED/EXPIRED 实例。该阶段语义属于核心检测器（WP1/WP3），本工作包未修改；如后续收窄失效实例的保留窗口，payload 会同步下降，且不影响本召回结论。

## 修复

`src/ashare/technicalCandidatesV2.ts`：

1. `PrescreenResult` 新增 `eligible`：所有通过基本门槛（非 ST/退、复权因子完整、≥130 根 K 线、20 日均额 ≥0.5 亿、当日收盘有效）的股票，按 `ts_code` 排序。
2. `analyzeTechnicalV2()` 改为对 `prescreen.eligible`（加 `forcedCodes`，即停牌/一字板股票）全量运行五族确定性检测；perFamily/union 容量不再参与选股。
3. perFamily 列表与 `capacity_limited` 保留为**诊断信息**（观察旧排名的截断量），不改变候选集合；`coverage.preselected` 现在是实际分析的合格股票数。
4. 五族仍各自独立输出，无跨族分数、无打分、无排序改动；代码顺序、输入窗口、指标与检测器完全不变，确定性保持（集成测试中的重复运行断言仍通过）。
5. 未通过提高 perFamily/union 上限来掩盖问题；未修改 `patterns.ts` / `technicalPatternsV2.ts` / `technicalFrameworkV2.ts` / 研究状态 / bundle / 部署文件。

## 测试

- 新增 `test/technical-v2-recall.test.mjs`（5 个行为测试）：
  - 合格股票全部进入详析，`analyzed === eligible > union`，旧容量截断量仍可观测；
  - 五族均存在且都有形态，无一族被静默丢弃；
  - 视图召回全部真值形态（逐族计数相等）；
  - 人造市场中确有一部分形态位于旧 union 之外（证明召回差异可测量）；
  - `analyzeTechnicalDay` 生产入口与全量检测一致。
- 更新 `test/technical-v2-integration.test.mjs` 中依赖旧容量上限的断言（`preselected <= 500` → 全量合格股票均被详析）。

命令与结果见最终提交说明。
