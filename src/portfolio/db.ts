import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ashareDataDir, ashareDbPath } from '../ashare/db.js';
import { PORTFOLIO_RISK_POLICY_DDL } from './riskPolicy.js';

/**
 * 私有账户账本（P2）。与公开市场库物理隔离：默认写入
 * `<ASHARE_DATA_DIR>/portfolio.sqlite`，绝不写入 `ashare.sqlite`。
 *
 * 单位约定（全模块一致）：
 * - 金额一律用整数**分**（cents）。
 * - 价格一律用整数**厘**（milli-yuan，1 厘 = 0.001 元）。A 股 ETF 最小变动价位
 *   是 0.001 元，用分存 1.005 会丢精度，因此价格单独用厘，并在字段名里写明 `_milli`。
 * - 数量用整数**份/股**。
 *
 * R0 只写入一次基线快照；`flow` 表为后续真实出入金/分红预留，本轮没有写入路径。
 *
 * R1 增加 P2 事件账本（账本只追加，永不改写既有事实）：
 * - `account_event`：唯一的成交/出入金/分红/费用/拆分/撤销事实表，`event_id` 由调用方
 *   提供作为幂等键；同一 `event_id` 内容相同 → 幂等，内容不同 → 只写冲突表、不覆盖。
 * - `account_event_conflict`：冲突留痕，`reason` 区分内容冲突与重复撤销。
 * - `account_baseline`：每个账户唯一的重建起点（快照或纯现金）。
 * - `account_meta`：账户级开关，目前只用于 `real_account_verified`。
 * 持仓、可用现金与成本一律由 `baseline + events` 确定性重放得出，不存派生余额。
 */

export function portfolioDbPath(): string {
  return process.env.ASHARE_PORTFOLIO_DB_PATH?.trim() || join(ashareDataDir(), 'portfolio.sqlite');
}

/**
 * 本进程是否被授权读取账户库。注意：这只回答"能不能读"，不回答"谁能调用"——
 * 公网 `/mcp` 与本地 stdio 工具面永远不提供账户工具（见 dispatch.ts）。
 * - `ASHARE_PORTFOLIO_ENABLED=1`：显式开启（本地 CLI / 受信任部署）。
 * - `ASHARE_PRIVATE_PORTFOLIO_TOKEN` 已设置：私有端点已配置，令牌本身就是授权。
 */
export function portfolioEnabled(): boolean {
  return process.env.ASHARE_PORTFOLIO_ENABLED === '1'
    || (process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN ?? '').trim().length > 0
    // OAuth 端点已启用时，账户工具同样需要可读（鉴权在 HTTP 层完成）。
    || (process.env.ASHARE_OAUTH_ENABLED ?? '').trim() === '1';
}

const PORTFOLIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL,
  warnings TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  is_current_confirmed_by TEXT,
  is_current_confirmed_at TEXT,
  total_assets_cents INTEGER NOT NULL,
  securities_mv_cents INTEGER NOT NULL,
  cash_cents INTEGER NOT NULL,
  wealth_cents INTEGER NOT NULL,
  unrealized_pnl_cents INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS position (
  snapshot_id TEXT NOT NULL,
  ts_code TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  ref_price_milli INTEGER NOT NULL,
  ref_cost_milli INTEGER NOT NULL,
  market_value_cents INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS flow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
`;

/**
 * P2 事件账本 schema（纯增量，不改动 account_snapshot/position/flow）。
 *
 * 与任务书 DDL 的三处差异，均为 R1 实现所必需且向后兼容（没有改名或删除任何列）：
 * 1. `account_event.reversed_by`：撤销后必须在**原记录**上留下指向，任务书要求
 *    "marks the original `reversed_by`"，因此新增该可空列。
 * 2. `account_event_conflict.reason`：带默认值 `'content_mismatch'`，用于把
 *    "同一 event_id 内容不同"与"重复撤销"两种拒绝区分开，避免重复撤销被误报成
 *    内容冲突。旧行读取时按默认值解释。
 * 3. `account_event_conflict.account_id`：冲突留痕需要按账户统计；重复撤销的冲突
 *    行的 event_id 并不在 account_event 中，无法靠 join 归属。
 */
export const PORTFOLIO_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_event (
  event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  settled_on TEXT,
  ts_code TEXT,
  quantity INTEGER,
  price_milli INTEGER,
  gross_cents INTEGER,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  cash_delta_cents INTEGER NOT NULL,
  ratio_num INTEGER,
  ratio_den INTEGER,
  reverses_event_id TEXT,
  reversed_by TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_event_conflict (
  event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  existing_hash TEXT NOT NULL,
  incoming_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'content_mismatch',
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_baseline (
  account_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  cash_cents INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_event_account_date
  ON account_event (account_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_account_event_reverses
  ON account_event (reverses_event_id);
`;

/**
 * 账本完整性声明（R2 A1/B3）。与账本数据分开：只记录"用户已核对到哪个时点"，
 * 不改变任何事件或持仓。`unreported_trade_risk` 默认 1（存在未上报交易风险）。
 * 另有 `recorded_by` 列记录声明人，便于审计（任务书 DDL 之外的最小增量列）。
 */
export const PORTFOLIO_COMPLETENESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_completeness (
  account_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  last_user_reconciled_at TEXT,
  reported_events_through TEXT,
  unreported_trade_risk INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  recorded_by TEXT
);
`;

export const PORTFOLIO_V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_risk_anchor (
  account_id TEXT PRIMARY KEY,
  initial_principal_cents INTEGER NOT NULL,
  hwm_nav_cents INTEGER NOT NULL,
  hwm_date TEXT NOT NULL,
  hwm_flows_applied_through TEXT,
  hwm_applied_same_day_flow_cents INTEGER NOT NULL DEFAULT 0,
  hwm_nav_scope TEXT NOT NULL DEFAULT 'TOTAL',
  circuit_breaker_status TEXT NOT NULL DEFAULT 'NORMAL',
  locked_until_trade_date TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deconcentration_plan (
  plan_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ts_code TEXT NOT NULL,
  initial_shares INTEGER NOT NULL,
  target_keep_bps INTEGER NOT NULL,
  anchor_price_milli INTEGER NOT NULL,
  anchor_trade_date TEXT,
  support_floor_milli INTEGER,
  last_exec_price_milli INTEGER,
  last_exec_date TEXT,
  plan_mode TEXT NOT NULL DEFAULT 'STANDARD',
  tactical_slot_bps INTEGER NOT NULL DEFAULT 1000,
  tactical_shares INTEGER NOT NULL DEFAULT 0,
  tactical_entry_price_milli INTEGER,
  tactical_entry_date TEXT,
  completed_swing_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deconcentration_tranche (
  plan_id TEXT NOT NULL,
  tranche_no INTEGER NOT NULL,
  planned_shares INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  trigger_date TEXT,
  trigger_reason TEXT,
  executed_date TEXT,
  executed_price_milli INTEGER,
  PRIMARY KEY (plan_id, tranche_no)
);

CREATE TABLE IF NOT EXISTS position_stop_tracker (
  account_id TEXT NOT NULL,
  ts_code TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_price_milli INTEGER NOT NULL,
  initial_stop_milli INTEGER NOT NULL,
  current_stop_milli INTEGER NOT NULL,
  trailing_ma20_armed INTEGER NOT NULL DEFAULT 0,
  entry_adj_factor REAL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, ts_code)
);
`;

/** 只读探测指定表是否存在（避免在只读或未迁移的测试库上触发写操作）。 */
export function portfolioTableExists(db: DatabaseSync | null | undefined, name: string): boolean {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 只读连接不会执行写 schema，因此读取前单独探测账本表是否存在。 */
export function ledgerTablesPresent(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('account_event', 'account_baseline', 'account_meta')",
  ).get() as { n: number };
  return row.n >= 3;
}

/**
 * 幂等地建立 P2 账本表。读路径只在库内已有账本表时使用（不写用户库），
 * CLI 写路径直接调用，测试也用它在只读连接上补齐 schema。
 */
export function ensurePortfolioLedgerSchema(db: DatabaseSync): void {
  db.exec(PORTFOLIO_LEDGER_SCHEMA);
  db.exec(PORTFOLIO_COMPLETENESS_SCHEMA);
}

export function ensurePortfolioV3Schema(db: DatabaseSync): void {
  db.exec(PORTFOLIO_V3_SCHEMA);
  const anchorCols = new Set(
    (db.prepare('PRAGMA table_info(account_risk_anchor)').all() as Array<{ name?: string }>)
      .map(c => c.name)
      .filter((n): n is string => Boolean(n)),
  );
  if (!anchorCols.has('hwm_flows_applied_through')) {
    db.exec('ALTER TABLE account_risk_anchor ADD COLUMN hwm_flows_applied_through TEXT;');
  }
  if (!anchorCols.has('hwm_applied_same_day_flow_cents')) {
    db.exec('ALTER TABLE account_risk_anchor ADD COLUMN hwm_applied_same_day_flow_cents INTEGER NOT NULL DEFAULT 0;');
  }
  if (!anchorCols.has('hwm_nav_scope')) {
    // 迁移前的锚点是历史“总资产峰值”（含理财）；新锚点写 INVESTABLE。
    db.exec("ALTER TABLE account_risk_anchor ADD COLUMN hwm_nav_scope TEXT NOT NULL DEFAULT 'TOTAL';");
  }
  const cols = new Set(
    (db.prepare('PRAGMA table_info(deconcentration_plan)').all() as Array<{ name?: string }>)
      .map(c => c.name)
      .filter((n): n is string => Boolean(n)),
  );
  const migrations: Array<[string, string]> = [
    // 价格基准日与原始锚定价同存；旧库补 nullable 列（NULL 表示历史未记录，绝不从 created_at 回填）。
    ['anchor_trade_date', 'ALTER TABLE deconcentration_plan ADD COLUMN anchor_trade_date TEXT;'],
    ['support_floor_milli', 'ALTER TABLE deconcentration_plan ADD COLUMN support_floor_milli INTEGER;'],
    ['plan_mode', "ALTER TABLE deconcentration_plan ADD COLUMN plan_mode TEXT NOT NULL DEFAULT 'STANDARD';"],
    ['tactical_slot_bps', 'ALTER TABLE deconcentration_plan ADD COLUMN tactical_slot_bps INTEGER NOT NULL DEFAULT 1000;'],
    ['tactical_shares', 'ALTER TABLE deconcentration_plan ADD COLUMN tactical_shares INTEGER NOT NULL DEFAULT 0;'],
    ['tactical_entry_price_milli', 'ALTER TABLE deconcentration_plan ADD COLUMN tactical_entry_price_milli INTEGER;'],
    ['tactical_entry_date', 'ALTER TABLE deconcentration_plan ADD COLUMN tactical_entry_date TEXT;'],
    ['completed_swing_count', 'ALTER TABLE deconcentration_plan ADD COLUMN completed_swing_count INTEGER NOT NULL DEFAULT 0;'],
  ];
  for (const [col, ddl] of migrations) {
    if (!cols.has(col)) db.exec(ddl);
  }
  // 止损跟踪早于复权基准列：旧库补 nullable 列（NULL 表示历史未记录，按不缩放处理）。
  const trackerCols = new Set(
    (db.prepare('PRAGMA table_info(position_stop_tracker)').all() as Array<{ name?: string }>)
      .map(c => c.name)
      .filter((n): n is string => Boolean(n)),
  );
  if (!trackerCols.has('entry_adj_factor')) {
    db.exec('ALTER TABLE position_stop_tracker ADD COLUMN entry_adj_factor REAL;');
  }
}

/**
 * 把路径解析成"最深的已存在祖先的真实路径 + 未创建的后缀"，因此尚未创建的
 * 账户库也能与市场库按真实路径比较（与 ashare/snapshot.ts 的研究库守卫同一思路）。
 */
function realPathOfNearestAncestor(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    tail.unshift(basename(current));
    current = parent;
  }
  let base: string;
  try { base = realpathSync.native(current); } catch { base = current; }
  return tail.length ? join(base, ...tail) : base;
}

