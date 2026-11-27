import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { FundamentalEnvelopeState } from '../ashare/fundamentalRegime.js';
import { portfolioTableExists } from './db.js';
import type { CircuitBreakerStatus } from './strategyRouter.js';

export type FvoStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface ForwardViewOverlayRow {
  overlay_id: string;
  account_id: string;
  created_date: string;
  expires_trade_date: string;
  equity_delta_bps: number;
  invalidation_rule_json: string;
  thesis_summary: string;
  status: FvoStatus;
}

export interface SetForwardViewOverlayInput {
  overlayId?: string;
  accountId: string;
  createdDate: string;
  expiresTradeDate: string;
  equityDeltaBps: number;
  invalidationRuleJson: string;
  thesisSummary: string;
}

export interface EvaluatedFvoState {
  active_row: ForwardViewOverlayRow | null;
  raw_delta_bps: number;
  effective_delta_bps: number;
  attribution_60d_bps: number | null;
  band_halved: boolean;
  max_abs_delta_bps: number;
  zeroed_reason: string | null;
  summary_zh: string;
}

const YMD_RE = /^\d{8}$/;

function countOpenTradeDays(
  marketDb: DatabaseSync | null | undefined,
  fromDate: string,
  toDate: string,
): number {
  if (fromDate >= toDate) return 0;
  if (marketDb && portfolioTableExists(marketDb, 'trade_cal')) {
    const row = marketDb.prepare(
      'SELECT COUNT(*) AS n FROM trade_cal WHERE is_open = 1 AND cal_date > ? AND cal_date <= ?',
    ).get(fromDate, toDate) as { n?: number } | undefined;
    if (row && typeof row.n === 'number') return row.n;
  }
  const ms = Date.UTC(+toDate.slice(0, 4), +toDate.slice(4, 6) - 1, +toDate.slice(6, 8))
    - Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(4, 6) - 1, +fromDate.slice(6, 8));
  return Math.max(0, Math.round(ms / 86_400_000 / 1.48));
}

/**
 * 录入纯标量前瞻主观叠加层（FVO）。
 * 硬校验：±1000bps、TTL<=20 交易日、必填 JSON 证伪条件与摘要，严禁任何 style_tilt 字段。
 */
