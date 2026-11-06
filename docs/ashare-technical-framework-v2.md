# A 股技术分析方法论 V2

本文描述 `technical-v2.1.0` 的研究口径（2026-11-06 修复版；`technical-v2.0.0` 的形态因果、过期时间与聚合规则已被本版取代，两者结果不可直接合并比较）。实现契约集中在 `src/ashare/technicalFrameworkV2.ts`；A–E 五类策略独立产生研究候选，F 是每只股票只陈述一次的共享价格行为与交易状态解释层。全部输出仅为研究材料，`evidence_level` 只有 `UNVERIFIED` 一个起始值，本文不构成交易建议。

## 1. 目标与边界

- **研究而非交易系统。** V2 不输出仓位、下单数量、目标价或收益预测，也不生成订单。`research_ready` 只表示“可以进入进一步研究清单”，不是买入指令。
- **不宣称优势。** 第一版阈值是启发式研究假设，未经参数搜索、机器学习或充分样本验证；没有任何统计优势声明。
- **V1 原样保留。** 既有 `entry_view`、`entry_score`、`research_top10`、`entry_hash`、历史快照和已生成研究结果都不因 V2 改写。V2 新增独立字段 `technical_view_v2`，不复用 V1 的入场排序身份。
- **不做跨策略总分。** 五类策略各自按价格行为定义阶段，不合并成统一 100 分、胜率或“最佳策略”。同一股票可以同时出现在多个策略族，但共享量价上下文只记录一次。
- **先语义、后统计。** 当前交付重点是形态定义、阶段可证时机、可解释依据和全市场发现能力；精确统计证据留给第 7 节的独立观察。

## 2. 六个方法模块

五个策略族的固定 id 为 `TREND_CONTINUATION`、`PLATFORM_BREAKOUT`、`REVERSAL`、`VOLATILITY_EXPANSION`、`MEAN_REVERSION`；第六个模块 `PRICE_VOLUME_CONTEXT` 不单独产生候选。各模块复用 `indicators.ts` 的均线、MACD、RSI、BOLL、ATR、量能及 `patterns.ts` 的无未来函数形态检测。以下各节的“关键阈值”均标为研究假设；它们写在被实现指纹覆盖的源码中，改动阈值即改变 `implementation_fingerprint`，便于识别口径变化。

### 2.1 A｜趋势延续 `TREND_CONTINUATION`

- **形态定义。** 只认一个可解释事件：上升趋势中的回踩（收盘连续 ≤ MA20，最多 5 根）及其后的**收盘收复 MA20**。趋势背景必须在回踩点已经存在（MA20 > MA60 且 MA20 相对 5 个交易日前抬升），不能由确认当日才形成的均线排列冒充。均线多头排列本身不产生候选。
- **数据输入。** 前复权日线、MA20/MA60、MA20 斜率、MACD 状态、RPS120。RPS120 只作为相对强度背景，不是独立胜率，也不是 V2 的硬门控。
- **阶段语义。** `FORMING`：回踩进行中（当日收盘 ≤ MA20，low 触及 MA20，回踩点趋势背景成立），尚未收复，**该分支必须可达**；`CONFIRMED`：前一日收盘 ≤ MA20、当日收盘 > MA20 且高于前一日收盘（真正的“重新站上”）；`FOLLOW_THROUGH`：确认后 10 根 K 线内未跌破 MA60 且未过期；`FAILED`：确认后收盘跌破 MA60；`EXPIRED`：确认后第 11 根 K 线仍未失效。
- **关键阈值（研究假设）。** MA20/MA60 为趋势骨架；MA20 相对 5 个交易日前抬升；收盘回踩最多 5 根；low 触及 MA20 的容差为上方 1%（沿用 `DEFAULT_PULLBACK_OPTS`）；RPS120 可记录 V1 常用值 80 作为背景描述，但不据此否决低 RPS 候选。阈值是假设，不是已验证参数。
- **时间字段。** `pattern_event_date = formed_on = 回踩日`，`confirmed_on = 收复日`；同一轮上涨只会在“前一日仍 ≤ MA20”的首次收复确认一次。
- **与 V1 的区别。** V1 的 `tc_rps_hold` 把 RPS120 ≥ 80 当作触发条件，且多条趋势策略由同一组 `trend_up` 边沿驱动；V2 不再让 RPS 决定趋势候选资格，并把“回踩接触”和“收复确认”拆成可解释的前后阶段，避免把均线排列本身当作入场证据。

