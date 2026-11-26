import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ashareDbPath, getAshareDb } from '../ashare/db.js';
import { fetchTencentQuotes, type TencentQuoteRow } from '../ashare/providers/tencentClient.js';
import { isExchangeFundCode, parseTsCode, roundTo } from '../ashare/providers/types.js';
import { accountSummary } from './account.js';
import { resolveAccountId, resolveAccountSnapshot, resolveAccountState } from './accounts.js';
import { dailyBriefDir, readDailyBrief } from './dailyBrief.js';
import { openPortfolioDb, portfolioDbPath, portfolioEnabled, portfolioTableExists } from './db.js';
import { loadApprovedV3Policy } from './v3Policy.js';

export const MIDDAY_CHECK_SCHEMA = 'ashare-intraday-midday-check/1.0';
export const MIDDAY_CHECK_TOOL = 'ashare_intraday_midday_check';

export type SessionPhase =
  | 'CLOSED_HOLIDAY'
  | 'PRE_OPEN'
  | 'OPEN_AUCTION'
  | 'MORNING_TRADING'
  | 'MIDDAY_BREAK'
  | 'AFTERNOON_TRADING'
  | 'CLOSING_AUCTION'
  | 'POST_CLOSE';

export interface MiddayCheckOptions {
  portfolioDb: DatabaseSync;
  marketDb: DatabaseSync | null;
  accountId?: string;
  extraCodes?: string[];
  briefDir?: string;
  nowMs?: number;
  fetchQuotes?: (codes: readonly string[]) => Promise<Map<string, TencentQuoteRow>>;
}

interface EodRefMetrics {
  last_date: string | null;
  last_close_cny: number | null;
  ma5_cny: number | null;
  ma20_cny: number | null;
  ma60_cny: number | null;
  avg_amount_20d_qian: number | null;
}

interface FundNavInfo {
  unit_nav: number;
  nav_date: string;
  lag_trade_days: number | null;
}

const VALID_TS_CODE = /^\d{6}\.(SH|SZ|BJ)$/;

const ANCHOR_DEFS = [
  { ts_code: '000300.SH', name: '沪深300', role: 'VALUE_ANCHOR' },
  { ts_code: '000905.SH', name: '中证500', role: 'GROWTH_ANCHOR' },
  { ts_code: '399006.SZ', name: '创业板指', role: 'GROWTH_ANCHOR' },
] as const;

function shanghaiClock(nowMs: number) {
  const iso = new Date(nowMs + 8 * 3600_000).toISOString();
  const dateYmd = iso.slice(0, 10).replace(/-/g, '');
  const timeHms = iso.slice(11, 19);
  const hhmm = Number(timeHms.slice(0, 2)) * 100 + Number(timeHms.slice(3, 5));
  const minuteOfDay = Number(timeHms.slice(0, 2)) * 60 + Number(timeHms.slice(3, 5));
  return {
    date_ymd: dateYmd,
    time_hms: timeHms,
    hhmm,
    minute_of_day: minuteOfDay,
    iso_shanghai: `${iso.slice(0, 19)}+08:00`,
  };
}

function classifySessionPhase(hhmm: number): SessionPhase {
  if (hhmm < 915) return 'PRE_OPEN';
  if (hhmm < 930) return 'OPEN_AUCTION';
  if (hhmm <= 1130) return 'MORNING_TRADING';
  if (hhmm < 1300) return 'MIDDAY_BREAK';
  if (hhmm < 1457) return 'AFTERNOON_TRADING';
  if (hhmm <= 1500) return 'CLOSING_AUCTION';
  return 'POST_CLOSE';
}

/**
 * 估算当前时点在全天 240 分钟连续竞价中的累计成交进度比例，
 * 避免上午开盘/午休时把半天成交额误判成“全天缩量”。
 */
function expectedIntradayVolumeFraction(phase: SessionPhase, minuteOfDay: number): number | null {
  if (phase === 'PRE_OPEN' || phase === 'OPEN_AUCTION' || phase === 'CLOSED_HOLIDAY') return null;
  if (phase === 'MIDDAY_BREAK') return 0.55; // 上午通常略偏集中（经验权重约 55%）
  if (phase === 'POST_CLOSE' || phase === 'CLOSING_AUCTION') return 1;
  if (phase === 'MORNING_TRADING') {
    const elapsed = Math.max(5, Math.min(120, minuteOfDay - 570));
    return Math.max(0.05, (elapsed / 240) * 1.1);
  }
  const elapsedPm = Math.max(1, Math.min(120, minuteOfDay - 780));
  return Math.min(1, 0.55 + (elapsedPm / 240) * 0.9);
}

