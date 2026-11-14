# Strategy production admission

本地准入存储提供由本机用户显式操作的授权记录，但尚未接入生产执行入口。`StrategyRelease` 是离线研究交换契约，其内容哈希只能验证内容一致性，不证明发布者或批准人身份。`candidateRegistry` 的 `VERIFIED` 表示建议人工审批，不是生产批准；账户研究证据和现有风险政策也没有提供绑定 release 哈希的可信生产授权。研究展示和执行授权必须分离。

未来接入前，需要由账户所有者明确本地授权来源、可信批准人及其权限、授权记录的作用范围和生效期，并确定实际执行调用方。不能把 release 或请求中自报的批准人、`approved` 字段、哈希或自签材料直接当作可信批准。当前没有创建任何真实生产批准。

生产执行入口应在每次执行前验证完整 release 与实际运行版本，并检查可信授权记录是否精确绑定 `strategy_id`、`version` 和 release `content_hash`，以及账户、市场、环境等具体作用范围和有效期。缺失、无效、未生效、过期、暂停、撤销、身份不可信或 release 无法验证时一律拒绝。`DRAFT`、`RESEARCH_PUBLISHED`、`REJECTED` 和含 `UNKNOWN` 条件的 release 不得获得执行准入；冻结或前瞻影子状态也不能自行构成批准。

## 本地命令

`finance-ashare portfolio-strategy-admission grant --release release.json --account SCOPE --market MARKET --environment ENV --valid-from ISO --valid-until ISO --note TEXT --confirm` 显式追加准入记录；时间使用 UTC 格式 `YYYY-MM-DDTHH:mm:ss.sssZ`。`pause`、`resume`、`revoke` 使用相同的 `--release`、`--account`、`--market`、`--environment` 和 `--note`；`status` 使用相同 release 与 scope 查询当前是否准入，拒绝时退出码非零。可用 `--operator` 指定审计记录的操作人，默认 OS 用户名。release 的 strategy ID、版本和内容哈希均通过完整 release 校验后绑定。

所有子命令可用 `--db PATH`，否则使用 `ASHARE_STRATEGY_ADMISSION_DB_PATH`，再否则使用 `~/.local/share/ashare-private/strategy-admission.sqlite`。私有目录及数据库仅供所有者访问。查询不会创建准入库。scope 是用户提供的标识，存储不读取账户数据。

本地命令记录授权、暂停、恢复与撤销，并基于本地文件系统权限及执行命令的用户建立信任边界。操作人字段可以由参数填写，仅为审计声明；这不是加密签名、身份认证或防篡改证明。拥有文件写权限的人可以修改、截断或回滚数据库，也可绕过命令直接写库；请保护目录及备份。实际执行入口尚未接入，未来接入时必须在每次执行前重新验证授权，并处理暂停或撤销与执行之间的竞态。研究输出和本地授权记录均不会下单。