### 2.2 B｜平台整理与突破 `PLATFORM_BREAKOUT`

- **形态定义。** 先有可识别的横向整理（价格区间收敛、波动收缩、持续时间足够），再有收盘突破整理区关键高点；必须与“连续急涨后创 20/60 日新高”区分。20/60 日创新高只是事实，不是充分条件。
- **数据输入。** 前复权日线、20/60 日滚动高低点、整理区间宽度、ATR 或 BOLL 带宽的收缩程度、成交量与 20 日均量。
- **阶段语义。** `FORMING`（明细标签如 `PLATFORM_FORMING`）：整理成立、价格接近区间上沿但未突破；`CONFIRMED`（如 `BREAKOUT_CONFIRMED`）：收盘突破关键高点并满足量能确认；`FOLLOW_THROUGH`：突破后守住关键位或继续扩张；`FAILED`：收盘跌回突破参考位下方并持续；`EXPIRED`：观察窗内未突破也未失效。确认日必须是首次可证突破日，不能回溯到整理起点。
- **关键阈值（研究假设）。** 平台窗口为 30 个交易日（不含当日），振幅 ≤15%；近 10 日收盘离散度 ≤ 前 20 日的 0.8 倍；突破前 20 日涨幅 ≤25% 且 ATR14/收盘 ≤6%，用于排除连续急涨；突破要求收盘高于平台高点且成交量 ≥1.2 倍 MA20 均量。形成中定义为收盘位于平台高点下方 3% 以内。这些是预先写死在源码中的研究假设，不是按结果优化的参数。
- **与 V1 的区别。** V1 `bo_range` 只是“收盘突破前 60 日最高价且成交量 ≥ 1.2 倍均量”，没有整理持续时间与波动收缩判据，因此不等于平台突破。V2 不把 `bo_range` 改个名字当成新算法，而是显式要求“先整理、后突破”，并保留 `bo_range` 作为旧版对照。

### 2.3 C｜底部背离与反转 `REVERSAL`

- **形态定义。** 主模式是 MACD DIF 底背离：两个已确认的局部价格低点，第二个价格低点更低，而对应的 DIF 低点更高；背离本身只说明动能修复，不等于反转。出现价格收复短期关键位或局部颈线后，才标记反转确认。DIF W 底保留为另一种模式；MACD 金叉单独出现不构成充分反转证据。RSI 底背离可作为辅助观察，第一版不要求实现全部振荡指标。
- **数据输入。** 前复权日线、MACD(12,26,9) 的 DIF、局部摆动低点、短期均线或颈线、RSI14（辅助）。
- **阶段语义。** `FORMING`：两个低点及 DIF 抬高关系已可确认，但价格尚未收复关键位；`CONFIRMED`：首次收盘收复短期关键位或颈线；`FOLLOW_THROUGH`：确认后未跌回失效线且结构保持；`FAILED`：价格跌破两个低点中的较低者或背离结构被破坏；`EXPIRED`：观察窗结束。
- **因果顺序。** 同一实例内，失效与确认都只在形成后的 40 根窗口内搜索，**先发生者决定实例**：失效先于确认 → 实例立即 `FAILED`，`confirmed_on` 必须为 `null`，之后永不补写确认；确认后失效 → `FAILED` 保留 `confirmed_on`，且 `invalidated_at >= confirmed_on`。后续重新形成的结构是新实例，不能复活旧实例。`expires_at` 记录窗口第一次走完的交易日，不随 as-of 推进改变。
- **关键阈值（研究假设）。** 局部摆动低点采用左右各 3 根 K 线（L=3/K=3）；两个低点间隔 8–60 个交易日；第二个价格低点更低、对应 DIF 低点更高，且第二个 DIF 低点仍低于零轴；颈线取两个低点之间的最高价；形成时点为第二个低点右侧 3 根 K 线可确认之时，确认要求收盘越过颈线；形成或确认后 40 根 K 线未延续则过期。所有数值是研究假设，目的是固定语义，不是拟合结果。
- **与 V1 的区别。** V1 的 `macd_bull_divergence` 在“近 10 日低点低于 20–60 日前的低点且 DIF 更高”的同一根 K 线上要求收阳并站上 MA5，形成与确认被压成一个边沿信号；V2 先输出背离形成，再等待价格确认，避免把“指标背离”直接当作“反转已发生”。同时保留 DIF W 底，不把金叉当替代品。

### 2.4 D｜波动率收缩与扩张 `VOLATILITY_EXPANSION`