export function setForwardViewOverlay(
  portfolioDb: DatabaseSync,
  input: SetForwardViewOverlayInput,
  marketDb?: DatabaseSync | null,
): ForwardViewOverlayRow {
  const accountId = input.accountId.trim();
  if (!accountId) throw new Error('fvo_invalid_account_id');
  if (!YMD_RE.test(input.createdDate)) throw new Error('fvo_invalid_created_date');
  if (!YMD_RE.test(input.expiresTradeDate) || input.expiresTradeDate < input.createdDate) {
    throw new Error('fvo_invalid_expires_trade_date');
  }
  if (!Number.isSafeInteger(input.equityDeltaBps) || input.equityDeltaBps < -1000 || input.equityDeltaBps > 1000) {
    throw new Error('fvo_equity_delta_bps_out_of_range');
  }
  const ttlTradeDays = countOpenTradeDays(marketDb, input.createdDate, input.expiresTradeDate);
  if (ttlTradeDays > 20) {
    throw new Error(`fvo_ttl_exceeds_20_trade_days:${ttlTradeDays}`);
  }
  const thesis = input.thesisSummary.trim();
  if (!thesis) throw new Error('fvo_missing_thesis_summary');
  const invRaw = input.invalidationRuleJson.trim();
  if (!invRaw) throw new Error('fvo_missing_invalidation_rule_json');
  let parsedInv: unknown;
  try {
    parsedInv = JSON.parse(invRaw);
  } catch {
    throw new Error('fvo_invalid_invalidation_rule_json');
  }
  if (!parsedInv || typeof parsedInv !== 'object' || Object.keys(parsedInv as Record<string, unknown>).length === 0) {
    throw new Error('fvo_empty_invalidation_rule_json');
  }

  const overlayId = input.overlayId?.trim() || `fvo-${input.createdDate}-${randomUUID().slice(0, 8)}`;
  const row: ForwardViewOverlayRow = {
    overlay_id: overlayId,
    account_id: accountId,
    created_date: input.createdDate,
    expires_trade_date: input.expiresTradeDate,
    equity_delta_bps: input.equityDeltaBps,
    invalidation_rule_json: JSON.stringify(parsedInv),
    thesis_summary: thesis,
    status: 'ACTIVE',
  };

  portfolioDb.exec('BEGIN IMMEDIATE');
  try {
    portfolioDb.prepare(
      "UPDATE forward_view_overlay SET status = 'REVOKED' WHERE account_id = ? AND status = 'ACTIVE'",
    ).run(accountId);
    portfolioDb.prepare(`
      INSERT OR REPLACE INTO forward_view_overlay (
        overlay_id, account_id, created_date, expires_trade_date,
        equity_delta_bps, invalidation_rule_json, thesis_summary, status
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      row.overlay_id,
      row.account_id,
      row.created_date,
      row.expires_trade_date,
      row.equity_delta_bps,
      row.invalidation_rule_json,
      row.thesis_summary,
      row.status,
    );
    portfolioDb.exec('COMMIT');
  } catch (err) {
    portfolioDb.exec('ROLLBACK');
    throw err;
  }
  return row;
}

export function revokeForwardViewOverlay(
  portfolioDb: DatabaseSync,
  options: { accountId: string; overlayId?: string },
): { revoked_count: number; overlay_id: string | null } {
  const accountId = options.accountId.trim();
  if (!accountId) throw new Error('fvo_invalid_account_id');
  const info = options.overlayId?.trim()
    ? portfolioDb.prepare(
        "UPDATE forward_view_overlay SET status = 'REVOKED' WHERE account_id = ? AND overlay_id = ? AND status = 'ACTIVE'",
      ).run(accountId, options.overlayId.trim())
    : portfolioDb.prepare(
        "UPDATE forward_view_overlay SET status = 'REVOKED' WHERE account_id = ? AND status = 'ACTIVE'",
      ).run(accountId);
  return {
    revoked_count: Number(info.changes ?? 0),
    overlay_id: options.overlayId?.trim() ?? null,
  };
}

export function listForwardViewOverlays(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
  options: { activeOnly?: boolean } = {},
): ForwardViewOverlayRow[] {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'forward_view_overlay')) return [];
  const sql = options.activeOnly
    ? "SELECT * FROM forward_view_overlay WHERE account_id = ? AND status = 'ACTIVE' ORDER BY created_date DESC, rowid DESC"
    : 'SELECT * FROM forward_view_overlay WHERE account_id = ? ORDER BY created_date DESC, rowid DESC';
  return portfolioDb.prepare(sql).all(accountId) as unknown as ForwardViewOverlayRow[];
}

export interface EvaluateFvoInput {
  portfolioDb?: DatabaseSync | null;
  accountId: string;
  asOf: string;
  circuitBreakerStatus: CircuitBreakerStatus;
  hwmDrawdownBps: number;
  workHwmDrawdownBps: number;
  b1State: FundamentalEnvelopeState;
  attribution60dBps?: number | null;
  /** 可选直接注入（用于黄金夹具测试，不写库）。 */
  overrideOverlay?: Partial<ForwardViewOverlayRow> | null;
}

/**
 * 纯标量 FVO 评估与硬护栏截断：
 * 1) 默认 0；
 * 2) 过期自动归零；
 * 3) P0 >= 8%（含 L1/L2）或 EXTREME_BUBBLE 时正向 FVO 强制归零；
 * 4) 60d 归因 <= -150bps 时带宽减半至 ±500bps。
 */
export function evaluateForwardViewOverlay(input: EvaluateFvoInput): EvaluatedFvoState {
  let row: ForwardViewOverlayRow | null = null;
  if (input.overrideOverlay !== undefined) {
    if (input.overrideOverlay && input.overrideOverlay.status !== 'REVOKED') {
      row = {
        overlay_id: input.overrideOverlay.overlay_id ?? 'fvo-override',
        account_id: input.overrideOverlay.account_id ?? input.accountId,
        created_date: input.overrideOverlay.created_date ?? input.asOf,
        expires_trade_date: input.overrideOverlay.expires_trade_date ?? input.asOf,
        equity_delta_bps: Number(input.overrideOverlay.equity_delta_bps ?? 0),
        invalidation_rule_json: input.overrideOverlay.invalidation_rule_json ?? '{}',
        thesis_summary: input.overrideOverlay.thesis_summary ?? '测试注入叠加层',
        status: (input.overrideOverlay.status ?? 'ACTIVE') as FvoStatus,
      };
    }
  } else if (input.portfolioDb && portfolioTableExists(input.portfolioDb, 'forward_view_overlay')) {
    const active = input.portfolioDb.prepare(`
      SELECT * FROM forward_view_overlay
      WHERE account_id = ? AND status = 'ACTIVE' AND created_date <= ?
      ORDER BY created_date DESC, rowid DESC
      LIMIT 1
    `).get(input.accountId, input.asOf) as ForwardViewOverlayRow | undefined;
    if (active) row = active;
  }

  const attr60 = input.attribution60dBps ?? null;
  const bandHalved = attr60 !== null && Number.isFinite(attr60) && attr60 <= -150;
  const maxAbs = bandHalved ? 500 : 1000;

  if (!row || row.status !== 'ACTIVE' || row.equity_delta_bps === 0) {
    return {
      active_row: row,
      raw_delta_bps: 0,
      effective_delta_bps: 0,
      attribution_60d_bps: attr60,
      band_halved: bandHalved,
      max_abs_delta_bps: maxAbs,
      zeroed_reason: null,
      summary_zh: '0 主观偏移，纯系统运行',
    };
  }

  const raw = Math.trunc(row.equity_delta_bps);
  if (input.asOf > row.expires_trade_date || input.asOf < row.created_date) {
    return {
      active_row: row,
      raw_delta_bps: raw,
      effective_delta_bps: 0,
      attribution_60d_bps: attr60,
      band_halved: bandHalved,
      max_abs_delta_bps: maxAbs,
      zeroed_reason: 'EXPIRED',
      summary_zh: '0 主观偏移，纯系统运行（前瞻主观偏移已到期自动归零）',
    };
  }

  let eff = Math.max(-maxAbs, Math.min(maxAbs, raw));
  let zeroedReason: string | null = null;
  const p0Hit = input.circuitBreakerStatus !== 'NORMAL'
    || input.hwmDrawdownBps >= 800
    || input.workHwmDrawdownBps >= 800;

  if (eff > 0 && p0Hit) {
    eff = 0;
    zeroedReason = 'P0_L1_OR_LOCK';
  } else if (eff > 0 && input.b1State === 'EXTREME_BUBBLE') {
    eff = 0;
    zeroedReason = 'EXTREME_BUBBLE';
  }

  const sign = eff >= 0 ? '+' : '';
  const summaryZh = eff === 0
    ? (zeroedReason === 'P0_L1_OR_LOCK'
        ? '0 主观偏移，纯系统运行（账户回撤达警戒线，正向偏移已强制归零）'
        : zeroedReason === 'EXTREME_BUBBLE'
          ? '0 主观偏移，纯系统运行（估值处于历史极端泡沫，正向偏移已强制归零）'
          : '0 主观偏移，纯系统运行')
    : `前瞻主观标量偏移 ${sign}${(eff / 100).toFixed(1)}%（有效至 ${row.expires_trade_date}${bandHalved ? '；近60日归因触发带宽减半至±5%' : ''}）`;

  return {
    active_row: row,
    raw_delta_bps: raw,
    effective_delta_bps: eff,
    attribution_60d_bps: attr60,
    band_halved: bandHalved,
    max_abs_delta_bps: maxAbs,
    zeroed_reason: zeroedReason,
    summary_zh: summaryZh,
  };
}
