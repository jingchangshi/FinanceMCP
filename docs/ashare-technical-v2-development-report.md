# A 股技术方法 V2 开发报告（goal-1102）

- 仓库：`/home/jcshi/workspace/FinanceMCP`（`https://github.com/jingchangshi/FinanceMCP`）
- 分支：`feat/ashare-technical-method-v2`
- 起始分支 HEAD：`a4e972e529836c419308db10dd0605a28698690c`（`main` 当时的最新提交）
- 生产容器 revision：`f18170907dbaab1fc56dfa8ba6cc5032dbab085d`（比分支起点早一个文档提交）
- 起始工作树：干净；实现未触碰 V1 历史快照和已生成研究结果
- 部署：未 push、未执行正式 `upgrade.sh`、未重启容器、未改定时任务、未设置 `ASHARE_HOTSPOT_FORCE=1`

## 1. 实现范围

| 模块 | 状态 |
|---|---|
| A `TREND_CONTINUATION`（趋势建立、MA20 回踩后重新走强） | 完成 |
| B `PLATFORM_BREAKOUT`（30 日窄幅平台、放量突破、急涨排除） | 完成 |
| C `REVERSAL`（MACD DIF 底背离形成/确认、保留 DIF W 底） | 完成 |
| D `VOLATILITY_EXPANSION`（BOLL 收口突破、沿上轨运行） | 完成 |
| E `MEAN_REVERSION`（震荡超卖观察、下轨再入确认、下跌环境只观察） | 完成 |
| F `PRICE_VOLUME_CONTEXT`（共享量价标签与交易状态，每股一次） | 完成 |
| 独立发现（复用一次 `scanMarket()`，分族预选、并集详算） | 完成 |
| `technical_view_v2` 接入、只读预览命令 | 完成 |
| `technical-study` 描述性观察（T+1、费用、3/5/10/20 日、三组对照） | 完成 |

新增文件：`technicalFrameworkV2.ts`、`technicalPatternsV2.ts`、`technicalCandidatesV2.ts`、`technicalPreviewCli.ts`、`technicalStudy.ts`、`docs/ashare-technical-framework-v2.md`、三份 `test/technical-v2-*.test.mjs`。

修改文件：`analysis.ts`（一次全市场扫描的可选只读观察钩子）、`hotspotPool.ts`（复用共享扫描、暴露 RPS 横截面）、`hotspotPipeline.ts`（嵌入 V2，失败降级为 UNAVAILABLE）、`hotspotTypes.ts`、`hotspotSnapshots.ts`（仅在字段存在时进入内容身份）、`tools.ts`、`definitions.ts`、`cli.ts`。

## 2. 验收场景（真实只读数据库）

只读命令：

```bash
node build/ashare/cli.js technical-preview --date 20261030 \
  --db /home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite --out /tmp/v2preview2
node build/ashare/cli.js technical-preview --date 20261102 \
  --db /home/jcshi/.local/share/finance-mcp-ashare/ashare.sqlite --out /tmp/v2preview2
```

命令以 `readOnly: true` 打开 SQLite，只写 `--out` 指定的文件，不生成热点快照或版本。运行后复核：20261030 快照仍为 `sha256:97101e39…`（version 1），20261102 仍为 `sha256:dba26601…`（version 1），均未被改写。

### 海洋王 `002724.SZ` / `20261102`

- V1：`entry_top10` 第 5 名，`NEW_ENTRY`，`entry_score=96`，`confirmed_on=20261027`，BREAKOUT，risk/reward 8.12；`research_top10` 中 priority 84.97、research_score 67.54。11/2 一字跌停反而比 10/30 的 70.4 分更高，正是旧口径要避免的“暴跌缩短到确认价距离”。
- V2：共享上下文数据日为 20261102、`ONE_PRICE_LIMIT_DOWN`、标签 `ONE_PRICE_LIMIT_DOWN / VOLUME_CONTRACTION / SHARP_REVERSAL`，notes 保留 20261027（及 10/19–10/30）突破事实；六个候选全部 `research_ready=false`，阻塞原因均为 `ONE_PRICE_LIMIT_DOWN`（过期/失效形态再叠加对应阶段原因）。V2 不计算入场分，不因跌停靠近历史确认位改阶段。

### TCL中环 `002129.SZ` / `20261102`

- V1：`entry_top10` 第 6 名，`PULLBACK_WAIT`，`entry_score=96`，且名称退化为代码，`eligibility_reasons=[BELOW_LIQUIDITY_FLOOR]`。
- V2：原始日线缺 11/2 成交，`suspend_d` 表明停牌；上下文数据日保持 **20261030**、`bars_behind_as_of=1`、`SUSPENDED`。全部候选 `research_ready=false`，阻塞原因含 `SUSPENDED` 与 `NO_BAR_ON_AS_OF`；10/30 确认的均值回归信号仍以 20261030 为 `trade_date` 展示，没有冒充 11/2。