- **形态定义。** 两类过程：①布林带宽处于自身较低分位（收口）后，价格向上突破上轨；②已形成上升趋势时，价格沿布林上轨运行，回踩后延续。收口本身不是向上突破，触上轨也不是独立卖出信号，二者不能混为同一个信号。
- **数据输入。** 前复权日线、BOLL(20,2) 的上/中/下轨与带宽、带宽历史分位、ATR、成交量。
- **阶段语义。** `FORMING`：带宽收缩、价格尚未突破；`CONFIRMED`：收盘突破上轨且满足量能/扩张确认；`FOLLOW_THROUGH`：沿上轨运行或回踩后延续；`FAILED`：收盘跌回中轨下方或收缩结构失效；`EXPIRED`：观察窗结束。
- **关键阈值（研究假设）。** BOLL(20,2)；带宽 ≤ 前 120 根（至少 100 个有效值）的第 20 百分位视为收口；确认要求收盘上穿上轨、前一日收盘不高于上轨，且最近 5 根内出现过收口；失效参考为中轨；“沿上轨运行”要求上升趋势背景、最近 5 根中至少 3 根收盘触及/站上上轨且带宽高于 120 根中位数。ATR 与量能只作确认背景。阈值是假设，收缩分位和窗口不得按观察结果反复调整。
- **与 V1 的区别。** V1 已有一个“收口后上穿上轨”的边沿信号，但没有把“收缩—突破—扩张—失败”拆开，也容易把触上轨误读为反转或卖点。V2 显式区分三种可解释形态：收口后突破、沿上轨趋势延续、震荡下轨再入带内。

### 2.5 E｜震荡中的超跌均值回归 `MEAN_REVERSION`

- **形态定义。** 横盘震荡环境中的超跌修复：价格触及 BOLL 下轨或 RSI14 进入超卖区，随后重新进入布林带、收复短期参考位并出现止跌回升。持续下跌环境只输出逆势观察，不把“超卖”自动解释为低风险机会。
- **数据输入。** 前复权日线、RSI14、BOLL(20,2) 下轨与中轨、价格偏离程度、短期止跌 K 线、成交量背景。
- **阶段语义。** `FORMING`：碰到下轨或 RSI14 < 30 的观察状态，尚无回升确认；`CONFIRMED`：价格重新进入布林带并收复短期参考位；`FOLLOW_THROUGH`：确认后未再创新低且回到中轨附近或以上；`FAILED`：收盘创出新的阶段低点或跌回下轨下方并钝化；`EXPIRED`：观察窗结束。
- **关键阈值（研究假设）。** 超卖观察为收盘 ≤ 布林下轨 ×1.01 或 RSI14 <30；确认要求最近 5 根内出现过该观察，且当日收盘高于下轨、高于前一日收盘、RSI14 不低于前一日；确认后 10 根 K 线内未跌破超卖区低点则延续，跌破即失效。MA20 下行且收盘低于 MA60 被视为持续下跌环境，只输出 `OVERSOLD_IN_DOWNTREND` 逆势观察，不确认。以上均为研究假设。
- **与 V1 的区别。** V1 的 `rsi_oversold_rebound` 只要求 RSI14 由 30 下方上穿 30，属于单根 K 线的边沿信号；V2 把“触轨/超卖观察”和“重新进带/价格回升确认”分开，并要求区分震荡与下跌环境，降低在弱势下跌中把钝化超卖当成机会的风险。

### 2.6 F｜横向量价与交易行为 `PRICE_VOLUME_CONTEXT`