function marketTableExists(db: DatabaseSync | null, name: string): boolean {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function readTradeDayStatus(marketDb: DatabaseSync | null, dateYmd: string): { isOpen: boolean | null; nextTradeDay: string | null } {
  if (!marketTableExists(marketDb, 'trade_cal')) return { isOpen: null, nextTradeDay: null };
  const row = marketDb!.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(dateYmd) as { is_open?: number } | undefined;
  if (!row || row.is_open === undefined || row.is_open === null) return { isOpen: null, nextTradeDay: null };
  const isOpen = Number(row.is_open) === 1;
  const next = isOpen
    ? null
    : ((marketDb!.prepare('SELECT MIN(cal_date) AS d FROM trade_cal WHERE cal_date > ? AND is_open = 1').get(dateYmd) as { d?: string } | undefined)?.d ?? null);
  return { isOpen, nextTradeDay: next };
}

function avgLast(nums: number[], count: number): number | null {
  if (nums.length < count) return null;
  const slice = nums.slice(0, count);
  return roundTo(slice.reduce((a, b) => a + b, 0) / slice.length, 4);
}

function isEtfOrFundCode(tsCode: string): boolean {
  const { code, suffix } = parseTsCode(tsCode);
  return isExchangeFundCode(code, suffix);
}

function readEodRefMetrics(marketDb: DatabaseSync | null, tsCode: string, beforeDate: string, isIndex = false): EodRefMetrics {
  const empty: EodRefMetrics = { last_date: null, last_close_cny: null, ma5_cny: null, ma20_cny: null, ma60_cny: null, avg_amount_20d_qian: null };
  if (!marketDb) return empty;
  const table = isIndex ? 'index_daily' : (isEtfOrFundCode(tsCode) ? 'fund_daily' : 'daily');
  if (!marketTableExists(marketDb, table)) return empty;
  try {
    const rows = marketDb.prepare(
      `SELECT trade_date, close, amount FROM ${table} WHERE ts_code = ? AND trade_date < ? AND close > 0 ORDER BY trade_date DESC LIMIT 60`,
    ).all(tsCode, beforeDate) as Array<{ trade_date: string; close: number; amount: number | null }>;
    if (!rows.length) return empty;
    const closes = rows.map(r => Number(r.close));
    const amt20 = rows.slice(0, 20).map(r => r.amount).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    return {
      last_date: rows[0].trade_date,
      last_close_cny: roundTo(closes[0], 4),
      ma5_cny: avgLast(closes, 5),
      ma20_cny: avgLast(closes, 20),
      ma60_cny: avgLast(closes, 60),
      avg_amount_20d_qian: amt20.length >= 5 ? roundTo(amt20.reduce((a, b) => a + b, 0) / amt20.length, 2) : null,
    };
  } catch {
    return empty;
  }
}

function readLatestFundNav(marketDb: DatabaseSync | null, tsCode: string, asOfDate: string): FundNavInfo | null {
  if (!marketTableExists(marketDb, 'fund_nav')) return null;
  try {
    const row = marketDb!.prepare(
      'SELECT nav_date, unit_nav FROM fund_nav WHERE ts_code = ? AND unit_nav > 0 ORDER BY nav_date DESC LIMIT 1',
    ).get(tsCode) as { nav_date?: string; unit_nav?: number } | undefined;
    if (!row?.nav_date || !Number.isFinite(row.unit_nav)) return null;
    let lagDays: number | null = null;
    if (marketTableExists(marketDb, 'trade_cal')) {
      const lagRow = marketDb!.prepare(
        'SELECT COUNT(*) AS n FROM trade_cal WHERE cal_date > ? AND cal_date <= ? AND is_open = 1',
      ).get(row.nav_date, asOfDate) as { n?: number } | undefined;
      lagDays = Number(lagRow?.n ?? 0);
    }
    return { unit_nav: Number(row.unit_nav), nav_date: row.nav_date, lag_trade_days: lagDays };
  } catch {
    return null;
  }
}

function readLatestBriefFromDir(dirOverride?: string): { date: string | null; brief: Record<string, any> | null } {
  const dir = dirOverride ?? dailyBriefDir();
  try {
    if (!existsSync(dir)) return { date: null, brief: null };
    const dates = readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).map(n => n.slice(0, 8)).sort();
    const latest = dates.at(-1) ?? null;
    if (!latest) return { date: null, brief: null };
    return { date: latest, brief: readDailyBrief(join(dir, `${latest}.json`)) };
  } catch {
    return { date: null, brief: null };
  }
}

function sanitizeExtraCodes(raw?: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const code = String(item ?? '').trim().toUpperCase();
    if (!VALID_TS_CODE.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= 10) break;
  }
  return out;
}

function pctDiff(current: number | null, ref: number | null): number | null {
  if (current === null || ref === null || !Number.isFinite(current) || !Number.isFinite(ref) || ref <= 0) return null;
  return roundTo(((current - ref) / ref) * 100, 2);
}

/**
 * 生成纯只读盘中/午间执行与风控核对报告：
 * - 非交易日立即返回休市状态且不抓实时行情；
 * - 实时拉取腾讯行情对标大盘双锚、账户回撤红线、昨夜买单高开防追与持仓止损/磨底触发线；
 * - 严禁写入任何数据库表或产生前瞻记录。
 */
