# Gemini 网页版自定义 MCP 应用接入与定时日报实施指南（V3）

> **定位**：与本机 `17:20` 自动飞书日报管线并行的双轨外部研究接入方案；完全复用生产级 `/private/mcp` 私有账户端点与 OAuth 2.1 授权服务器，不新建平行服务，不暴露任何敏感明文凭证。

---

## 一、双轨架构总览

```text
                       ┌─────────────────────────────────────────────────┐
                       │ 轨道 A（主生产·无人工·飞书直达）                │
Tushare Pro ──► cron/systemd (17:20 CST)                                 │
                       │  └─ run-daily-unified.sh                        │
                       │      ├─ 日线/ETF/fund_nav 同步（异常隔离与延迟告警）│
                       │      ├─ 热点快照 + 账户研究快照入库              │
                       │      └─ 飞书 Docx + IM 推送                      │
                       └─────────────────────────────────────────────────┘
                                         │ 共享只读 cache & 账本
                                         ▼
  Gemini 网页版（gemini.google.com）
    ├─ Connected Apps / DevMode（Streamable HTTP + OAuth 2.1）
    └─ Scheduled Actions（建议每个交易日 19:30 Asia/Shanghai）
           │
           │ HTTPS + Bearer Access Token (portfolio:read research:append)
           ▼
  Caddy（https://share.shijingchang.cn）
    ├─ /.well-known/oauth-protected-resource*   ──► 127.0.0.1:8130
    ├─ /.well-known/oauth-authorization-server* ──► 127.0.0.1:8130
    ├─ /oauth/*                                 ──► 127.0.0.1:8130
    ├─ /private/mcp*（账户工具 + 研究日志追加） ──► 127.0.0.1:8130
    └─ /ashare/mcp* （公开市场缓存只读工具）    ──► 127.0.0.1:8130
           │
           ▼
  FinanceMCP（finance-mcp-ashare 容器）
    ├─ 只读工具：ashare_investment_research_bundle / ashare_portfolio_daily_report / ...
    └─ 只追加工具：ashare_chatgpt_research_record_append (source='gemini')
                   ashare_research_thesis_append / ashare_research_combined_append
```

---

## 二、服务端关键协议能力（已内建于 FinanceMCP）

1. **Streamable HTTP 协议协商**：
   - `POST /private/mcp` 与 `POST /mcp` 支持 `initialize` 版本协商（`2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`），CORS 已放行 `Mcp-Protocol-Version` 与 `Mcp-Session-Id`。
2. **OAuth 2.1 双模式认证**：
   - 既支持 ChatGPT / Gemini DCR 无密 PKCE（`token_endpoint_auth_method=none` + `S256`），也支持 Gemini 网页版预注册机密客户端（`client_secret_post` / `client_secret_basic`）。
   - 受控支持 Google 官方回调前缀（如 `https://vertexaisearch.cloud.google.com/oauth-redirect`、`https://oauth-redirect.googleusercontent.com/r/*`、`https://oauth-redirect-sandbox.googleusercontent.com/r/*`、`https://oauth-redirect-test.googleusercontent.com/r/*`、`https://gemini.google.com/*`），并仅在本地密码校验通过后将具体回调地址固化进授权记录。
   - 同时挂载 RFC 9728（`/.well-known/oauth-protected-resource` 及 `/private/mcp` 变体）、RFC 8414（`/.well-known/oauth-authorization-server` 及 `/private/mcp` 变体）与 `/.well-known/openid-configuration`。
3. **Gemini 一等研究源（`source = 'gemini'`）**：
   - 调用 `ashare_chatgpt_research_record_append` 时传入 `source: 'gemini'`，服务端自动生成 `GEMINI-YYYYMMDD-...` 只追加研究日志，可继续调用 `ashare_research_thesis_append` 与 `ashare_research_combined_append` 形成联合研究记录，并在 `ashare_research_eval` 中按 `gemini` 层独立评估（与 `chatgpt`、`hermes` 共用每日 20 条外部写入配额）。

---

## 三、Gemini 网页版接入步骤

### 1. 本机获取或预置 OAuth 凭证

在本机可通过 CLI 管理私有 OAuth 客户端（所有密钥哈希存储于 `/private/oauth.sqlite`，明文凭证只落本机私有目录，绝不入库 git）：