- **定位。** 这是五类策略共用的解释层，不是第六类候选生成器。每只股票只生成一条 `PriceVolumeContext`，无论它被多少个策略族列出；共享信息不按策略族重复陈述。
- **标签。** `VOLUME_EXPANSION`、`VOLUME_CONTRACTION`、`RAPID_RUNUP`、`SHARP_REVERSAL`、`LONG_UPPER_SHADOW`、`ONE_PRICE_LIMIT_DOWN`、`ONE_PRICE_LIMIT_UP`、`SUSPENDED`、`NO_BAR`、`STALE_BAR`、`ADJUSTMENT_INCOMPLETE`。标签是解释，不是额外看多信号。
- **标签数不是信号数。** 一只股票同时带有多个标签，不代表多个独立买点；V2 不对标签计数、加权或排序。除交易状态阻断外，量价标签主要写入 `notes` 供解释，不全部设计为硬否决。
- **交易状态。** `TRADABLE`、`SUSPENDED`、`NO_BAR`、`ONE_PRICE_LIMIT_DOWN`、`ONE_PRICE_LIMIT_UP`、`LIMIT_UNKNOWN`。停牌、无当日 K 线、一字跌停、一字涨停和涨跌停价未知会阻断正常研究资格；具体规则见第 3 节。
- **关键阈值（研究假设）。** 量比 ≥ 1.5 记 `VOLUME_EXPANSION`，≤ 0.6 记 `VOLUME_CONTRACTION`；5 日涨幅 ≥ 15% 记 `RAPID_RUNUP`；单日涨跌 ≥ 5% 且 5 日方向相反记 `SHARP_REVERSAL`；上影线占当日振幅 ≥ 60% 记 `LONG_UPPER_SHADOW`。这些是解释性假设，不参与跨家族评分。
- **与 V1 的区别。** V1 没有统一的共享量价上下文，风险事件还会以 `-5` 分计入 `priority`；V2 把量价与交易状态作为独立、可审计的解释字段，不折进任何排序分数。

## 3. 阶段与输出契约

### 3.1 阶段

| stage | 含义 | 是否可 `research_ready` |
|---|---|---|
| `FORMING` | 价格行为已可观察，但确认条件尚未发生 | 否 |
| `CONFIRMED` | 确认 K 线就是评估 K 线 | 是，且交易状态必须正常 |
| `FOLLOW_THROUGH` | 确认已发生且契约仍成立 | 是，且交易状态必须正常 |
| `FAILED` | 已声明的失效条件发生，形态结束 | 否 |
| `EXPIRED` | 观察窗结束但未失效 | 否 |

- **确认日期不回溯。** `confirmed_on` 是形态首次可证的 K 线，`formed_on` 可以更早，但任何阶段日期都不能回填到形成低点或整理起点。用截断到评估日的 K 线重新运行，过去已确认信号的日期不得变化。
- **形态不降级重述。** 已确认形态不会因为后续价格回落而改写成一个更早的 `FORMING`；失效就是 `FAILED`，窗口结束就是 `EXPIRED`。
- **过期日期稳定。** `EXPIRED.expires_at` 是第一次满足过期条件的交易日，不是评估日；在过期后 +1/+5/+20 个交易日重放必须相同。`EXPIRED` 只表示观察窗口结束，不是当前负面证据。

### 3.2 `research_ready` 与交易状态

`research_ready` 只是“进入进一步研究清单”，其判定是“存活确认阶段 + 正常交易状态”的合取：`FORMING`、`FAILED`、`EXPIRED` 一律阻断；`SUSPENDED`、`NO_BAR`、`ONE_PRICE_LIMIT_DOWN`、`ONE_PRICE_LIMIT_UP`、`LIMIT_UNKNOWN` 也一律阻断。交易状态在形态阶段之前判定，且始终覆盖形态阶段：即使历史形态仍是 `CONFIRMED`，as-of 日停牌、无 K 线或一字跌停也不能进入正常研究清单。价格因跌停而靠近历史确认位，不会改善入场准备度。

`bars_behind_as_of > 0` 时附加 `STALE_BAR` 标签和说明，禁止用上一交易日的 K 线冒充 as-of 当日确认；`ADJUSTMENT_INCOMPLETE` 表示区间复权因子缺失，相关形态可靠性存疑。

### 3.3 输出形状

`TechnicalViewV2` 的核心字段：

```json
{
  "status": "OK",
  "reason": null,
  "framework_version": "technical-v2.1.0",
  "implementation_fingerprint": "<sha256>",
  "as_of": "YYYYMMDD",
  "market_regime": "uptrend | downtrend | range | UNKNOWN",
  "methodology_note": "...",
  "contexts": ["每股一条价格量价与交易状态记录"],
  "families": [
    {
      "family": "TREND_CONTINUATION",
      "label": "趋势延续",
      "definition": "...",
      "candidates": ["技术候选"],
      "counts": { "FORMING": 0, "CONFIRMED": 0, "FOLLOW_THROUGH": 0, "FAILED": 0, "EXPIRED": 0, "total": 0, "research_ready": 0 }
    }
  ],
  "coverage": {
    "universe": 0, "preselected": 0, "analyzed": 0,
    "skipped_adj_missing": 0, "skipped_insufficient": 0, "capacity_limited": 0
  },
  "evidence_level": "UNVERIFIED",
  "research_only": true
}
```

