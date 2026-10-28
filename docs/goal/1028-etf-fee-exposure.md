# Goal 1028：ETF 基金费率暴露（etf_quotes / etf_status fee 块）

日期：2026-10-28　分支：`feat/etf-fee-exposure`（基线 `af863f4`）　状态：已部署 · LIVE_VERIFIED（见 §部署记录）

## 一、问题

ChatGPT + Oracle VPS 夜报长期出现"ETF 费率不明"。排查结论（2026-10-28）：

- **数据不缺**：生产 market DB 的 `fund_basic` 早已含 `m_fee`/`c_fee`（tushare 同步，2026-10-22 刷新），5 只持仓 ETF 全部有值，且与东方财富公开数据逐只一致（159558/159278/159241 = 0.5%/0.1%，516080/560390 = 0.15%/0.05%）。
- **缺的是暴露**：`ashare_etf_quotes` / `ashare_etf_status` 的返回结构不含费率字段，`quoteOne` 虽然 `SELECT *` 取到了 m_fee/c_fee，但没有放进 `EtfQuote`；工具描述也不提费率。ChatGPT 连接器只能看到工具输出 → 只能报"不明"。
- 东方财富妙想 skill（本机 Claude Code 侧）可按需查费率，但技能不出这台机器，替代不了 MCP 工具面。

## 二、变更（最小暴露面，不动同步、不动 schema）

1. `src/ashare/etf.ts`
   - `ETF_FEE_NOTE` 常量：口径说明——m_fee/c_fee 为年费率百分比（0.5 = 0.5%/年）；场内二级市场买卖无申购赎回费，交易成本仅为券商佣金（佣金率属账户侧，不在本库）；基础信息按 `ETF_FUND_BASIC_REFRESH_DAYS`（7 自然日）间隔刷新。
   - `EtfFee` 接口 + `buildFee()`：`management_rate_pct` / `custody_rate_pct` / `total_rate_pct`（两者都有才求和）/ `unit: 'percent_per_year'` / `source: 'tushare.fund_basic'` / `as_of`（fund_basic.updated_at）/ `note`。fund_basic 缺失时各率为 null，**块始终存在**，不伪造、不省略。
   - `EtfQuote.fee`、`etfStatusResult.codes[].fee`、`etfQuotes.units.fee`。
2. `src/ashare/definitions.ts`：两个 ETF 工具描述补费率说明（ChatGPT 由此知道可以问费率）。
3. `src/ashare/cli.ts`：`etfs-quotes` 帮助行注明含 fee 块。
4. `test/ashare-etf.test.mjs`：test 1 增加 fee 断言；新增 test 1b（fund_basic 缺失 → null 块；etfStatus 逐只 fee 传播）；工具描述回归加 `/management_rate_pct/`、`/fee/` 匹配。

**不改**：同步逻辑（`ETF_FUND_BASIC_REFRESH_DAYS=7` 已覆盖费率刷新）、`db.ts` schema（列已存在）、研究日志、私有端点、`IMPLEMENTATION_MODULES` 13 模块冻结清单涉及的文件（`db.ts` 未动，freeze hash 不变）。

## 三、验证

- `npm test`（build + 全套）：见部署记录中的通过时间。
- 部署后生产只读验证：公开端点 `ashare_etf_quotes`/`ashare_etf_status` 逐只返回真实费率；私有 journal 行数不变（本改动零写入路径）。

## 四、部署记录

- 授权：用户 2026-10-28 明确授权（"按照方案A进行，授权你直接部署"）。
- 提交：`feat/etf-fee-exposure` 分支，commit `5112fab`（`5112fab0ad220a51cbd38baac5bfcbae7b292c18`，基线 `af863f4`）。
- 测试：部署前 `npm test`（build + 全套单进程）：949 pass / 0 fail / 1 skipped。
- 升级：`upgrade.sh --revision 5112fab0ad220a51cbd38baac5bfcbae7b292c18 --branch feat/etf-fee-exposure`，记录 `rollback-20261028T063715Z`（20261028T063715Z）。
  - 回滚镜像标签在 build 前打：`finance-mcp-ashare:rollback-20261028T063715Z`（可寻址，旧镜像未被 build 覆盖）。
  - 部署前数据库备份：`ashare.20261028T063715Z.sqlite`（VACUUM INTO + 完整性/恢复校验通过）。
  - 升级后 `/health` 健康；容器 OCI revision 标签 = `5112fab0ad220a51cbd38baac5bfcbae7b292c18`（与目标一致）。
- 回滚演练：`rollback.sh <record.env> --dry-run` PASS（目标 revision 与备份 sha256 均核验通过）。
- 生产只读 live 验证（公开端点 `https://share.shijingchang.cn/ashare/mcp`）：`ALL_GOAL1028_LIVE_CHECKS_PASS`
  - `ashare_etf_quotes`：5 只持仓逐只返回真实费率——159241/159278/159558.SZ = 管理 0.5% / 托管 0.1% / 合计 0.6%；516080/560390.SH = 0.15% / 0.05% / 0.2%；`unit=percent_per_year`；`as_of=2026-10-22T05:32:02.978Z`。
  - `units.fee` 存在；工具描述含 `management_rate_pct` / `fee` 字样（ChatGPT 可从描述发现费率能力）。
  - `ashare_etf_status`：codes[] 5 只 fee 块逐只匹配。
  - 回归：`ashare_daily_report {date:"20261027"}` http=200（此前误用不存在的工具名 `ashare_daily` 得到空 body 400，属脚本笔误，非产品回归；已更正验证脚本）。
- 私有库零写入核验：`portfolio.sqlite` research_journal 部署前后均为 7 行（本改动无写入路径）。

## 五、口径备忘

- "申购赎回费率"不是"不明"，是**不适用**：场内 ETF 二级市场买卖无申购赎回费；申赎走份额篮子机制。交易成本只有券商佣金，佣金率属账户侧数据。
- 费用拖累诊断（`researchDiagnosis.ts` 的账户费率缺口）是另一层问题：那是账户/券商佣金缺失，本 goal 不处理。