```bash
# 查看已注册客户端
docker exec finance-mcp-ashare node build/ashare/cli.js oauth-client-list

# 为 Gemini Web 创建专用机密客户端（仅当需要轮换或新增时运行）
docker exec finance-mcp-ashare node build/ashare/cli.js oauth-client-create \
  --name "Gemini Web" \
  --redirect-uri "https://vertexaisearch.cloud.google.com/oauth-redirect,https://oauth-redirect.googleusercontent.com/r/*,https://oauth-redirect-sandbox.googleusercontent.com/r/*,https://oauth-redirect-test.googleusercontent.com/r/*,https://gemini.google.com/*"
```

若已在本机生成，私有凭证保存在：
`/home/jcshi/.local/share/ashare-private/gemini-oauth-client.json`

### 2. 在 Gemini 网页版注册自定义 MCP 应用

1. 打开 `https://gemini.google.com`（或调试工作台 `https://gemini.google.com/devmode`）。
2. 进入 **Settings > Connected Apps**（或 Developer Mode 下点击 **+ Create new**）。
3. 填写自定义 MCP 服务端点：
   - **MCP Server URL**：`https://share.shijingchang.cn/private/mcp`
   - **Transport**：`Streamable HTTP`
4. 认证配置：
   - 若 Gemini 自动走 OAuth Discovery / DCR，可直接点击连接并在弹出的授权页输入部署密码（对应容器环境变量 `ASHARE_OAUTH_LOGIN_PASSWORD`）完成授权；
   - 若界面要求手动填写凭证，展开 **Additional settings > Show more**，填入 `gemini-oauth-client.json` 中的 `client_id` 与 `client_secret`；
   - **Scope**：`portfolio:read research:append`（如需只读可仅填 `portfolio:read`，但只读授权无法回写 Gemini 独立研究判断）。
5. 授权成功后，在对话中用 `@<你的应用名称>` 调用 `ashare_investment_research_bundle` 校验可正常读取账户快照与市场状态。

---

## 四、Gemini Scheduled Actions（定时日报）提示词模板

在 Gemini 网页版侧边栏 **Scheduled Actions** 新建每日排程（建议时间：**每个交易日 `19:30` Asia/Shanghai**；注意：Tushare 收盘日线通常在 `18:00–19:15` 入库完毕，19:30 可避开上游延迟窗口），粘贴以下提示词：

```text
请通过已连接的 FinanceMCP 私有 MCP 应用执行今日 A 股 V3 攻防账户盘后研究并输出中文日报：

1. 首先调用 `ashare_investment_research_bundle`（不传或省略 account_id，默认今天最近已收盘交易日）读取服务端冻结研究包与账户最新重放持仓。
2. 若返回 `status` 为 `NOT_READY` 或 `DATA_INSUFFICIENT`，请先诚实说明数据尚未就绪及缺口原因，并补充调用 `ashare_portfolio_daily_report` 查看最新可核对持仓基线，不得伪造任何当日行情或动作数量。
3. 当数据就绪时，严格基于返回事实与 V3 规则（动态市场档位 85%/60%/15%、-8% 单股硬止损、-12%/-15% 熔断线、159558 四批换马状态、BP1 回踩 MA20 与 QualityCore 筛选）输出结构化中文日报，至少包含：
   - 今日市场档位（进攻/结构/防守）与占优风格；
   - 账户总资产、现金/在途资金、距 ¥100,000 回本差额与距熔断线安全垫；
   - `159558.SZ` 剩余份数、当前换马批次进度与下一次触发条件（月度日、+8% 目标价、箱体防守位）；
   - 下一交易日最值得执行的 0–3 个具体动作（精确到整手股数/份数、参考价、硬止损价与预估佣金）及失效条件；
   - 反证与风险提示（禁止暴露底层英文 enum 或 snake_case 字段名）。
4. 若当日已有持久化的 VPS 研究快照（返回的 `persisted_snapshot.status === "PERSISTED"`），在生成报告后调用 `ashare_chatgpt_research_record_append`：
   - `source`: `"gemini"`
   - `report_id`: 与 `ashare_investment_research_bundle` 顶层返回的 `report_id` 一致
   - `as_of_trade_date`: 当日交易日 `YYYYMMDD`
   - 填入你的 `independent_judgement`、`final_conclusion` 与外部可核验依据（如有）。
   随后视情况调用 `ashare_research_thesis_append` 记录结构化判断单元（`parent_record_id` 可引用上一步返回的 `record_id`），并调用 `ashare_research_combined_append` 生成当日联合研究记录。
```