每个候选至少带 `ts_code`、`name`、`trade_date`、`as_of`、`strategy_id`、`family`、`stage`、`stage_detail`、`formed_on`、`confirmed_on`、`invalidated_at`、`expires_at`、`confirmation_lag`、`formation_basis`、`confirmation_conditions`、`invalidation_conditions`、`invalidation`、`key_levels`、`evidence`、`market_regime`、`price_volume_tags`、`trading_status`、`research_ready`、`research_blockers`、`evidence_level`，以及描述性 `price_position`。

`price_position`（全部为同一前复权收盘口径，不是评分）：`close`、`ma20`、`ma60`、`atr14`、`rsi6`、`rsi14`、`close_vs_ma20_pct`、`close_vs_ma20_atr`、`close_vs_ma60_pct`、`ma20_above_ma60`、`ma20_rising`、`reference_price`、`reference_kind`、`reference_distance_pct`、`reference_distance_atr`、`bars_since_confirmation`、`invalidation_level`、`invalidation_distance_pct`、`invalidation_distance_atr`、`price_extension`、`price_extension_basis`。固定研究假设：`price_extension = (close - MA20) / ATR14 >= 3.0`；它未按案例拟合、未验证收益优势，RSI 只描述、不是失效门槛。

- **确定性排序。** 同一策略族内按 `CONFIRMED` → `FOLLOW_THROUGH` → `FORMING` → `FAILED` → `EXPIRED`；同阶段按 `confirmed_on` 降序，再按 `ts_code`、`strategy_id` 升序。两次运行应序列化一致。
- **版本与身份分离。** `framework_version` 和 `implementation_fingerprint` 描述 V2 口径；`implementation_fingerprint` 由 `TECHNICAL_MODULES` 的编译产物按固定方案 `technical-modules-v1` 计算。它和 V1 的 `entry_hash` 不是同一身份，不能互相替代。旧快照缺少 V2 字段时照常读取；新生成的 V2 快照把该字段计入内容身份，但不改写旧 `content_hash` 和历史版本号。
- **市场环境是描述。** 顶层与候选都记录 `market_regime`（由沪深 300 的 MA20/MA60 关系得出），但它是环境描述，不是 V2 的准入闸门；后续可按环境分层观察，不在生成阶段用它筛掉候选。

## 4. 候选发现

- **全市场合格集合。** 复用 `scanMarket()` 已完成的全市场日线计算，收集所有通过基本门槛的股票：非 ST/退市、复权因子完整、至少 130 根 bar、20 日均成交额 ≥0.5 亿。
- **全部合格股票进入五族完整检测。** `technical-v2.1.0` 不再让预筛排名决定谁被详析。只读副本实测：旧 perFamily=120 / union=500 路径在 20261105 漏掉 5,382 条仍有效（FORMING/CONFIRMED/FOLLOW_THROUGH）的形态；修复后六个交易日、五族召回均为 100%（每日 `missed_total=0`；20261105 合格 4,134 只、28,692 条观察）。
- **容量上限仅诊断。** `TECHNICAL_CAPACITY.perFamily=120`、`union=500` 仍计算 `coverage.capacity_limited`，用于显示旧排名会截掉多少条，但不参与选股，也不因某次表现好坏调参。`coverage.preselected` 是合格股票数，`coverage.analyzed` 必须等于它（另加 `forcedCodes`）。
- **不沿用旧入口垄断。** V2 入口不依赖 V1 的 `FOCUS`、RPS Top10 或 ETF 成分名单；低 RPS 的底背离、下轨回归候选同样可以进入反转或均值回归研究清单。旧 RPS 榜单只作为可选对照，不构成 V2 候选资格。
- **独立解释。** 同一股票可被多个策略族发现，但 `contexts` 中只有一条共享量价记录；各族的 `stage` 与依据分别计算，不合并成跨族分数。

## 5. 相对 V1 的变化

