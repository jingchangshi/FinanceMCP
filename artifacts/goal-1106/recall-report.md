# goal-1106 WP5 — 全市场候选召回审计（V2 技术族）

离线正确性对照，仅用于验证计算是否漏检。**不写入生产库、不建立 Shadow Run、不构成收益或有效性结论。**

- 数据源：生产备份 `ashare.20261105T142010Z.sqlite` 的只读副本 `/tmp/market-copy-20261105.sqlite`（源文件未被写入）。
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
2. **真值（ground truth）**：对每个通过基本门槛（非 ST/退、`adjMissing=0`、≥130 根 K 线、20 日均成交额 ≥0.5 亿、当日有 bar）的股票，直接运行五个确定性检测器 `detectAllPatterns()`；每只股票从首根 bar 读到 as-of（与生产相同的全历史窗口，递归指标不随 as-of 重新播种），同一 `regimeSeries` / `regimeAt`、同一 `computeIndicators`。
3. 比较键：`code | strategy_id | stage`。漏检 = 真值中存在、而生产视图不存在（含 stage 不一致；实际未出现 stage 不一致）。
4. 漏检归因：预筛语义从未命中（`prescreen_semantic_gap`）、perFamily 排名截断（`dropped_by_per_family_cap`）、union 轮转截断（`dropped_by_union_cap`）。审计脚本在本地复刻了预筛条件，仅用于归因；实际视图与真值均由生产代码 `detectAllPatterns` 产出。

`before` 数据在基线构建上采集，`after` 数据在最终修复构建（`technical-v2.1.0`，见验收报告 §4 的实现身份）上采集。两列的家族计数差异同时包含“覆盖股票数”与“检测器语义”两个变化，不能把全量计数直接当作收益或质量比较。

## Before / After 结果

`full` = 真值形态数；`before` = 基线召回；`active miss` = 基线漏掉的 FORMING/CONFIRMED/FOLLOW_THROUGH（当前仍有效的形态）；`after` = 修复后真值数与召回数。

### 20261015（极端下跌日）

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4045 | 465 | 3534 | 532 | 4045 | 0 |
| PLATFORM_BREAKOUT | 3961 | 124 | 676 | 21 | 3961 | 0 |
| REVERSAL | 8078 | 847 | 6052 | 1591 | 8078 | 0 |
| VOLATILITY_EXPANSION | 7977 | 345 | 2309 | 316 | 7977 | 0 |
| MEAN_REVERSION | 4046 | 360 | 2824 | 2068 | 4046 | 0 |

### 20261026（横盘/分化日）

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4103 | 460 | 3596 | 375 | 4103 | 0 |
| PLATFORM_BREAKOUT | 4016 | 132 | 736 | 51 | 4016 | 0 |
| REVERSAL | 8194 | 800 | 6349 | 1951 | 8194 | 0 |
| VOLATILITY_EXPANSION | 8088 | 369 | 2372 | 370 | 8088 | 0 |
| MEAN_REVERSION | 4105 | 383 | 2468 | 1971 | 4105 | 0 |

### 20261029

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4085 | 461 | 3577 | 258 | 4085 | 0 |
| PLATFORM_BREAKOUT | 3997 | 155 | 657 | 20 | 3997 | 0 |
| REVERSAL | 8161 | 811 | 6379 | 2123 | 8161 | 0 |
| VOLATILITY_EXPANSION | 8052 | 386 | 2274 | 278 | 8052 | 0 |
| MEAN_REVERSION | 4087 | 396 | 2550 | 2127 | 4087 | 0 |

### 20261102

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4095 | 470 | 3576 | 233 | 4095 | 0 |
| PLATFORM_BREAKOUT | 4008 | 146 | 654 | 38 | 4008 | 0 |
| REVERSAL | 8185 | 833 | 6380 | 1635 | 8185 | 0 |
| VOLATILITY_EXPANSION | 8071 | 396 | 2279 | 285 | 8071 | 0 |
| MEAN_REVERSION | 4099 | 392 | 2702 | 2426 | 4099 | 0 |

### 20261104

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4126 | 463 | 3614 | 303 | 4126 | 0 |
| PLATFORM_BREAKOUT | 4039 | 145 | 614 | 38 | 4039 | 0 |
| REVERSAL | 8249 | 819 | 6461 | 1741 | 8249 | 0 |
| VOLATILITY_EXPANSION | 8135 | 396 | 2343 | 445 | 8135 | 0 |
| MEAN_REVERSION | 4131 | 385 | 2660 | 2360 | 4131 | 0 |

### 20261105