export async function buildIntradayMiddayCheck(opts: MiddayCheckOptions): Promise<Record<string, any>> {
  const clock = shanghaiClock(opts.nowMs ?? Date.now());
  const sessionPhase = classifySessionPhase(clock.hhmm);
  const cal = readTradeDayStatus(opts.marketDb, clock.date_ymd);

  if (cal.isOpen === false) {
    return {
      schema: MIDDAY_CHECK_SCHEMA,
      status: 'NON_TRADING_DAY',
      read_only: true,
      shanghai_date: clock.date_ymd,
      shanghai_time: clock.iso_shanghai,
      is_trade_day: false,
      session_phase: 'CLOSED_HOLIDAY',
      next_trade_day: cal.nextTradeDay,
      message_zh: `今日（${clock.date_ymd}）为 A 股非交易日，不产生盘中/下午操作，下一交易日为 ${cal.nextTradeDay ?? '未知'}。`,
    };
  }

  const account = resolveAccountId(opts.portfolioDb, opts.accountId);
  const resolved = resolveAccountSnapshot(opts.portfolioDb, account.account_id);
  const state = resolveAccountState(opts.portfolioDb, account.account_id, clock.date_ymd, resolved.snapshot_id);
  const summary = accountSummary(state.snapshot);
  const policy = loadApprovedV3Policy({ accountId: account.account_id, asOf: clock.date_ymd });

  const riskAnchor = portfolioTableExists(opts.portfolioDb, 'account_risk_anchor')
    ? (opts.portfolioDb.prepare('SELECT * FROM account_risk_anchor WHERE account_id = ?').get(account.account_id) as Record<string, any> | undefined)
    : undefined;

  const deconcPlan = portfolioTableExists(opts.portfolioDb, 'deconcentration_plan')
    ? (opts.portfolioDb.prepare("SELECT * FROM deconcentration_plan WHERE account_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get(account.account_id) as Record<string, any> | undefined)
    : undefined;

  const deconcTranches = deconcPlan && portfolioTableExists(opts.portfolioDb, 'deconcentration_tranche')
    ? (opts.portfolioDb.prepare('SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC').all(deconcPlan.plan_id) as Array<Record<string, any>>)
    : [];

  const stopMap = new Map<string, number>();
  if (portfolioTableExists(opts.portfolioDb, 'position_stop_tracker')) {
    const stops = opts.portfolioDb.prepare("SELECT ts_code, current_stop_milli FROM position_stop_tracker WHERE account_id = ? AND status = 'OPEN'").all(account.account_id) as Array<{ ts_code: string; current_stop_milli: number }>;
    for (const s of stops) {
      if (Number.isFinite(s.current_stop_milli) && s.current_stop_milli > 0) stopMap.set(s.ts_code, s.current_stop_milli);
    }
  }

  const { date: latestBriefDate, brief } = readLatestBriefFromDir(opts.briefDir);
  const briefDilutedCost = new Map<string, number>();
  for (const h of Array.isArray(brief?.holdings) ? brief.holdings : []) {
    if (h?.ts_code && Number.isFinite(h?.diluted_cost_per_share)) {
      briefDilutedCost.set(String(h.ts_code), Number(h.diluted_cost_per_share));
    }
  }

  const extraCodes = sanitizeExtraCodes(opts.extraCodes);
  const codeSet = new Set<string>(ANCHOR_DEFS.map(a => a.ts_code));
  for (const pos of state.snapshot.positions) {
    if (pos.quantity > 0 && VALID_TS_CODE.test(pos.ts_code)) codeSet.add(pos.ts_code);
  }
  const plannedActions: Array<Record<string, any>> = Array.isArray(brief?.first_section?.actions) ? brief.first_section.actions : [];
  for (const act of plannedActions) {
    for (const leg of Array.isArray(act?.legs) ? act.legs : []) {
      const c = String(leg?.ts_code ?? '').trim().toUpperCase();
      if (VALID_TS_CODE.test(c)) codeSet.add(c);
    }
  }
  const crossBorderMonitors: Array<Record<string, any>> = Array.isArray(brief?.v3_cockpit?.cross_border_monitor) ? brief.v3_cockpit.cross_border_monitor : [];
  for (const cb of crossBorderMonitors) {
    const c = String(cb?.ts_code ?? '').trim().toUpperCase();
    if (VALID_TS_CODE.test(c)) codeSet.add(c);
  }
  const stockCandidates: Array<Record<string, any>> = Array.isArray(brief?.v3_cockpit?.stock_swing_candidates) ? brief.v3_cockpit.stock_swing_candidates : [];
  for (const sc of stockCandidates) {
    const c = String(sc?.ts_code ?? '').trim().toUpperCase();
    if (VALID_TS_CODE.test(c)) codeSet.add(c);
  }
  if (deconcPlan?.ts_code && VALID_TS_CODE.test(String(deconcPlan.ts_code))) codeSet.add(String(deconcPlan.ts_code));
  if (policy.defensive_bond_reservoir_etf && VALID_TS_CODE.test(policy.defensive_bond_reservoir_etf)) codeSet.add(policy.defensive_bond_reservoir_etf);
  for (const c of extraCodes) codeSet.add(c);

  let quoteMap: Map<string, TencentQuoteRow>;
  try {
    quoteMap = await (opts.fetchQuotes ?? fetchTencentQuotes)([...codeSet]);
  } catch (err: any) {
    return {
      schema: MIDDAY_CHECK_SCHEMA,
      status: 'QUOTE_UNAVAILABLE',
      read_only: true,
      shanghai_date: clock.date_ymd,
      shanghai_time: clock.iso_shanghai,
      is_trade_day: cal.isOpen,
      session_phase: sessionPhase,
      account_id: account.account_id,
      error: String(err?.message ?? err),
      message_zh: '实时行情拉取失败，未伪造盘中价格，请稍后重试。',
    };
  }

  let todayQuoteCount = 0;
  for (const q of quoteMap.values()) {
    if (q.trade_date === clock.date_ymd && q.close !== null && q.close > 0) todayQuoteCount++;
  }
  const quoteFreshForToday = todayQuoteCount > 0;
  const volFraction = expectedIntradayVolumeFraction(sessionPhase, clock.minute_of_day);

  // 1. 大盘双锚盘中温度
  const marketAnchors = ANCHOR_DEFS.map(def => {
    const q = quoteMap.get(def.ts_code);
    const eod = readEodRefMetrics(opts.marketDb, def.ts_code, clock.date_ymd, true);
    const livePrice = q?.close ?? null;
    const estPaceRatio = q?.amount != null && eod.avg_amount_20d_qian && eod.avg_amount_20d_qian > 0 && volFraction
      ? roundTo((q.amount / volFraction) / eod.avg_amount_20d_qian, 2)
      : null;
    return {
      ts_code: def.ts_code,
      name: q?.name || def.name,
      role: def.role,
      quote_date: q?.trade_date ?? null,
      quote_time: q?.quote_time ?? null,
      live_price: livePrice,
      open: q?.open ?? null,
      high: q?.high ?? null,
      low: q?.low ?? null,
      pre_close: q?.pre_close ?? eod.last_close_cny,
      pct_chg: q?.pct_chg ?? pctDiff(livePrice, q?.pre_close ?? eod.last_close_cny),
      amount_yi: q?.amount != null ? roundTo(q.amount / 100000, 2) : null,
      ma20: eod.ma20_cny,
      ma60: eod.ma60_cny,
      dist_to_ma20_pct: pctDiff(livePrice, eod.ma20_cny),
      dist_to_ma60_pct: pctDiff(livePrice, eod.ma60_cny),
      midday_volume_pace_ratio: estPaceRatio,
    };
  });
  const hs300Pct = marketAnchors[0]?.pct_chg ?? null;
  const csi500Pct = marketAnchors[1]?.pct_chg ?? null;
  const chinextPct = marketAnchors[2]?.pct_chg ?? null;
  const extremeCrashWarning = hs300Pct !== null && hs300Pct <= -3.5
    && ((csi500Pct !== null && csi500Pct <= -3.5) || (chinextPct !== null && chinextPct <= -3.5));

  // 2. 按最新市价重估账户资产
  const cashCents = summary.totals.cash_cents;
  const wealthCents = summary.totals.wealth_cents;
  let liveHoldingsCents = 0;
  let live159558Cents = 0;

  const holdingValuation = state.snapshot.positions
    .filter(p => p.quantity > 0)
    .map(p => {
      const q = quoteMap.get(p.ts_code);
      const hasLive = q?.close !== null && q?.close !== undefined && q.close > 0;
      const livePrice = hasLive ? q!.close! : roundTo(p.ref_price_milli / 1000, 3);
      const mvCents = Math.round(livePrice * p.quantity * 100);
      liveHoldingsCents += mvCents;
      if (p.ts_code === (deconcPlan?.ts_code ?? '159558.SZ')) live159558Cents = mvCents;
      return { pos: p, q, hasLive, livePrice, mvCents };
    });

  const liveTotalAssetsCents = cashCents + wealthCents + liveHoldingsCents;
  const liveInvestableNavCents = cashCents + liveHoldingsCents;
  const hwmNavScope: 'INVESTABLE' | 'TOTAL' = riskAnchor?.hwm_nav_scope === 'INVESTABLE' ? 'INVESTABLE' : 'TOTAL';
  const navForHwmCents = hwmNavScope === 'INVESTABLE' ? liveInvestableNavCents : liveTotalAssetsCents;
  const denomForWeightCents = hwmNavScope === 'INVESTABLE' ? liveInvestableNavCents : liveTotalAssetsCents;

  const hwmNavCents: number | null = riskAnchor?.hwm_nav_cents
    ? Number(riskAnchor.hwm_nav_cents)
    : (Number.isFinite(brief?.v3_cockpit?.router?.hwm_nav_cents) ? Number(brief!.v3_cockpit!.router!.hwm_nav_cents) : null);
  const initialPrincipalCents = riskAnchor?.initial_principal_cents
    ? Number(riskAnchor.initial_principal_cents)
    : 10_000_000;

  const live159558WeightPct = denomForWeightCents > 0 ? roundTo((live159558Cents / denomForWeightCents) * 100, 2) : 0;
  const targetKeepShares = deconcPlan && deconcPlan.anchor_price_milli > 0
    ? Math.floor(((navForHwmCents * (Number(deconcPlan.target_keep_bps) / 10000)) / (Number(deconcPlan.anchor_price_milli) / 10)) / 100) * 100
    : 0;
  const deconcCurrentShares = deconcPlan
    ? (holdingValuation.find(h => h.pos.ts_code === deconcPlan.ts_code)?.pos.quantity ?? 0)
    : 0;
  const deconcExcessShares = Math.max(0, Math.floor((deconcCurrentShares - targetKeepShares) / 100) * 100);
  const deconcPreemptiveActive = Boolean(
    deconcPlan && (live159558WeightPct > 30 || deconcExcessShares >= 100),
  );

  const l1TriggerPct = roundTo(policy.l1_warn_drawdown_bps / 100, 2);
  const l2TriggerPct = deconcPreemptiveActive
    ? roundTo(policy.l2_preemptive_deconcentration_trigger_drawdown_bps / 100, 2)
    : roundTo(policy.l2_normal_trigger_drawdown_bps / 100, 2);

  const liveHwmDrawdownPct = hwmNavCents && hwmNavCents > 0
    ? roundTo(Math.max(0, ((hwmNavCents - navForHwmCents) / hwmNavCents) * 100), 2)
    : null;
  const lifelineNavCents = hwmNavCents && hwmNavCents > 0
    ? Math.round(hwmNavCents * (1 - l2TriggerPct / 100))
    : null;

  let liveBreakerAlert: 'BREACHED_L2' | 'NEAR_L2' | 'BREACHED_L1' | 'NEAR_L1' | 'NORMAL' = 'NORMAL';
  if (liveHwmDrawdownPct !== null) {
    if (liveHwmDrawdownPct >= l2TriggerPct) liveBreakerAlert = 'BREACHED_L2';
    else if (liveHwmDrawdownPct >= l2TriggerPct - 2) liveBreakerAlert = 'NEAR_L2';
    else if (liveHwmDrawdownPct >= l1TriggerPct) liveBreakerAlert = 'BREACHED_L1';
    else if (liveHwmDrawdownPct >= l1TriggerPct - 2) liveBreakerAlert = 'NEAR_L1';
  }

  const toPrincipalGapCents = Math.max(0, initialPrincipalCents - liveTotalAssetsCents);
  const toPrincipalReturnPct = liveTotalAssetsCents > 0 && toPrincipalGapCents > 0
    ? roundTo((toPrincipalGapCents / liveTotalAssetsCents) * 100, 2)
    : 0;

  // 3. 昨夜日报动作盘中核对（防追高 +2%、跨境溢价 +2.5%）
  const plannedActionsCheck = plannedActions.map(act => {
    const legs = (Array.isArray(act?.legs) ? act.legs : []).map((leg: any) => {
      const tsCode = String(leg?.ts_code ?? '').trim().toUpperCase();
      const q = quoteMap.get(tsCode);
      const refPrice = Number.isFinite(leg?.price_milli) ? roundTo(Number(leg.price_milli) / 1000, 4) : null;
      const livePrice = q?.close ?? null;
      const gapFromRefPct = pctDiff(livePrice, refPrice);
      const openGapPct = pctDiff(q?.open ?? null, q?.pre_close ?? refPrice);
      const side = String(leg?.side ?? '').toUpperCase();
      const isEtf = isEtfOrFundCode(tsCode);
      const nav = isEtf ? readLatestFundNav(opts.marketDb, tsCode, clock.date_ymd) : null;
      const livePremiumPct = nav ? pctDiff(livePrice, nav.unit_nav) : null;
      const premiumBlocked = Boolean(
        (livePremiumPct !== null && livePremiumPct > 2.5)
        || (nav?.lag_trade_days !== null && nav?.lag_trade_days !== undefined && nav.lag_trade_days > 3),
      );

      let executionCheck: string;
      if (livePrice === null) {
        executionCheck = 'QUOTE_MISSING';
      } else if (side === 'BUY') {
        if (premiumBlocked) executionCheck = 'BLOCKED_ETF_PREMIUM_OR_STALE_NAV';
        else if (gapFromRefPct !== null && gapFromRefPct > 2) executionCheck = 'SKIP_CHASE_ABOVE_2PCT';
        else if (gapFromRefPct !== null && gapFromRefPct > 1) executionCheck = 'CAUTION_NEAR_2PCT';
        else executionCheck = 'WITHIN_BUY_ZONE';
      } else {
        executionCheck = 'SELL_CHECK_ORDER';
      }

      return {
        side,
        ts_code: tsCode,
        name: q?.name || leg?.name || tsCode,
        quantity: Number(leg?.quantity ?? 0),
        ref_price_cny: refPrice,
        live_price_cny: livePrice,
        quote_date: q?.trade_date ?? null,
        quote_time: q?.quote_time ?? null,
        gap_from_ref_pct: gapFromRefPct,
        open_gap_pct: openGapPct,
        live_est_amount_cents: livePrice !== null && Number.isFinite(leg?.quantity) ? Math.round(livePrice * Number(leg.quantity) * 100) : null,
        unit_nav: nav?.unit_nav ?? null,
        nav_date: nav?.nav_date ?? null,
        nav_lag_trade_days: nav?.lag_trade_days ?? null,
        live_premium_pct: livePremiumPct,
        premium_blocked: isEtf ? premiumBlocked : false,
        execution_check: executionCheck,
      };
    });
    return {
      priority: act?.priority ?? null,
      code: act?.code ?? null,
      kind: act?.kind ?? null,
      title: act?.title ?? null,
      legs,
    };
  });

  // 4. 持仓午间防线巡检
  const pendingTranche = deconcTranches.find(t => t.status === 'PENDING' || t.status === 'TRIGGERED') ?? null;
  const holdingsCheck = holdingValuation.map(({ pos, q, hasLive, livePrice, mvCents }) => {
    const eod = readEodRefMetrics(opts.marketDb, pos.ts_code, clock.date_ymd, false);
    const isEtf = isEtfOrFundCode(pos.ts_code);
    const nav = isEtf ? readLatestFundNav(opts.marketDb, pos.ts_code, clock.date_ymd) : null;
    const dilutedCost = briefDilutedCost.get(pos.ts_code) ?? roundTo(pos.ref_cost_milli / 1000, 3);
    const liveWeightPct = denomForWeightCents > 0 ? roundTo((mvCents / denomForWeightCents) * 100, 2) : 0;
    const hardStopMilli = stopMap.get(pos.ts_code) ?? (!isEtf ? Math.round(dilutedCost * 1000 * 0.92) : null);
    const hardStopCny = hardStopMilli ? roundTo(hardStopMilli / 1000, 3) : null;

    const flags: string[] = [];
    if (!isEtf && hardStopCny !== null && livePrice <= hardStopCny) {
      flags.push('STOP_BREACHED_INTRADAY_WATCH_CLOSE');
    }
    if (!isEtf && eod.ma20_cny !== null && livePrice < eod.ma20_cny) {
      flags.push('BELOW_MA20_WATCH_CLOSE');
    }

    let deconcLevels: Record<string, any> | null = null;
    if (deconcPlan && pos.ts_code === deconcPlan.ts_code) {
      const refMilli = Number(deconcPlan.last_exec_price_milli ?? deconcPlan.anchor_price_milli);
      const supportFloor = deconcPlan.support_floor_milli ? roundTo(Number(deconcPlan.support_floor_milli) / 1000, 3) : null;
      const deepBreak = supportFloor !== null ? roundTo(supportFloor * 0.96, 3) : null;
      const rebound8Pct = roundTo((refMilli * 1.08) / 1000, 3);
      if (supportFloor !== null && livePrice < supportFloor) {
        flags.push(deepBreak !== null && livePrice <= deepBreak ? 'DEEP_BELOW_SUPPORT_FLOOR' : 'BELOW_SUPPORT_FLOOR_WATCH_CLOSE');
      }
      if (livePrice >= rebound8Pct) flags.push('ABOVE_REBOUND_8PCT_TARGET');
      if (liveWeightPct >= 34) flags.push('OVERWEIGHT_DRIFT_34PCT');
      deconcLevels = {
        plan_mode: deconcPlan.plan_mode,
        reference_price_cny: roundTo(refMilli / 1000, 3),
        rebound_8pct_target_cny: rebound8Pct,
        support_floor_cny: supportFloor,
        deep_break_cny: deepBreak,
        drift_harvest_trigger_pct: 34,
        next_tranche: pendingTranche ? {
          tranche_no: pendingTranche.tranche_no,
          status: pendingTranche.status,
          planned_shares: pendingTranche.planned_shares,
          trigger_reason: pendingTranche.trigger_reason ?? null,
        } : null,
      };
    }

    return {
      ts_code: pos.ts_code,
      name: q?.name || pos.name,
      is_etf: isEtf,
      quantity: pos.quantity,
      price_source: hasLive ? 'tencent_live' : 'fallback_cache_close',
      quote_date: q?.trade_date ?? null,
      quote_time: q?.quote_time ?? null,
      live_price_cny: livePrice,
      pct_chg: q?.pct_chg ?? null,
      live_market_value_cents: mvCents,
      live_weight_pct: liveWeightPct,
      diluted_cost_cny: dilutedCost,
      unrealized_pnl_pct: pctDiff(livePrice, dilutedCost),
      ma5_cny: eod.ma5_cny,
      ma20_cny: eod.ma20_cny,
      ma60_cny: eod.ma60_cny,
      dist_to_ma20_pct: pctDiff(livePrice, eod.ma20_cny),
      hard_stop_cny: hardStopCny,
      dist_to_hard_stop_pct: pctDiff(livePrice, hardStopCny),
      unit_nav: nav?.unit_nav ?? null,
      nav_date: nav?.nav_date ?? null,
      etf_live_premium_pct: nav ? pctDiff(livePrice, nav.unit_nav) : null,
      deconcentration_levels: deconcLevels,
      intraday_flags: flags,
    };
  });

  // 5. 跨境 ETF 实时溢价监控
  const crossBorderCheck = crossBorderMonitors.map(cb => {
    const tsCode = String(cb?.ts_code ?? '').trim().toUpperCase();
    const q = quoteMap.get(tsCode);
    const nav = readLatestFundNav(opts.marketDb, tsCode, clock.date_ymd);
    const livePrice = q?.close ?? null;
    const livePremiumPct = nav ? pctDiff(livePrice, nav.unit_nav) : null;
    const lagDays = nav?.lag_trade_days ?? null;
    const blocked = Boolean((livePremiumPct !== null && livePremiumPct > 2.5) || (lagDays !== null && lagDays > 3));
    return {
      ts_code: tsCode,
      name: q?.name || cb?.name || tsCode,
      live_price_cny: livePrice,
      quote_date: q?.trade_date ?? null,
      unit_nav: nav?.unit_nav ?? cb?.unit_nav ?? null,
      nav_date: nav?.nav_date ?? cb?.nav_date ?? null,
      nav_lag_trade_days: lagDays,
      live_premium_pct: livePremiumPct,
      premium_blocked: blocked,
    };
  });

  // 6. 额外自选查询标的
  const extraWatch = extraCodes.map(tsCode => {
    const q = quoteMap.get(tsCode);
    const isEtf = isEtfOrFundCode(tsCode);
    const eod = readEodRefMetrics(opts.marketDb, tsCode, clock.date_ymd, false);
    const nav = isEtf ? readLatestFundNav(opts.marketDb, tsCode, clock.date_ymd) : null;
    const livePrice = q?.close ?? null;
    return {
      ts_code: tsCode,
      name: q?.name || tsCode,
      is_etf: isEtf,
      live_price_cny: livePrice,
      pct_chg: q?.pct_chg ?? null,
      quote_date: q?.trade_date ?? null,
      quote_time: q?.quote_time ?? null,
      ma5_cny: eod.ma5_cny,
      ma20_cny: eod.ma20_cny,
      dist_to_ma20_pct: pctDiff(livePrice, eod.ma20_cny),
      unit_nav: nav?.unit_nav ?? null,
      live_premium_pct: nav ? pctDiff(livePrice, nav.unit_nav) : null,
    };
  });

  // 7. 下午重点核对清单
  const checklist: string[] = [];
  if (!quoteFreshForToday) {
    checklist.push(`注意：腾讯实时行情返回日期尚未更新至今日（${clock.date_ymd}），以下按最新可得报价计算，请结合开盘后时段再看。`);
  }
  if (extremeCrashWarning) {
    checklist.push(`⚠️ 大盘触发单日暴跌预警（沪深300 ${hs300Pct}% / 中证500 ${csi500Pct}% / 创业板指 ${chinextPct}%），暂停主动新增风险仓位，尾盘优先控险。`);
  }
  if (liveBreakerAlert === 'BREACHED_L2' || liveBreakerAlert === 'NEAR_L2') {
    checklist.push(`⚠️ 实时高水位回撤 ${liveHwmDrawdownPct}%（当前 L2 熔断线 ${l2TriggerPct}%），请紧盯生命线 ¥${lifelineNavCents !== null ? (lifelineNavCents / 100).toFixed(2) : '-'}。`);
  } else if (liveBreakerAlert === 'BREACHED_L1' || liveBreakerAlert === 'NEAR_L1') {
    checklist.push(`⚠️ 实时高水位回撤 ${liveHwmDrawdownPct}%（接近/触及 L1 ${l1TriggerPct}% 警戒线），暂勿新开个股仓位。`);
  }
  for (const act of plannedActionsCheck) {
    for (const leg of act.legs) {
      if (leg.execution_check === 'SKIP_CHASE_ABOVE_2PCT') {
        checklist.push(`🚫 昨夜计划买入 ${leg.ts_code}（${leg.name}）实时高开/涨幅达 +${leg.gap_from_ref_pct}%（超过 +2% 阈值），按纪律放弃追高。`);
      } else if (leg.execution_check === 'BLOCKED_ETF_PREMIUM_OR_STALE_NAV') {
        checklist.push(`🚫 计划买入 ${leg.ts_code} 触发溢价/净值滞后红灯（溢价 ${leg.live_premium_pct ?? '未知'}%，滞后 ${leg.nav_lag_trade_days ?? '未知'} 日），严禁买入。`);
      }
    }
  }
  for (const h of holdingsCheck) {
    if (h.intraday_flags.includes('STOP_BREACHED_INTRADAY_WATCH_CLOSE')) {
      checklist.push(`🔎 持仓 ${h.ts_code} 盘中跌破 -8% 硬止损参考位（¥${h.hard_stop_cny}），若 14:45–15:00 未收回按规则执行止损/次日离场。`);
    }
    if (h.intraday_flags.includes('BELOW_MA20_WATCH_CLOSE')) {
      checklist.push(`🔎 持仓个股 ${h.ts_code} 盘中低于 MA20（¥${h.ma20_cny}），以 14:50 收盘确认是否有效跌破，不建议 13:00 盲目市价情绪化割肉。`);
    }
    if (h.intraday_flags.includes('DEEP_BELOW_SUPPORT_FLOOR')) {
      checklist.push(`⚠️ ${h.ts_code} 盘中深穿 0.780 箱体下方 4% 防守线（<= ¥${h.deconcentration_levels?.deep_break_cny}），尾盘若仍处于该位下方按降浓预案执行减仓。`);
    } else if (h.intraday_flags.includes('BELOW_SUPPORT_FLOOR_WATCH_CLOSE')) {
      checklist.push(`🔎 ${h.ts_code} 盘中位于箱体防守位 ¥${h.deconcentration_levels?.support_floor_cny} 下方，留意 14:45 能否收回（当前第 ${h.deconcentration_levels?.next_tranche?.tranche_no ?? '-'} 批 ${h.deconcentration_levels?.next_tranche?.planned_shares ?? '-'} 份）。`);
    }
    if (h.intraday_flags.includes('ABOVE_REBOUND_8PCT_TARGET')) {
      checklist.push(`🎯 ${h.ts_code} 实时价格 ¥${h.live_price_cny} 已触及反弹 +8% 兑现参考位（¥${h.deconcentration_levels?.rebound_8pct_target_cny}），可评估分批高抛降浓。`);
    }
  }
  if (!checklist.length) {
    checklist.push('当前持仓与计划均处于受控区间：无需在 13:00 紧急市价改单，继续按昨夜预案执行并在 14:45 复核收盘确认线即可。');
  }

  return {
    schema: MIDDAY_CHECK_SCHEMA,
    status: 'OK',
    read_only: true,
    shanghai_date: clock.date_ymd,
    shanghai_time: clock.iso_shanghai,
    is_trade_day: cal.isOpen,
    session_phase: sessionPhase,
    quote_fresh_for_today: quoteFreshForToday,
    account_id: account.account_id,
    policy_version: policy.version,
    latest_brief_date: latestBriefDate,
    latest_brief_regime: brief?.v3_cockpit?.market_regime?.regime ?? null,
    latest_brief_regime_label_zh: brief?.v3_cockpit?.market_regime?.regime_label_zh ?? null,
    market_anchors: marketAnchors,
    extreme_crash_warning: extremeCrashWarning,
    live_account: {
      live_holdings_value_cents: liveHoldingsCents,
      cash_cents: cashCents,
      wealth_cents: wealthCents,
      live_total_assets_cents: liveTotalAssetsCents,
      live_investable_nav_cents: liveInvestableNavCents,
      hwm_nav_scope: hwmNavScope,
      nav_for_hwm_cents: navForHwmCents,
      hwm_nav_cents: hwmNavCents,
      hwm_date: riskAnchor?.hwm_date ?? null,
      live_hwm_drawdown_pct: liveHwmDrawdownPct,
      deconcentration_preemptive_active: deconcPreemptiveActive,
      l1_trigger_pct: l1TriggerPct,
      l2_trigger_pct: l2TriggerPct,
      lifeline_nav_cents: lifelineNavCents,
      distance_to_l1_pct: liveHwmDrawdownPct !== null ? roundTo(l1TriggerPct - liveHwmDrawdownPct, 2) : null,
      distance_to_l2_pct: liveHwmDrawdownPct !== null ? roundTo(l2TriggerPct - liveHwmDrawdownPct, 2) : null,
      live_breaker_alert: liveBreakerAlert,
      initial_principal_cents: initialPrincipalCents,
      to_principal_gap_cents: toPrincipalGapCents,
      to_principal_return_needed_pct: toPrincipalReturnPct,
    },
    planned_actions_check: plannedActionsCheck,
    holdings_check: holdingsCheck,
    cross_border_check: crossBorderCheck,
    extra_watch: extraWatch,
    afternoon_checklist_zh: checklist,
    discipline_guardrails_zh: [
      '本工具纯只读且完全隔离：不写账本、不修改快照、不写入盘后前瞻评测账本。',
      '11:30 午盘只是执行与风控检查窗口；MA20 离场线与 0.780 箱体支撑以 14:45–15:00 收盘确认为准，防止午间诱空误操作。',
      '拟买入标的实时涨超昨夜参考价 +2% 一律放弃追高；跨境 ETF 实时溢价 > +2.5% 或净值滞后 > 3 日一律拦截。',
    ],
  };
}

function readOnlyMarket(): DatabaseSync | null {
  try {
    if (!existsSync(ashareDbPath())) return null;
    return getAshareDb();
  } catch {
    return null;
  }
}

export async function runMiddayCheckTool(args: Record<string, any> = {}): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (!portfolioEnabled()) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          refused: true,
          reason: 'portfolio_tools_disabled',
          message: '账户工具默认关闭。请通过 /private/mcp 受认证私有端点或显式开启 ASHARE_PORTFOLIO_ENABLED=1 调用。',
        }, null, 2),
      }],
    };
  }
  const path = portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  const portfolioDb = openPortfolioDb(path, { writable: false });
  const marketDb = readOnlyMarket();
  try {
    const extraCodes = Array.isArray(args?.extra_codes)
      ? args.extra_codes.map(String)
      : args?.extra_codes ? String(args.extra_codes).split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const body = await buildIntradayMiddayCheck({
      portfolioDb,
      marketDb,
      accountId: args?.account_id ? String(args.account_id) : undefined,
      extraCodes,
    });
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  } finally {
    // 共享市场连接由进程持有，绝不在此处 close(marketDb)。
    portfolioDb.close();
  }
}