### 独立发现

20261102 全市场 5571 只，预选 481 只并全部详算；反转族 160 个 `research_ready` 中 156 个不在 V1 `FOCUS`（38 只）里，均值回归族 86 个中 84 个不在 FOCUS 里。例如丝路视觉（300556.SZ）、白云机场（600004.SH）、华数传媒（000156.SZ）均非当日 FOCUS，说明 V2 没有沿用旧入口偏置。

## 3. 真实形态示例（20261102）

| 家族/形态 | 示例 | 关键证据 |
|---|---|---|
| MACD DIF 底背离 | 丝路视觉 300556.SZ，CONFIRMED | 价格低点 20260807 15.67 → 20261009 15.25（更低），DIF -0.3084 → -0.0719（抬高）；颈线 18.70；20261014 形成，20261102 收盘越颈线确认；RSI 背离同向 |
| BOLL 收口突破 | 国际医学 000516.SZ，CONFIRMED | 20261030 带宽 0.0584 ≤ 近 120 日 20% 分位 0.0639；20261102 收盘 4.50 上穿上轨 4.4961 |
| 沿上轨运行 | 江阴银行 002807.SZ，CONFIRMED | 近 5 日 3 日触及/站上上轨；带宽 0.0957 > 120 日中位 0.0780；明确记录“触上轨不是卖出信号” |
| 平台突破 | 浦发银行 600000.SH，CONFIRMED | 30 日平台 8.91–10.04（振幅 11.25%），20261102 突破，量比 1.48 |
| 均值回归 | 华数传媒 000156.SZ，CONFIRMED | 20261030 超卖观察，20261102 收盘 7.28 高于下轨 6.7089 且高于前收，RSI 50.97 |
| 趋势回踩 | 北方国际 000065.SZ，CONFIRMED | 20261030 低点 9.28 回踩 MA20 9.6105，20261102 收上 MA20 确认 |

合成测试另覆盖：真平台与连续急涨的区分、收敛/沿上轨/下轨再入三个不同形态、下跌趋势中的超卖永不确认、所有形态的截断稳定性。

## 4. 测试与性能

- 最终 `npm test`（`npm run build && node --test test/*.test.mjs`）：1130 个用例，1129 通过、0 失败、1 跳过，耗时 1175.4 s；其中三份 V2 测试共 21 个用例全通过。
- 只读预览：20261102 10.22 s、20261030 10.35 s（各自独立全市场扫描 + 详算）。
- 真实日流程嵌入成本：以只读连接、`persist:false` 运行 20261102 流水线，`timings.technical=1.305 s`，`total=37.109 s`；同日基线 `total=36.755 s`，未超过 2 倍限制，也无需缩减容量。
- `technical-study` 真实描述性运行：20260930/20261015/20261030 三个可见日期、截止 20261102，83.74 s；180 个族/阶段/地平线样本和 28 个对照样本，证据等级仍为 `UNVERIFIED`。

## 5. 尚缺证据与已知限制

- 所有阈值是预先写死的研究假设，未做参数搜索，也没有统计优势声明；样本期短、持有期重叠、同族多候选，不能当独立样本。
- 日线级停牌/涨跌停近似，没有盘口、封板排队或日内成交；一字跌停日不能假设可以买入或卖出。
- 行业分类取当前 `stock_basic`，不是历史时点分类；复权因子修订和供应商数据修订未建模。
- V2 只做研究清单，不生成仓位、目标价或收益预测；`evidence_level` 保持 `UNVERIFIED`。
- `hotspotPool.ts` 的 `score * 100` 是记录的 V1 遗留问题，未修复；V2 不读取 `priority`。

## 6. 部署与回滚

正式部署（需操作者批准）：

```bash
cd /home/jcshi/workspace/FinanceMCP
git checkout feat/ashare-technical-method-v2
deploy/ashare/upgrade.sh --revision <最终SHA> --branch feat/ashare-technical-method-v2
```

脚本会先验证工作树干净、HEAD 与 revision 一致，并在 `docker compose build` 前给当前运行镜像打 `finance-mcp-ashare:rollback-<UTC stamp>` 标签；随后备份行情/私有/OAuth/研究/验证数据库，替换同一 compose 服务并检查健康与 OCI revision 标签。

回滚（用升级输出里的 rollback 标签和 `rollback-<stamp>.env`）：

```bash
docker tag finance-mcp-ashare:rollback-<stamp> finance-mcp-ashare:local
cd /home/jcshi/workspace/FinanceMCP/deploy/ashare
docker compose up -d --no-build
```

如数据库也需回退，使用 `$HOME/.local/share/ashare-v1/backups/ashare.<stamp>.sqlite`（升级脚本已做 `integrity_check` 与 `.restore` 验证）。本次任务不执行以上任何一步。

注意：部署后重跑历史日期会生成带 `technical_view_v2` 的新内容身份；旧快照保持原 `content_hash`、原版本号，读取路径不变。
