import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { portfolioDbPath } from './db.js';

/**
 * 每日行动简报缓存（chat 定时任务专用）。
 *
 * 完整 `buildDailyReport` 在生产全市场库上需要数分钟，且研究 bundle 可达数十 MB；
 * 把它直接放进聊天工具的请求路径会触发客户端 DEADLINE_EXCEEDED。每日流水线在收盘后
 * 预生成这份 compact brief，私有 MCP 的 `ashare_portfolio_daily_brief` 只读缓存，
 * 毫秒级返回；缓存未生成时快速返回 not_ready，绝不重算或等待。
 */
export const DAILY_BRIEF_SCHEMA = 'ashare-daily-brief/1.0';

export function dailyBriefDir(dbPath?: string): string {
  const explicit = process.env.ASHARE_DAILY_BRIEF_DIR?.trim();
  if (explicit) return explicit;
  return join(dirname(dbPath ?? portfolioDbPath()), 'daily-briefs');
}

export function dailyBriefPath(date: string, dbPath?: string): string {
  return join(dailyBriefDir(dbPath), `${date}.json`);
}

/** 把完整日报投影成聊天可消费的 compact brief；不复制大数组字段（候选/研究证据）。 */
export function buildDailyBrief(report: any): Record<string, any> {
  return {
    schema: DAILY_BRIEF_SCHEMA,
    brief_source: 'generated',
    report_schema: report?.schema ?? null,
    report_id: report?.report_id ?? null,
    as_of_trade_date: report?.as_of_trade_date ?? null,
    expected_next_trade_date: report?.expected_next_trade_date ?? null,
    status: report?.status ?? null,
    actionable: report?.actionable ?? false,
    generated_at: report?.timestamps?.generated_at ?? report?.generated_at ?? null,
    account_id: report?.account_id ?? null,
    account_id_source: report?.account_id_source ?? null,
    account_status: report?.account_status ?? null,
    first_section: report?.first_section ?? null,
    execution_plan: report?.execution_plan ?? null,
    v3_cockpit: report?.v3_cockpit ?? null,
    market_judgement: report?.market_judgement ?? null,
    holdings: report?.holdings ?? [],
    concentration: report?.concentration ?? null,
    data_quality: report?.data_quality ?? null,
  };
}

/** 原子写入：同目录临时文件 + rename，权限 0600；绝不写半截 JSON。 */
export function writeDailyBrief(path: string, brief: Record<string, any>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(brief, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readDailyBrief(path: string): Record<string, any> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== DAILY_BRIEF_SCHEMA) return null;
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

export function latestDailyBriefDate(dbPath?: string): string | null {
  try {
    const dir = dailyBriefDir(dbPath);
    if (!existsSync(dir)) return null;
    const dates = readdirSync(dir)
      .filter(name => /^\d{8}\.json$/.test(name))
      .map(name => name.slice(0, 8))
      .sort();
    return dates.at(-1) ?? null;
  } catch {
    return null;
  }
}