| family | full | before recalled | before missed | active miss | after recalled | after missed |
|---|---:|---:|---:|---:|---:|---:|
| TREND_CONTINUATION | 4129 | 475 | 3605 | 403 | 4129 | 0 |
| PLATFORM_BREAKOUT | 4038 | 141 | 602 | 53 | 4038 | 0 |
| REVERSAL | 8253 | 809 | 6483 | 1982 | 8253 | 0 |
| VOLATILITY_EXPANSION | 8138 | 402 | 2455 | 588 | 8138 | 0 |
| MEAN_REVERSION | 4134 | 391 | 2728 | 2356 | 4134 | 0 |

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
- 修复后 6 个日期、5 个族全部 100% 召回：`missed_total = 0`，`missed_reason_counts = {}`。

## 运行时与内存

审计进程同时跑了“真值扫描”和“生产路径”，因此 RSS 大于生产单次运行。

| 日期 | 合格股票 | before analyzed | after analyzed | before 生产路径耗时 | after 生产路径耗时 | before maxRSS | after maxRSS | after 视图 JSON（compact） |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 20261015 | 4046 | 482 | 4057 | 11.94s | 79.34s | 301.5 MB | 692.4 MB | 94.36 MB |
| 20261026 | 4105 | 471 | 4114 | 11.61s | 81.17s | 313.4 MB | 741.0 MB | 95.45 MB |
| 20261029 | 4087 | 473 | 4095 | 10.93s | 80.85s | 327.0 MB | 718.6 MB | 95.03 MB |
| 20261102 | 4099 | 481 | 4108 | 10.29s | 81.25s | 345.9 MB | 751.0 MB | 95.25 MB |
| 20261104 | 4131 | 473 | 4139 | 11.11s | 81.78s | 294.3 MB | 746.3 MB | 95.90 MB |
| 20261105 | 4134 | 484 | 4141 | 10.09s | 82.39s | 297.4 MB | 753.8 MB | 95.77 MB |

- 生产路径耗时从约 10–12 秒升到约 79–82 秒/日。主要成本是每只股票从首根 bar 到 as-of 全历史计算递归指标（新增于 WP2 的日期稳定性修复），其次才是 4,100 只股票的五族检测。
- 未引入缓存：`scanMarket` 预筛与 `analyzeTechnicalV2` 各计算一次指标；缓存指标可再省一部分时间，但会把 `IndicatorSet`（约 40 KB/股）常驻内存，峰值内存更高，故未采用。
- **产物体积是本次修复的主要运维代价**：视图 payload 从约 3–5 MB 增至约 94–96 MB（compact JSON），`research_universe` 从约 900 只增至 4,141 只；`technical-preview` 的 pretty JSON 约 161 MB/日。原因是检测器会为几乎每只股票保留历史 FAILED/EXPIRED 实例。如后续收窄失效实例的保留窗口，payload 会同步下降，且不影响本召回结论。
- 生产容器内存上限 3 GiB；单日 preview 进程 maxRSS 实测 1.96–2.04 GB。部署前需按验收报告 §5 复核余量。

## 修复

`src/ashare/technicalCandidatesV2.ts`（WP5 范围）：

1. `PrescreenResult` 新增 `eligible`：所有通过基本门槛（非 ST/退、复权因子完整、≥130 根 K 线、20 日均额 ≥0.5 亿、当日收盘有效）的股票，按 `ts_code` 排序。
2. `analyzeTechnicalV2()` 改为对 `prescreen.eligible`（加 `forcedCodes`，即停牌/一字板股票）全量运行五族确定性检测；perFamily/union 容量不再参与选股。
3. perFamily 列表与 `capacity_limited` 保留为**诊断信息**（观察旧排名的截断量），不改变候选集合；`coverage.preselected` 现在是实际分析的合格股票数。
4. 五族仍各自独立输出，无跨族分数、无打分、无排序改动；确定性保持（集成测试中的重复运行断言仍通过）。
5. 未通过提高 perFamily/union 上限来掩盖问题。检测器语义（WP1–WP3）与全历史播种（WP2 日期稳定性）的修改见验收报告，不在本 WP5 范围内。

## 测试

- `test/technical-v2-recall.test.mjs`（行为不变量）：
  - 合格股票全部进入详析，`analyzed === eligible > union`，旧容量截断量仍可观测；
  - 五族均存在且都有形态，无一族被静默丢弃；
  - 视图召回全部真值形态（逐族计数相等）；
  - 人造市场中确有一部分形态位于旧 union 之外（证明召回差异可测量）；
  - `analyzeTechnicalDay` 生产入口与全量检测一致。
- 更新 `test/technical-v2-integration.test.mjs` 中依赖旧容量上限的断言（`preselected <= 500` → 全量合格股票均被详析）。
- 命令与结果见最终提交说明。