- **旧候选池偏向已经上涨的股票。** V1 主要依靠行业领涨、RPS120 和 ETF 成分选种子，天然偏向强势股，难以发现早期底背离、布林下轨回归等机会。V2 改为按策略族全市场预选，低 RPS 也可进入反转/均值回归清单。
- **旧 `bo_range` 不是平台突破。** 它只是“放量创 60 日新高”（成交量 ≥ 1.2 倍 20 日均量，首次穿越），没有整理持续时间、区间收敛或急涨排除条件。V2 的 `PLATFORM_BREAKOUT` 显式区分“整理后突破”和“连续加速创新高”，不把 `bo_range` 更名后当作新算法。
- **旧跨策略 `entry_score` 不进入 V2。** V1 把趋势、突破、反转等不同语义压进可互比的分数，甚至可能因急跌靠近参考位而令分数上升。V2 不计算跨家族 100 分，不使用 `entry_score` 排序，也不把理论箱体测幅当目标价。
- **`market_regime` 改为环境描述。** V1 策略上的 `market_regime` 多为声明，尚未形成完整的环境研究闭环；V2 记录环境并允许后续分层统计，但不把它当作生成候选的硬门控。
- **旧回放不代表每日全市场能力。** `entryResearch.ts` 回放固定日期的股票池，并禁用 `RPS_HOLD`，因此其结果不能解释为每日全市场动态选股能力。V2 的候选发现与旧回放分开陈述。
- **已知遗留问题记录但不修复。** `hotspotPool.ts` 中 `score * 100` 是已知遗留问题：`score` 已是 0–100 口径（35/15/30/10/10 权重乘以 0–1 组件），再乘 100 后经 `Math.min(100, ...)` 截断，绝大多数股票的分数项失去区分度。本任务只记录，不修改 V1 分数和历史结果；V2 从不读取 `priority`，也不使用该公式作为排序依据。

## 6. 已知限制

- 阈值是启发式研究假设，未经系统参数搜索、机器学习或充分统计验证；不能宣称任何策略族具有稳定优势。
- 样本量可能很小，且同一日期多只股票、重叠持有期和跨股相关性会降低有效独立样本数；不能把同日几十只股票当作几十个独立证据。
- 行业元数据来自当前 `stock_basic` 分类，不是历史时点行业；行业对照只能作为近似描述。
- 日线数据是近似 point-in-time：供应商可能修订历史、复权因子可能缺失、停牌期间只有陈旧 K 线；`ADJUSTMENT_INCOMPLETE` 的样本会明确跳过或标注。
- 没有日内行情、盘口、订单队列或封板排队模拟；涨跌停和停牌规则只是日线级保守近似，不能声称已模拟真实成交。
- 一字跌停日不可正常买入或卖出；一字涨停日买入受成交约束；停牌股票只能看到停牌前最后一根 K 线，不能把旧数据当作当日数据。
- 不提供做空、杠杆、仓位管理、组合构建或收益预测；事件研究中的端点收益不是可交易组合收益。
- 证据等级不会因 V2 生成结果而自动提升。`research_ready`、阶段计数和描述性统计都不等于统计显著或投资优势；等级提升需要既有证据机制另行完成。

## 7. 观察计划

- **复用既有评价器。** 使用 `evaluation.ts` 的 `evaluateEvents`：信号在 t 日收盘确定，t+1 交易所开盘价是唯一买入时点；缺失行情不移动到下一根 K 线；开盘涨停保守拒绝买入；停牌或已知收盘跌停导致卖出受阻时，在显式 `maxExitDelay` 内延后；无法确认的退出保留为未解决，不按零收益处理。A 股 T+1 要求持有期 `h ≥ 2`，观察口径为 3、5、10、20 个交易日。
- **费用显式记录。** 买入/卖出费用和每侧不利滑点都是显式参数。既有验证文档记录的研究情景为买入 3bp、卖出 8bp、每边滑点 5bp；`HOTSPOT_EXPERIMENT_COSTS` 另有 15/25/10bp 的情景。V2 观察必须写明采用哪一组，不得在看过结果后切换口径。
- **三组对照。** ①仅按 RPS 选股、不套用 V2 形态，用相同执行与费用评价，检验形态是否提供超出相对强度的信息；②旧 V1 已确认信号，用相同日期和评价器作为历史对照；③不额外筛选的 V2 确认信号，去掉时机/风险门控，用于区分“形态本身”和“附加门控”的作用。三组都必须保留完整分母和未成交原因。
- **描述性输出。** 按策略族、stage、market_regime 分组报告事件数、入场数、完成数、未入场/未知/待到期/无法退出数，以及收益与超额的均值、中位数、胜率和分位数。日期 cohort 是推断单位；重叠持有期和重复股票要披露，不计算误导性的独立样本 t 值或年化 Sharpe。
- **证据状态。** 样本不足时只输出描述性结果并保持 `UNVERIFIED`；只有在足够多独立日期、预先冻结口径并完成多重比较与扣费后超额检验后，才可能由既有证据机制讨论更高等级。V2 观察阶段禁止参数搜索、禁止按结果挑选阈值或策略族，也不因某一日期表现好坏修改规则。
