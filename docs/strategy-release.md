# StrategyRelease 离线契约 v1

这是研究发布的离线交换格式，不连接数据导出、候选 runner、调度或生产。研究状态是发布方声明，不证明研究结论；`production_admission` 必须显式为 `NOT_APPROVED`，无批准、启用或执行接口。未来 FinanceMCP 生产准入需要独立决策和独立实现，不能由研究发布、校验通过或接口连通推导。

必填且拒绝未知字段：`schema_version`、`research_status`、`production_admission`、`strategy`（`id`、`version`）、`inputs`（`source`、`snapshot`、含首尾的 `start_date` / `end_date`、非空 `assets`）、非空文本数组 `rules`、非空字符串映射 `parameters`、非空 `evidence`（每项 `reference` 和小写 SHA-256）及 `content_hash`。参数键限定 ASCII 字母开头、其余字母数字或下划线；参数值为字符串以避免跨语言数值规范化歧义。日期格式为有效的 `YYYY-MM-DD`；资产不得重复。研究状态仅允许 `DRAFT`、`RESEARCH_PUBLISHED`、`FROZEN`、`PROSPECTIVE_SHADOW_ACTIVE`、`REJECTED`，并非自动状态转换。

此外，`strategy.implementation_sha256` 指定冻结实现的小写 SHA-256，无法确认时显式写 `UNKNOWN`。必填 `applicability.market`、`applicability.environment`，以及 `execution_assumptions.signal_timing`、`earliest_execution`、`exit`、`fees`、`lot_size`，分别说明适用市场与环境、信号时点、最早执行时点、退出规则、费用与整手假设；未知值显式写 `UNKNOWN`，不得猜测。字段为非空字符串，校验不证明所述假设正确或可执行。

内容哈希是去掉顶层 `content_hash` 后的完整对象的 SHA-256：所有对象键以 ASCII 字典序排列、数组保持原序，JSON 使用紧凑分隔符，字符串按 JSON 转义、非 ASCII 保留并以 UTF-8 编码；不允许未配对代理字符。内容哈希不是研究批准或生产准入。证据和实现的哈希只是声明：校验器不读取引用文件，因此不证明证据存在或真实，更不提供签名、发布方身份或防止攻击者重新计算哈希的认证。

合法补充平面字符按 Unicode 标量值保留；不执行 NFC、NFD 等 Unicode 正规化，因此视觉相同但编码不同的字符串会产生不同哈希。孤立的 UTF-16 代理字符不合法，必须拒绝。

两个仓库各自版本化相同样本：FinanceMCP 的 `test/fixtures/strategy-release.json` 与 TactiCore 的 `tests/fixtures/strategy-release.json`。各自测试独立运行，并固定校验相同内容哈希；样本完全虚构，不代表任何冻结候选或正式发布。更新样本时同时更新两份，并从 FinanceMCP 仓库执行下列跨仓对照（路径按实际 checkout 调整）：

```sh
npm run build
node test/strategyRelease-parity.mjs /path/to/TactiCore/tests/fixtures/strategy-release.json
```

对照检查两份文件字节完全一致并验证内容哈希；单仓测试不依赖另一个 checkout。