/** `dev:ino`；文件不存在时返回 null。用于识别硬链接。 */
function fileIdentity(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * 拒绝把账户库指向市场库：绝对/相对路径、`..`、符号链接、硬链接、符号链接的父目录
 * 都算同一个文件。返回解析后的账户库路径。必须在创建任何文件之前调用。
 */
export function assertPortfolioSeparateFromMarket(path: string, marketPath: string = ashareDbPath()): string {
  const portfolio = realPathOfNearestAncestor(path);
  const market = realPathOfNearestAncestor(marketPath);
  const reject = () => new Error(`账户数据库不能与正式市场数据库相同（${portfolio}），拒绝执行`);
  if (portfolio === market) throw reject();
  const portfolioId = fileIdentity(portfolio);
  if (portfolioId !== null && portfolioId === fileIdentity(market)) throw reject();
  return portfolio;
}

/**
 * 打开账户账本。`writable` 为 false 时以只读方式打开，供 MCP 工具使用；
 * 只读打开不会创建文件。任何路径别名都会在打开前被拒绝。
 */
export function openPortfolioDb(path = portfolioDbPath(), options: { writable?: boolean; marketPath?: string } = {}): DatabaseSync {
  const resolved = assertPortfolioSeparateFromMarket(path, options.marketPath ?? ashareDbPath());
  const writable = options.writable !== false;
  if (writable) {
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    // busy_timeout must come first: the WAL switch below needs a lock, and without the wait it fails at once when
    // another process (the daily job, the MCP server) is writing.
    db.exec('PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(PORTFOLIO_SCHEMA);
    db.exec(PORTFOLIO_LEDGER_SCHEMA);
    db.exec(PORTFOLIO_COMPLETENESS_SCHEMA);
    db.exec(PORTFOLIO_RISK_POLICY_DDL);
    ensurePortfolioV3Schema(db);
    return db;
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 15000;');
  return db;
}

export function inPortfolioTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
