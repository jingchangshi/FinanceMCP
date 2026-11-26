import type { DatabaseSync } from 'node:sqlite';
import { ETF_CANDIDATE_DECLARATIONS, ETF_UNIVERSE } from '../etfDeclarations.js';
import {
  fetchEastmoneyCrossSection,
  fetchEastmoneyFinancials,
  fetchEastmoneyFundNav,
  fetchEastmoneyKlines,
  type EastmoneyCrossRow,
  type EastmoneyFundNavRow,
} from './eastmoneyClient.js';
import { fetchSwIndexDailyFree, fetchThsIndexDailyFree } from './hotspotFreeClient.js';
import { TdxSession, withTdxSession, type TdxQuote, type TdxSecurityItem, type TdxXdxrEvent } from './tdxClient.js';
import { fetchTencentDailyBars, fetchTencentQuotes, type TencentQuoteRow } from './tencentClient.js';
import {
  inferExchangeLabel,
  inferMarketBoard,
  isAshareStockCode,
  isExchangeFundCode,
  parseTsCode,
  roundTo,
  runPool,
  shanghaiTodayYmd,
} from './types.js';

// 中国证监会 / 上交所公开休市工作日（非周六日）对照表：用于未来日程推算；过去交易日以 000001.SH 真实 K 线为准。
//
// 2027 年安排依据《国务院办公厅关于2027年部分节假日安排的通知》（国办发明电〔2026〕10号，
// 2026-11-05 发布）。这里只列周一至周五的休市日；周末及调休上班的周六/周日由 isWeekend 处理，
// A 股周末不交易。resolveTradeCal 对过去日期仍以真实指数 K 线自校正。
export const STATIC_CLOSED_WEEKDAYS = new Set([
  // 2025
  '20250101', '20250128', '20250129', '20250130', '20250131', '20250203', '20250204',
  '20250404', '20250501', '20250502', '20250505', '20250602',
  '20251001', '20251002', '20251003', '20251006', '20251007', '20251008',
  // 2026（已与本库 20261218 日历逐日核对）
  '20260101', '20260102', '20260216', '20260217', '20260218', '20260219', '20260220', '20260223',
  '20260406', '20260501', '20260504', '20260505', '20260619', '20260925',
  '20261001', '20261002', '20261005', '20261006', '20261007',
  // 2027（国办发明电〔2026〕10号）
  '20270101', // 元旦（周五）
  '20270205', '20270208', '20270209', '20270210', '20270211', '20270212', // 春节（2/5 除夕至 2/13 周六）
  '20270405', // 清明（4/3 周六至 4/5 周一）
  '20270503', '20270504', '20270505', // 劳动节（5/1 周六至 5/5 周三）
  '20270609', // 端午（周三）
  '20270915', // 中秋（周三）
  '20271001', '20271004', '20271005', '20271006', '20271007', // 国庆（10/1 周五至 10/7 周四）
]);

interface NormalizedBar {
  ts_code: string;
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number | null;
  change: number | null;
  pct_chg: number | null;
  vol: number | null;
  /** 千元；null = 上游未提供成交额（未知，不是 0）。 */
  amount: number | null;
}

interface DayStockSnapshot {
  tradeDate: string;
  daily: Record<string, any>[];
  daily_basic: Record<string, any>[];
  adj_factor: Record<string, any>[];
  stk_limit: Record<string, any>[];
  suspend_d: Record<string, any>[];
}

interface DayFundSnapshot {
  tradeDate: string;
  rows: Record<string, any>[];
  quoteMap: Map<string, TencentQuoteRow>;
}

const CACHE_TTL_MS = 45_000;
let cachedTdxSecurities: { at: number; items: TdxSecurityItem[]; decimals: Map<string, number> } | null = null;
let cachedStockCross: { at: number; map: Map<string, EastmoneyCrossRow> } | null = null;
let cachedFundCross: { at: number; map: Map<string, EastmoneyCrossRow> } | null = null;
const cachedStockDay = new Map<string, { at: number; data: DayStockSnapshot }>();
const cachedFundDay = new Map<string, { at: number; data: DayFundSnapshot }>();
const cachedFinaPeriod = new Map<string, { at: number; rows: Record<string, any>[] }>();
let cachedNavByCode: { at: number; map: Map<string, EastmoneyFundNavRow[]> } | null = null;
let xdxrUnavailableWarned = false;

export function clearFreeProviderCache(): void {
  cachedTdxSecurities = null;
  cachedStockCross = null;
  cachedFundCross = null;
  cachedStockDay.clear();
  cachedFundDay.clear();
  cachedFinaPeriod.clear();
  cachedNavByCode = null;
}

function isFresh(entry: { at: number } | null | undefined): boolean {
  return !!entry && Date.now() - entry.at < CACHE_TTL_MS;
}

function addYmdDays(ymd: string, delta: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function isWeekend(ymd: string): boolean {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6;
}

function hasTable(db: DatabaseSync | null, name: string): boolean {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

async function getTdxSecuritiesCached(): Promise<{ items: TdxSecurityItem[]; decimals: Map<string, number> }> {
  if (isFresh(cachedTdxSecurities)) return cachedTdxSecurities!;
  try {
    const [sz, sh] = await withTdxSession(async s => {
      const a = await s.getAllSecurities(0);
      const b = await s.getAllSecurities(1);
      return [a, b] as const;
    });
    const items = [...sz, ...sh];
    const decimals = new Map<string, number>();
    for (const it of items) {
      decimals.set(`${it.market}:${it.code}`, it.decimalPoint || 2);
    }
    cachedTdxSecurities = { at: Date.now(), items, decimals };
    return cachedTdxSecurities;
  } catch {
    return { items: [], decimals: new Map() };
  }
}

async function getStockCrossCached(): Promise<Map<string, EastmoneyCrossRow>> {
  if (isFresh(cachedStockCross)) return cachedStockCross!.map;
  try {
    const map = await fetchEastmoneyCrossSection('stock');
    cachedStockCross = { at: Date.now(), map };
    return map;
  } catch {
    return new Map();
  }
}

async function getFundCrossCached(): Promise<Map<string, EastmoneyCrossRow>> {
  if (isFresh(cachedFundCross)) return cachedFundCross!.map;
  try {
    const map = await fetchEastmoneyCrossSection('fund');
    cachedFundCross = { at: Date.now(), map };
    return map;
  } catch {
    return new Map();
  }
}

async function fetchBarsSingle(
  tsCode: string,
  start: string,
  end: string,
  isIndex = false,
): Promise<NormalizedBar[]> {
  const parsed = parseTsCode(tsCode);
  // 1) 优先 TDX 原生 TCP K线（股票/ETF/指数均最快、无反爬限制）
  if (parsed.tdxMarket !== null) {
    try {
      // 除权除息事件与 K 线同一会话取回：TDX 日 K 是不复权原始价，昨收取前一根原始收盘
      // 会在除权日丢失参考价跳空，adj_factor 因而永远不会在除权日跳变。
      const { bars: tdxBars, xdxr } = await withTdxSession(async s => {
        const bars = await s.getBars(9, parsed.tdxMarket!, parsed.code, 0, 800, isIndex);
        let events: TdxXdxrEvent[] = [];
        if (!isIndex) {
          try {
            events = await s.getXdxrInfo(parsed.tdxMarket!, parsed.code);
          } catch {
            // 除权信息失败不编造参考价：保留原始前收（旧因子），并记录一次明确的数据质量警告。
            if (!xdxrUnavailableWarned) {
              xdxrUnavailableWarned = true;
              console.warn('[ashare] TDX 除权除息信息不可用：除权日复权因子按原始前收保留旧值，不编造因子');
            }
            events = [];
          }
        }
        return { bars, xdxr: events };
      });
      const xdxrByDate = new Map(xdxr.filter(e => e.category === 1).map(e => [e.date, e]));
      const filtered = tdxBars.filter(b => b.trade_date >= start && b.trade_date <= end && b.close > 0);
      if (filtered.length > 0) {
        const allFiltered = tdxBars.filter(b => b.trade_date <= end && b.close > 0);
        const out: NormalizedBar[] = [];
        for (let i = 0; i < allFiltered.length; i++) {
          const cur = allFiltered[i];
          const rawPrev = i > 0 ? allFiltered[i - 1].close : null;
          if (cur.trade_date < start) continue;
          // 除权日：交易所参考价（昨收）由前收与除权事件推导；无事件或口径未知时保持前收。
          const adjustedPrev = rawPrev !== null
            ? (xdxrReferencePreClose(xdxrByDate.get(cur.trade_date), rawPrev) ?? rawPrev)
            : null;
          const change = adjustedPrev !== null ? roundTo(cur.close - adjustedPrev, 4) : null;
          const pctChg = adjustedPrev && adjustedPrev > 0 ? roundTo(((cur.close - adjustedPrev) / adjustedPrev) * 100, 4) : null;
          out.push({
            ts_code: tsCode,
            trade_date: cur.trade_date,
            open: cur.open,
            high: Math.max(cur.high, cur.open, cur.close),
            low: Math.min(cur.low, cur.open, cur.close),
            close: cur.close,
            pre_close: adjustedPrev,
            change,
            pct_chg: pctChg,
            vol: cur.vol,
            amount: cur.amount,
          });
        }
        if (out.length > 0) return out;
      }
    } catch { /* fallback to Eastmoney */ }
  }

  // 2) 备源 Eastmoney K线（同时支持北交所 .BJ 与全市场指数/ETF）
  try {
    const extStart = addYmdDays(start, -15);
    const emBars = await fetchEastmoneyKlines(tsCode, extStart, end);
    const out: NormalizedBar[] = [];
    for (let i = 0; i < emBars.length; i++) {
      const cur = emBars[i];
      if (cur.trade_date < start || cur.trade_date > end) continue;
      const preClose = cur.pre_close ?? (i > 0 ? emBars[i - 1].close : null);
      out.push({
        ts_code: tsCode,
        trade_date: cur.trade_date,
        open: cur.open,
        high: Math.max(cur.high, cur.open, cur.close),
        low: Math.min(cur.low, cur.open, cur.close),
        close: cur.close,
        pre_close: preClose,
        change: cur.change,
        pct_chg: cur.pct_chg,
        vol: cur.vol,
        amount: cur.amount,
      });
    }
    if (out.length > 0) return out;
  } catch { /* fallback to Tencent */ }

  // 3) 末级兜底腾讯日K
  try {
    const tcBars = await fetchTencentDailyBars(tsCode, start, end);
    return tcBars.map(b => ({
      ts_code: tsCode,
      trade_date: b.trade_date,
      open: b.open,
      high: Math.max(b.high, b.open, b.close),
      low: Math.min(b.low, b.open, b.close),
      close: b.close,
      pre_close: b.pre_close,
      change: b.pre_close !== null ? roundTo(b.close - b.pre_close, 4) : null,
      pct_chg: b.pct_chg,
      vol: b.vol,
      amount: b.amount,
    }));
  } catch {
    return [];
  }
}

async function resolveTradeCal(db: DatabaseSync | null, start: string, end: string): Promise<Record<string, any>[]> {
  const today = shanghaiTodayYmd();
  const minScan = addYmdDays(start, -20);
  const existing = new Map<string, { is_open: number; pretrade_date: string | null }>();
  if (db) {
    const rows = db.prepare('SELECT cal_date, is_open, pretrade_date FROM trade_cal WHERE cal_date BETWEEN ? AND ?')
      .all(minScan, end) as Array<{ cal_date: string; is_open: number; pretrade_date: string | null }>;
    for (const r of rows) existing.set(r.cal_date, { is_open: r.is_open, pretrade_date: r.pretrade_date });
  }

  const barOpenDates = new Set<string>();
  let firstBarDate = '';
  let latestBarDate = '';
  try {
    const bars = await fetchBarsSingle('000001.SH', minScan, end < today ? end : today, true);
    for (const b of bars) {
      barOpenDates.add(b.trade_date);
      if (!firstBarDate || b.trade_date < firstBarDate) firstBarDate = b.trade_date;
      if (b.trade_date > latestBarDate) latestBarDate = b.trade_date;
    }
  } catch { /* fall back to existing/static */ }

  // 若当日行情已闭市或腾讯实时行情已打上今天日期，直接确认今天是否开市
  if (start <= today && today <= end && !barOpenDates.has(today)) {
    try {
      const idxQuotes = await fetchTencentQuotes(['000001.SH']);
      const q = idxQuotes.get('000001.SH');
      if (q && q.trade_date === today && q.vol !== null && q.vol > 0 && q.close && q.close > 0) {
        barOpenDates.add(today);
        if (today > latestBarDate) latestBarDate = today;
      }
    } catch { /* ignore */ }
  }

  const allOut: Array<{ cal_date: string; is_open: number; pretrade_date: string | null }> = [];
  let lastOpen: string | null = null;
  for (let d = minScan; d <= end; d = addYmdDays(d, 1)) {
    let isOpen: number;
    const prevKnown = existing.get(d);
    // 真实指数 K 线覆盖的日期区间。只有落在区间内的日期，缺失才等于“未开市”；
    // 区间之外（K 线未覆盖）不能据此判休市，否则会把整段历史误写成 0。
    const barCovered = firstBarDate !== '' && d >= firstBarDate && d <= latestBarDate;
    if (d <= today && barOpenDates.has(d)) {
      isOpen = 1;
    } else if (d <= today && barCovered) {
      // K线已越过该日期但未出现在000001.SH中，说明当天确未开市。
      // 该分支必须先于 prevKnown：此前按静态表/工作日推算写入的 is_open=1
      // 会在指数 K 线证明休市后永久留存，只有真实 K 线证据可以纠正它。
      isOpen = 0;
    } else if (prevKnown) {
      isOpen = prevKnown.is_open;
      if (lastOpen === null && prevKnown.pretrade_date) lastOpen = prevKnown.pretrade_date;
    } else {
      isOpen = isWeekend(d) || STATIC_CLOSED_WEEKDAYS.has(d) ? 0 : 1;
    }

    if (d >= start) {
      allOut.push({ cal_date: d, is_open: isOpen, pretrade_date: lastOpen });
    }
    if (isOpen === 1) lastOpen = d;
  }
  return allOut;
}

async function resolveStockBasic(db: DatabaseSync | null, listStatus?: string): Promise<Record<string, any>[]> {
  const wanted = listStatus?.trim().toUpperCase();
  const existingMap = new Map<string, Record<string, any>>();
  if (db) {
    const rows = db.prepare(
      'SELECT ts_code, symbol, name, area, industry, market, exchange, list_date, delist_date, list_status, is_hs FROM stock_basic',
    ).all() as Record<string, any>[];
    for (const r of rows) existingMap.set(r.ts_code, r);
  }

  if (wanted === 'D' || wanted === 'P') {
    return [...existingMap.values()].filter(r => r.list_status === wanted);
  }

  const [{ items: tdxItems }, crossMap] = await Promise.all([
    getTdxSecuritiesCached(),
    getStockCrossCached(),
  ]);

  const liveMap = new Map<string, Record<string, any>>();
  for (const [tsCode, row] of existingMap.entries()) {
    if (!row.list_status || row.list_status === 'L') liveMap.set(tsCode, { ...row });
  }

  for (const item of tdxItems) {
    const suffix = item.market === 1 ? 'SH' : 'SZ';
    if (!isAshareStockCode(item.code, suffix)) continue;
    const tsCode = `${item.code}.${suffix}`;
    const prev = liveMap.get(tsCode);
    const em = crossMap.get(tsCode);
    liveMap.set(tsCode, {
      ts_code: tsCode,
      symbol: item.code,
      name: em?.name || item.name || prev?.name || tsCode,
      area: prev?.area ?? null,
      industry: em?.industry || prev?.industry || null,
      market: prev?.market ?? inferMarketBoard(item.code, suffix),
      exchange: prev?.exchange ?? inferExchangeLabel(suffix),
      list_date: prev?.list_date ?? em?.list_date ?? null,
      delist_date: prev?.delist_date ?? null,
      list_status: 'L',
      is_hs: prev?.is_hs ?? null,
    });
  }

  for (const [tsCode, em] of crossMap.entries()) {
    const { code, suffix } = parseTsCode(tsCode);
    if (!isAshareStockCode(code, suffix)) continue;
    const prev = liveMap.get(tsCode);
    liveMap.set(tsCode, {
      ts_code: tsCode,
      symbol: code,
      name: em.name || prev?.name || tsCode,
      area: prev?.area ?? null,
      industry: em.industry || prev?.industry || null,
      market: prev?.market ?? inferMarketBoard(code, suffix),
      exchange: prev?.exchange ?? inferExchangeLabel(suffix),
      list_date: prev?.list_date ?? em.list_date ?? null,
      delist_date: prev?.delist_date ?? null,
      list_status: 'L',
      is_hs: prev?.is_hs ?? null,
    });
  }

  return [...liveMap.values()].sort((a, b) => a.ts_code.localeCompare(b.ts_code));
}

function loadPrevFactorAndClose(
  db: DatabaseSync | null,
  factorTable: 'adj_factor' | 'fund_adj',
  barTable: 'daily' | 'fund_daily',
  beforeDate: string,
): { factors: Map<string, number>; closes: Map<string, number> } {
  const factors = new Map<string, number>();
  const closes = new Map<string, number>();
  if (!db) return { factors, closes };
  if (hasTable(db, factorTable)) {
    const fRows = db.prepare(`
      SELECT a.ts_code, a.adj_factor
      FROM ${factorTable} a
      JOIN (SELECT ts_code, MAX(trade_date) max_d FROM ${factorTable} WHERE trade_date < ? GROUP BY ts_code) m
        ON m.ts_code = a.ts_code AND m.max_d = a.trade_date
    `).all(beforeDate) as Array<{ ts_code: string; adj_factor: number | null }>;
    for (const r of fRows) {
      if (r.adj_factor != null && Number.isFinite(r.adj_factor) && r.adj_factor > 0) {
        factors.set(r.ts_code, r.adj_factor);
      }
    }
  }
  if (hasTable(db, barTable)) {
    const cRows = db.prepare(`
      SELECT d.ts_code, d.close
      FROM ${barTable} d
      JOIN (SELECT ts_code, MAX(trade_date) max_d FROM ${barTable} WHERE trade_date < ? GROUP BY ts_code) m
        ON m.ts_code = d.ts_code AND m.max_d = d.trade_date
    `).all(beforeDate) as Array<{ ts_code: string; close: number | null }>;
    for (const r of cRows) {
      if (r.close != null && Number.isFinite(r.close) && r.close > 0) {
        closes.set(r.ts_code, r.close);
      }
    }
  }
  return { factors, closes };
}

/**
 * 交易所除权除息参考价（除权价，即除权日的“昨收”）。
 *
 * TDX category 1（除权除息）字段均按每 10 股计：fenhong=现金分红（元）、
 * songzhuangu=送转股（股）、peigu=配股（股）、peigujia=配股价（元/股）：
 *   参考价 = (前收 × 10 − fenhong + peigu × peigujia) / (10 + songzhuangu + peigu)
 *
 * 除 category 1 外的类别（11/12 扩缩股等）字段口径未经真实样本核验，返回 null，
 * 调用方退回原始前收——绝不按猜测的公式编造复权因子。
 */
function xdxrReferencePreClose(event: TdxXdxrEvent | undefined, prevClose: number): number | null {
  if (!event || event.category !== 1 || !(prevClose > 0)) return null;
  const cash = Number.isFinite(event.fenhong) ? Math.max(0, event.fenhong as number) : 0;
  const bonus = Number.isFinite(event.songzhuangu) ? Math.max(0, event.songzhuangu as number) : 0;
  const rights = Number.isFinite(event.peigu) ? Math.max(0, event.peigu as number) : 0;
  const rightsPrice = Number.isFinite(event.peigujia) ? Math.max(0, event.peigujia as number) : 0;
  const denom = 10 + bonus + rights;
  if (!(denom > 0)) return null;
  const ref = (prevClose * 10 - cash + rights * rightsPrice) / denom;
  if (!Number.isFinite(ref) || !(ref > 0)) return null;
  return roundTo(ref, 4);
}

/**
 * 当日收盘快照是否已经可用：A 股 15:00 收盘，留 5 分钟给收盘集合竞价与上游落库。
 * 手动 daily 可能在盘中触发，此时腾讯/东财实时价是盘中价，绝不能当成收盘价写入。
 * 非当日（历史日期）永远视为已完成。
 */
export function isFinalAshareClose(tradeDate: string, nowMs = Date.now()): boolean {
  if (tradeDate !== shanghaiTodayYmd(nowMs)) return true;
  const beijing = new Date(nowMs + 8 * 3600_000);
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return minutes >= 15 * 60 + 5;
}

function chainAdjFactor(
  prevFactor: number | undefined,
  prevClose: number | undefined,
  preClose: number | null | undefined,
  minDiffRatio = 0.001,
): number {
  const base = prevFactor && prevFactor > 0 ? prevFactor : 1;
  if (prevClose && prevClose > 0 && preClose && preClose > 0) {
    const rel = Math.abs(prevClose - preClose) / prevClose;
    const ratio = prevClose / preClose;
    if (rel >= minDiffRatio && ratio > 0.05 && ratio < 20) {
      return roundTo(base * ratio, 4);
    }
  }
  return base;
}

async function fetchTdxQuotesBatched(
  codes: readonly string[],
  decimals: Map<string, number>,
  fallbackDec = 2,
): Promise<Map<string, TdxQuote>> {
  const reqItems: Array<{ market: 0 | 1; code: string }> = [];
  for (const tsCode of codes) {
    const { code, tdxMarket } = parseTsCode(tsCode);
    if (tdxMarket !== null && /^\d{6}$/.test(code)) reqItems.push({ market: tdxMarket, code });
  }
  const out = new Map<string, TdxQuote>();
  if (!reqItems.length) return out;
  try {
    await withTdxSession(async session => {
      const resolver = (m: number, c: string) => decimals.get(`${m}:${c}`) ?? fallbackDec;
      for (let i = 0; i < reqItems.length; i += 80) {
        const chunk = reqItems.slice(i, i + 80);
        try {
          const quotes = await session.getSecurityQuotes(chunk, resolver);
          for (const q of quotes) {
            const suffix = q.market === 1 ? 'SH' : 'SZ';
            out.set(`${q.code}.${suffix}`, q);
          }
        } catch { /* skip broken chunk */ }
      }
    });
  } catch { /* TDX unreachable -> callers have HTTP backups */ }
  return out;
}

async function buildHistoricalStockDay(
  db: DatabaseSync | null,
  tradeDate: string,
  stockCodes: string[],
  nameMap: Map<string, string>,
): Promise<DayStockSnapshot> {
  // 若本地已有完整日线（例如重跑 quality 校验或补单表），直接避免全市场 5500 次历史 HTTP 请求
  if (db) {
    const storedDaily = db.prepare('SELECT * FROM daily WHERE trade_date = ?').all(tradeDate) as Record<string, any>[];
    if (storedDaily.length >= 4000) {
      const storedBasic = db.prepare('SELECT * FROM daily_basic WHERE trade_date = ?').all(tradeDate) as Record<string, any>[];
      const storedAdj = db.prepare('SELECT * FROM adj_factor WHERE trade_date = ?').all(tradeDate) as Record<string, any>[];
      const storedLimit = db.prepare('SELECT * FROM stk_limit WHERE trade_date = ?').all(tradeDate) as Record<string, any>[];
      const storedSusp = db.prepare('SELECT * FROM suspend_d WHERE trade_date = ?').all(tradeDate) as Record<string, any>[];
      return {
        tradeDate,
        daily: storedDaily,
        daily_basic: storedBasic,
        adj_factor: storedAdj,
        stk_limit: storedLimit,
        suspend_d: storedSusp,
      };
    }
  }

  const daily: Record<string, any>[] = [];
  const daily_basic: Record<string, any>[] = [];
  const adj_factor: Record<string, any>[] = [];
  const stk_limit: Record<string, any>[] = [];
  const suspend_d: Record<string, any>[] = [];
  const { factors, closes } = loadPrevFactorAndClose(db, 'adj_factor', 'daily', tradeDate);

  const barResults = await runPool(stockCodes, 12, async tsCode => {
    const bars = await fetchBarsSingle(tsCode, tradeDate, tradeDate, false);
    return { tsCode, bar: bars.find(b => b.trade_date === tradeDate) ?? null };
  });

  for (const { tsCode, bar } of barResults) {
    // 停牌判定只看显式停牌信号（suspend=source_explicit_only），缺 bar 或源故障不写入 suspend_d；
    // 未知成交额/成交量保持 null；stk_limit 仅保存上游显式限价，不持久化规则推算值。
    if (bar && bar.vol !== null && bar.vol > 0 && bar.open > 0 && bar.close > 0) {
      daily.push({
        ts_code: tsCode,
        trade_date: tradeDate,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        pre_close: bar.pre_close,
        pct_chg: bar.pct_chg,
        vol: bar.vol,
        amount: bar.amount !== null && bar.amount > 0 ? bar.amount : null,
      });
      daily_basic.push({
        ts_code: tsCode,
        trade_date: tradeDate,
        turnover_rate: null,
        turnover_rate_f: null,
        volume_ratio: null,
        pe_ttm: null,
        pb: null,
        ps_ttm: null,
        dv_ttm: null,
        total_mv: null,
        circ_mv: null,
      });
      const factor = chainAdjFactor(factors.get(tsCode), closes.get(tsCode), bar.pre_close, 0.001);
      adj_factor.push({ ts_code: tsCode, trade_date: tradeDate, adj_factor: factor });
    } else {
      const prevF = factors.get(tsCode) ?? 1;
      adj_factor.push({ ts_code: tsCode, trade_date: tradeDate, adj_factor: prevF });
    }
  }
  return { tradeDate, daily, daily_basic, adj_factor, stk_limit, suspend_d };
}

async function getStockDaySnapshot(db: DatabaseSync | null, tradeDate: string): Promise<DayStockSnapshot> {
  const existingCache = cachedStockDay.get(tradeDate);
  if (isFresh(existingCache)) return existingCache!.data;

  // 先确保有权威上市股票名单
  const basicRows = await resolveStockBasic(db, 'L');
  const listedSet: string[] = [];
  const nameMap = new Map<string, string>();
  for (const r of basicRows) {
    if (r.list_date && r.list_date > tradeDate) continue;
    if (r.delist_date && r.delist_date <= tradeDate) continue;
    const { code, suffix } = parseTsCode(r.ts_code);
    if (!isAshareStockCode(code, suffix)) continue;
    listedSet.push(r.ts_code);
    if (r.name) nameMap.set(r.ts_code, r.name);
  }

  let tencentMap = new Map<string, TencentQuoteRow>();
  try {
    tencentMap = await fetchTencentQuotes(listedSet);
  } catch { /* fallback below */ }

  let observedDate = '';
  for (const q of tencentMap.values()) {
    if (q.vol !== null && q.vol > 0 && q.trade_date > observedDate) observedDate = q.trade_date;
  }

  const emCross = await getStockCrossCached();
  if (!observedDate) {
    for (const em of emCross.values()) {
      if (em.vol !== null && em.vol > 0 && em.trade_date > observedDate) observedDate = em.trade_date;
    }
  }
  if (!observedDate) {
    const idxBars = await fetchBarsSingle('000001.SH', tradeDate, tradeDate, true).catch(() => []);
    if (idxBars.some(b => b.trade_date === tradeDate)) observedDate = tradeDate;
  }

  // 若请求的交易日早于当前最新实盘快照日期，切入历史回溯路径
  if (observedDate && tradeDate < observedDate) {
    const snap = await buildHistoricalStockDay(db, tradeDate, listedSet, nameMap);
    cachedStockDay.set(tradeDate, { at: Date.now(), data: snap });
    return snap;
  }
  // 若请求的日期明显晚于最新已收盘行情日期（盘中未到或未来日期），诚实返回空快照
  if (!observedDate || tradeDate > observedDate) {
    const empty: DayStockSnapshot = {
      tradeDate, daily: [], daily_basic: [], adj_factor: [], stk_limit: [], suspend_d: [],
    };
    return empty;
  }
  // 当日尚未收盘（15:05 前）时实时行情仍是盘中价，绝不把盘中价写成收盘快照。
  // 历史日期（tradeDate !== 今日）不受影响。
  if (!isFinalAshareClose(tradeDate)) {
    console.warn(`[ashare] ${tradeDate} 尚未收盘（A股 15:05 后才有最终收盘价），拒绝写入盘中快照`);
    const empty: DayStockSnapshot = {
      tradeDate, daily: [], daily_basic: [], adj_factor: [], stk_limit: [], suspend_d: [],
    };
    return empty;
  }

  // 同日补全：对腾讯未返回或缺失的股票，并行用 TDX 行情 + 东财全市场截面补齐
  const missingCodes = listedSet.filter(c => {
    const q = tencentMap.get(c);
    return !q || q.trade_date !== tradeDate;
  });
  const { decimals } = missingCodes.length > 0
    ? await getTdxSecuritiesCached()
    : { decimals: new Map<string, number>() };
  const tdxMap = missingCodes.length > 0 ? await fetchTdxQuotesBatched(missingCodes, decimals, 2) : new Map<string, TdxQuote>();

  const { factors, closes } = loadPrevFactorAndClose(db, 'adj_factor', 'daily', tradeDate);
  const daily: Record<string, any>[] = [];
  const daily_basic: Record<string, any>[] = [];
  const adj_factor: Record<string, any>[] = [];
  const stk_limit: Record<string, any>[] = [];
  const suspend_d: Record<string, any>[] = [];

  for (const tsCode of listedSet) {
    const tq = tencentMap.get(tsCode);
    const em = emCross.get(tsCode);
    const tdx = tdxMap.get(tsCode);

    const matchTq = tq && tq.trade_date === tradeDate ? tq : null;
    const matchEm = em && em.trade_date === tradeDate ? em : null;

    const close = matchTq?.close ?? matchEm?.close ?? tdx?.close ?? null;
    const preClose = matchTq?.pre_close ?? matchEm?.pre_close ?? tdx?.pre_close ?? closes.get(tsCode) ?? null;
    const open = matchTq?.open ?? matchEm?.open ?? tdx?.open ?? null;
    const highRaw = matchTq?.high ?? matchEm?.high ?? tdx?.high ?? null;
    const lowRaw = matchTq?.low ?? matchEm?.low ?? tdx?.low ?? null;
    const vol = matchTq?.vol ?? matchEm?.vol ?? tdx?.vol ?? null;
    const amount = matchTq?.amount ?? matchEm?.amount ?? tdx?.amount ?? null;

    // 停牌判定只认显式停牌信号（suspend=source_explicit_only）；缺 bar 或源故障不写入 suspend_d。
    const validBar =
      close !== null && close > 0 &&
      open !== null && open > 0 &&
      vol !== null && vol > 0 &&
      (matchTq !== null || matchEm !== null || tdx !== undefined);

    if (validBar) {
      const high = highRaw && highRaw > 0 ? Math.max(highRaw, open!, close!) : Math.max(open!, close!);
      const low = lowRaw && lowRaw > 0 ? Math.min(lowRaw, open!, close!) : Math.min(open!, close!);
      const pctChg = matchTq?.pct_chg ?? matchEm?.pct_chg ?? (preClose && preClose > 0 ? roundTo(((close! - preClose) / preClose) * 100, 4) : null);

      daily.push({
        ts_code: tsCode,
        trade_date: tradeDate,
        open,
        high,
        low,
        close,
        pre_close: preClose,
        pct_chg: pctChg,
        vol,
        amount: amount !== null && amount > 0 ? amount : null,
      });
      daily_basic.push({
        ts_code: tsCode,
        trade_date: tradeDate,
        turnover_rate: matchTq?.turnover_rate ?? matchEm?.turnover_rate ?? null,
        turnover_rate_f: null,
        volume_ratio: matchTq?.volume_ratio ?? matchEm?.volume_ratio ?? null,
        pe_ttm: matchTq?.pe_ttm ?? matchEm?.pe_ttm ?? null,
        pb: matchTq?.pb ?? matchEm?.pb ?? null,
        ps_ttm: matchEm?.ps_ttm ?? null,
        dv_ttm: null,
        total_mv: matchTq?.total_mv ?? matchEm?.total_mv ?? null,
        circ_mv: matchTq?.circ_mv ?? matchEm?.circ_mv ?? null,
      });

      const factor = chainAdjFactor(factors.get(tsCode), closes.get(tsCode), preClose, 0.001);
      adj_factor.push({ ts_code: tsCode, trade_date: tradeDate, adj_factor: factor });

      // stk_limit 仅持久化上游腾讯显式提供的涨跌停价，禁止写入规则推算值。
      if (matchTq?.up_limit != null && matchTq?.down_limit != null) {
        stk_limit.push({
          ts_code: tsCode,
          trade_date: tradeDate,
          up_limit: matchTq.up_limit,
          down_limit: matchTq.down_limit,
        });
      }
    } else {
      // 无有效成交时保留复权因子连续性；不把缺 bar / 源故障伪造为停牌或推算限价。
      const prevF = factors.get(tsCode) ?? 1;
      adj_factor.push({ ts_code: tsCode, trade_date: tradeDate, adj_factor: prevF });
      if (matchTq?.up_limit != null && matchTq?.down_limit != null) {
        stk_limit.push({
          ts_code: tsCode,
          trade_date: tradeDate,
          up_limit: matchTq.up_limit,
          down_limit: matchTq.down_limit,
        });
      }
    }
  }

  const snap: DayStockSnapshot = { tradeDate, daily, daily_basic, adj_factor, stk_limit, suspend_d };
  cachedStockDay.set(tradeDate, { at: Date.now(), data: snap });
  return snap;
}

async function resolveFundBasic(db: DatabaseSync | null, tsCode?: string): Promise<Record<string, any>[]> {
  const existingMap = new Map<string, Record<string, any>>();
  if (hasTable(db, 'fund_basic')) {
    const rows = db!.prepare('SELECT * FROM fund_basic').all() as Record<string, any>[];
    for (const r of rows) existingMap.set(r.ts_code, { ...r });
  }
  if (tsCode) {
    const hit = existingMap.get(tsCode);
    if (hit) return [hit];
  }

  const [{ items: tdxItems }, emFunds] = await Promise.all([
    getTdxSecuritiesCached(),
    getFundCrossCached(),
  ]);

  const outMap = new Map<string, Record<string, any>>();
  for (const [c, row] of existingMap.entries()) {
    if (!row.status || row.status === 'L') outMap.set(c, row);
  }

  const upsertFundMeta = (code: string, suffix: 'SH' | 'SZ', name: string) => {
    const key = `${code}.${suffix}`;
    const prev = outMap.get(key);
    outMap.set(key, {
      ts_code: key,
      name: name || prev?.name || key,
      management: prev?.management ?? null,
      custodian: prev?.custodian ?? null,
      fund_type: prev?.fund_type ?? 'ETF',
      found_date: prev?.found_date ?? null,
      due_date: prev?.due_date ?? null,
      list_date: prev?.list_date ?? null,
      issue_date: prev?.issue_date ?? null,
      delist_date: prev?.delist_date ?? null,
      issue_amount: prev?.issue_amount ?? null,
      m_fee: prev?.m_fee ?? null,
      c_fee: prev?.c_fee ?? null,
      benchmark: prev?.benchmark ?? null,
      status: 'L',
      invest_type: prev?.invest_type ?? null,
      type: prev?.type ?? null,
      market: 'E',
    });
  };

  for (const it of tdxItems) {
    const suffix = it.market === 1 ? 'SH' : 'SZ';
    if (isExchangeFundCode(it.code, suffix)) upsertFundMeta(it.code, suffix, it.name);
  }
  for (const [key, em] of emFunds.entries()) {
    const { code, suffix } = parseTsCode(key);
    if ((suffix === 'SH' || suffix === 'SZ') && isExchangeFundCode(code, suffix)) {
      upsertFundMeta(code, suffix, em.name);
    }
  }
  for (const decl of ETF_CANDIDATE_DECLARATIONS) {
    const { code, suffix } = parseTsCode(decl.ts_code);
    if (suffix === 'SH' || suffix === 'SZ') upsertFundMeta(code, suffix, outMap.get(decl.ts_code)?.name || decl.name_hint);
  }
  for (const held of ETF_UNIVERSE) {
    const { code, suffix } = parseTsCode(held);
    if (suffix === 'SH' || suffix === 'SZ') upsertFundMeta(code, suffix, outMap.get(held)?.name || held);
  }

  if (tsCode) {
    const match = outMap.get(tsCode);
    return match ? [match] : [];
  }
  return [...outMap.values()].sort((a, b) => a.ts_code.localeCompare(b.ts_code));
}

async function getFundDaySnapshot(db: DatabaseSync | null, tradeDate: string): Promise<DayFundSnapshot> {
  const cached = cachedFundDay.get(tradeDate);
  if (isFresh(cached)) return cached!.data;

  const basics = await resolveFundBasic(db);
  const fundCodes = [...new Set([
    ...basics.map(r => r.ts_code as string).filter(c => c.endsWith('.SH') || c.endsWith('.SZ')),
    ...ETF_UNIVERSE,
    ...ETF_CANDIDATE_DECLARATIONS.map(d => d.ts_code),
  ])];

  let tencentMap = new Map<string, TencentQuoteRow>();
  try {
    tencentMap = await fetchTencentQuotes(fundCodes);
  } catch { /* fallback below */ }

  let observedDate = '';
  for (const q of tencentMap.values()) {
    if (q.vol !== null && q.vol > 0 && q.trade_date > observedDate) observedDate = q.trade_date;
  }
  const emFunds = await getFundCrossCached();
  if (!observedDate) {
    for (const em of emFunds.values()) {
      if (em.vol !== null && em.vol > 0 && em.trade_date > observedDate) observedDate = em.trade_date;
    }
  }
  if (!observedDate) {
    const idxBars = await fetchBarsSingle('000001.SH', tradeDate, tradeDate, true).catch(() => []);
    if (idxBars.some(b => b.trade_date === tradeDate)) observedDate = tradeDate;
  }

  if (observedDate && tradeDate < observedDate) {
    if (hasTable(db, 'fund_daily')) {
      const existingRows = db!.prepare('SELECT * FROM fund_daily WHERE trade_date = ?').all(tradeDate) as Record<string, any>[];
      if (existingRows.length >= 1000) {
        const snap: DayFundSnapshot = { tradeDate, rows: existingRows, quoteMap: tencentMap };
        cachedFundDay.set(tradeDate, { at: Date.now(), data: snap });
        return snap;
      }
    }
    const targetCodes = [...new Set([
      ...ETF_UNIVERSE,
      ...ETF_CANDIDATE_DECLARATIONS.map(d => d.ts_code),
    ])];
    const barRows = await runPool(targetCodes, 8, async tsCode => {
      const bars = await fetchBarsSingle(tsCode, tradeDate, tradeDate, false);
      const b = bars.find(x => x.trade_date === tradeDate);
      // 停牌只看成交量；成交额未知（腾讯兜底）不能当作停牌或 0。
      if (!b || b.vol === null || b.vol <= 0 || b.open <= 0 || b.close <= 0) return null;
      return {
        ts_code: tsCode,
        trade_date: tradeDate,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        pre_close: b.pre_close,
        change: b.change,
        pct_chg: b.pct_chg,
        vol: b.vol,
        amount: b.amount !== null && b.amount > 0 ? b.amount : null,
      };
    });
    const rows = barRows.filter((r): r is NonNullable<typeof r> => r !== null);
    return { tradeDate, rows, quoteMap: tencentMap };
  }

  if (!observedDate || tradeDate > observedDate) {
    return { tradeDate, rows: [], quoteMap: tencentMap };
  }
  if (!isFinalAshareClose(tradeDate)) {
    console.warn(`[ashare] ${tradeDate} 尚未收盘（A股 15:05 后才有最终收盘价），拒绝写入盘中 ETF 快照`);
    return { tradeDate, rows: [], quoteMap: tencentMap };
  }

  const missingCodes = fundCodes.filter(c => {
    const q = tencentMap.get(c);
    return !q || q.trade_date !== tradeDate;
  });
  const { decimals } = missingCodes.length > 0 ? await getTdxSecuritiesCached() : { decimals: new Map<string, number>() };
  const tdxMap = missingCodes.length > 0 ? await fetchTdxQuotesBatched(missingCodes, decimals, 3) : new Map<string, TdxQuote>();

  const rows: Record<string, any>[] = [];
  for (const tsCode of fundCodes) {
    const tq = tencentMap.get(tsCode);
    const em = emFunds.get(tsCode);
    const tdx = tdxMap.get(tsCode);

    const matchTq = tq && tq.trade_date === tradeDate ? tq : null;
    const matchEm = em && em.trade_date === tradeDate ? em : null;
    const close = matchTq?.close ?? matchEm?.close ?? tdx?.close ?? null;
    const preClose = matchTq?.pre_close ?? matchEm?.pre_close ?? tdx?.pre_close ?? null;
    const open = matchTq?.open ?? matchEm?.open ?? tdx?.open ?? null;
    const highRaw = matchTq?.high ?? matchEm?.high ?? tdx?.high ?? null;
    const lowRaw = matchTq?.low ?? matchEm?.low ?? tdx?.low ?? null;
    const vol = matchTq?.vol ?? matchEm?.vol ?? tdx?.vol ?? null;
    const amount = matchTq?.amount ?? matchEm?.amount ?? tdx?.amount ?? null;

    if (
      close !== null && close > 0 &&
      open !== null && open > 0 &&
      vol !== null && vol > 0 &&
      (matchTq !== null || matchEm !== null || tdx !== undefined)
    ) {
      const high = highRaw && highRaw > 0 ? Math.max(highRaw, open, close) : Math.max(open, close);
      const low = lowRaw && lowRaw > 0 ? Math.min(lowRaw, open, close) : Math.min(open, close);
      const change = matchTq?.change ?? matchEm?.change ?? (preClose && preClose > 0 ? roundTo(close - preClose, 4) : null);
      const pctChg = matchTq?.pct_chg ?? matchEm?.pct_chg ?? (preClose && preClose > 0 ? roundTo(((close - preClose) / preClose) * 100, 4) : null);
      rows.push({
        ts_code: tsCode,
        trade_date: tradeDate,
        open,
        high,
        low,
        close,
        pre_close: preClose,
        change,
        pct_chg: pctChg,
        vol,
        amount: amount !== null && amount > 0 ? amount : null,
      });
    }
  }

  const snap: DayFundSnapshot = { tradeDate, rows, quoteMap: tencentMap };
  cachedFundDay.set(tradeDate, { at: Date.now(), data: snap });
  return snap;
}

async function resolveFundAdj(
  db: DatabaseSync | null,
  tsCode: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, any>[]> {
  const existingRows = hasTable(db, 'fund_adj')
    ? (db!.prepare('SELECT ts_code, trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date')
      .all(tsCode, startDate, endDate) as Array<{ ts_code: string; trade_date: string; adj_factor: number }>)
    : [];
  const byDate = new Map(existingRows.map(r => [r.trade_date, r.adj_factor]));

  const prevFactorRow = hasTable(db, 'fund_adj')
    ? (db!.prepare('SELECT adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date < ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1')
      .get(tsCode, startDate) as { adj_factor?: number } | undefined)
    : undefined;
  let prevFactor = prevFactorRow?.adj_factor && prevFactorRow.adj_factor > 0 ? prevFactorRow.adj_factor : 1;

  const dailyBars = hasTable(db, 'fund_daily')
    ? (db!.prepare('SELECT trade_date, close, pre_close FROM fund_daily WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date')
      .all(tsCode, endDate) as Array<{ trade_date: string; close: number; pre_close: number | null }>)
    : [];

  let prevClose: number | undefined;
  const out: Record<string, any>[] = [];
  for (const bar of dailyBars) {
    if (bar.trade_date < startDate) {
      if (bar.close > 0) prevClose = bar.close;
      const stored = hasTable(db, 'fund_adj')
        ? (db!.prepare('SELECT adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date = ?').get(tsCode, bar.trade_date) as any)?.adj_factor
        : null;
      if (stored && stored > 0) prevFactor = stored;
      continue;
    }
    const existing = byDate.get(bar.trade_date);
    // 与股票一致使用 0.1% 门槛：ETF 分红多为 0.3%~1.5%，2% 的高门槛会把真实分红
    // 全部漏掉，fund_adj 在除息日不跳变。
    const factor = existing && existing > 0
      ? existing
      : chainAdjFactor(prevFactor, prevClose, bar.pre_close, 0.001);
    prevFactor = factor;
    if (bar.close > 0) prevClose = bar.close;
    out.push({ ts_code: tsCode, trade_date: bar.trade_date, adj_factor: factor });
  }

  if (out.length === 0) {
    out.push({ ts_code: tsCode, trade_date: endDate, adj_factor: prevFactor });
  }
  return out;
}

async function resolveFundShare(
  db: DatabaseSync | null,
  tsCode: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, any>[]> {
  const existing = hasTable(db, 'fund_share')
    ? (db!.prepare(
      'SELECT ts_code, trade_date, fd_share, fund_type, market FROM fund_share WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date',
    ).all(tsCode, startDate, endDate) as Record<string, any>[])
    : [];
  const byDate = new Map(existing.map(r => [r.trade_date as string, r]));
  const { suffix } = parseTsCode(tsCode);

  try {
    const quoteMap = await fetchTencentQuotes([tsCode]);
    const q = quoteMap.get(tsCode);
    if (q && q.trade_date >= startDate && q.trade_date <= endDate && q.circ_mv && q.close && q.close > 0) {
      byDate.set(q.trade_date, {
        ts_code: tsCode,
        trade_date: q.trade_date,
        fd_share: roundTo(q.circ_mv / q.close, 4),
        fund_type: 'ETF',
        market: suffix,
      });
    }
  } catch { /* keep existing */ }

  return [...byDate.values()].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
}

async function resolveFundNav(
  db: DatabaseSync | null,
  params: Record<string, any>,
): Promise<Record<string, any>[]> {
  const reqCode = typeof params.ts_code === 'string' && params.ts_code.trim() ? params.ts_code.trim().toUpperCase() : null;
  if (reqCode) {
    const endDate = params.end_date ? String(params.end_date) : shanghaiTodayYmd();
    const cachedList = isFresh(cachedNavByCode) ? cachedNavByCode!.map.get(reqCode) : undefined;
    const rows = cachedList ?? await fetchEastmoneyFundNav(reqCode, Number(params.limit || 20));
    return rows.filter(r => r.nav_date <= endDate);
  }

  const navDate = String(params.nav_date ?? shanghaiTodayYmd());
  let navCache = isFresh(cachedNavByCode) ? cachedNavByCode : null;
  if (!navCache) {
    const pipelineSet = new Set<string>([
      ...ETF_UNIVERSE,
      ...ETF_CANDIDATE_DECLARATIONS.map(d => d.ts_code),
    ]);
    if (hasTable(db, 'fund_daily')) {
      const active = db!.prepare(
        `SELECT ts_code FROM fund_daily WHERE trade_date = (SELECT MAX(trade_date) FROM fund_daily) ORDER BY amount DESC LIMIT 80`,
      ).all() as Array<{ ts_code: string }>;
      for (const r of active) pipelineSet.add(r.ts_code);
    }
    const targetCodes = [...pipelineSet];
    const map = new Map<string, EastmoneyFundNavRow[]>();
    await runPool(targetCodes, 8, async code => {
      try {
        const list = await fetchEastmoneyFundNav(code, 20);
        if (list.length) map.set(code, list);
      } catch { /* isolate single fund failure */ }
    });
    navCache = { at: Date.now(), map };
    cachedNavByCode = navCache;
  }

  const out: Record<string, any>[] = [];
  for (const list of navCache.map.values()) {
    for (const row of list) {
      if (row.nav_date === navDate) out.push(row);
    }
  }
  return out;
}

async function resolveFinancials(db: DatabaseSync | null, period: string): Promise<Record<string, any>[]> {
  const cached = cachedFinaPeriod.get(period);
  if (cached && isFresh(cached)) return cached.rows;

  const existing = new Map<string, Record<string, any>>();
  let storedRows: Record<string, any>[] = [];
  if (db) {
    storedRows = db.prepare('SELECT * FROM fina_indicator WHERE end_date = ?').all(period) as Record<string, any>[];
    for (const r of storedRows) existing.set(`${r.ts_code}:${r.ann_date}`, r);
    // 已披露完结的历史报告期直接复用本地完整库（> 3500 条且距今超 120 天），无需重复拉取
    const cutoff = addYmdDays(shanghaiTodayYmd(), -120);
    if (storedRows.length >= 3500 && period < cutoff) {
      return storedRows.map(r => ({ ...r, update_flag: '0' }));
    }
  }

  let fresh: Awaited<ReturnType<typeof fetchEastmoneyFinancials>>;
  try {
    fresh = await fetchEastmoneyFinancials(period);
  } catch (error: any) {
    // 现金流/利润接口失败时不能把全市场 ocf_to_profit 静默写成 null。
    // 本地已有该报告期缓存则沿用缓存（并明确告警），否则让错误上抛，由同步层记录失败。
    if (storedRows.length > 0) {
      console.warn(`[ashare] fina_indicator ${period} 上游刷新失败，沿用本地 ${storedRows.length} 条缓存: ${String(error?.message ?? error).slice(0, 120)}`);
      return storedRows.map(r => ({ ...r, update_flag: '0' }));
    }
    throw error;
  }
  const merged = fresh.map(r => {
    const prev = existing.get(`${r.ts_code}:${r.ann_date}`);
    if (!prev) return r;
    return {
      ...r,
      roe: r.roe ?? prev.roe,
      roe_dt: prev.roe_dt ?? r.roe_dt,
      netprofit_yoy: r.netprofit_yoy ?? prev.netprofit_yoy,
      dt_netprofit_yoy: prev.dt_netprofit_yoy ?? r.dt_netprofit_yoy,
      or_yoy: r.or_yoy ?? prev.or_yoy,
      grossprofit_margin: r.grossprofit_margin ?? prev.grossprofit_margin,
      debt_to_assets: r.debt_to_assets ?? prev.debt_to_assets,
      ocf_to_profit: r.ocf_to_profit ?? prev.ocf_to_profit,
      ocfps: r.ocfps ?? prev.ocfps,
      eps: r.eps ?? prev.eps,
    };
  });
  cachedFinaPeriod.set(period, { at: Date.now(), rows: merged });
  return merged;
}

/**
 * 免费多源行情与财务统一路由器：
 * 按 `api_name` + `params` 分发至 TDX TCP / 腾讯批量 / 东财截面与净值 / 行业合成，
 * 返回与既有 SQLite 表完全一致字段及单位（手 / 千元 / 万元 / 万份）的行数组。
 */
export async function fetchFreeDataset(
  api: string,
  params: Record<string, any>,
  db: DatabaseSync | null,
): Promise<Record<string, any>[]> {
  switch (api) {
    case 'trade_cal':
      return resolveTradeCal(db, String(params.start_date), String(params.end_date));

    case 'stock_basic':
      return resolveStockBasic(db, params.list_status ? String(params.list_status) : undefined);

    case 'daily':
    case 'daily_basic':
    case 'adj_factor':
    case 'stk_limit':
    case 'suspend_d': {
      if (params.ts_code) {
        const tsCode = String(params.ts_code).trim().toUpperCase();
        const start = String(params.start_date ?? params.trade_date);
        const end = String(params.end_date ?? params.trade_date);
        if (api === 'daily') {
          return fetchBarsSingle(tsCode, start, end, false);
        }
        if (api === 'suspend_d') {
          // suspend=source_explicit_only：免费源无逐股显式停牌接口，缺 bar 不得伪造停牌。
          return [];
        }
        if (api === 'adj_factor') {
          const bars = await fetchBarsSingle(tsCode, start, end, false);
          const { factors, closes } = loadPrevFactorAndClose(db, 'adj_factor', 'daily', start);
          let pf = factors.get(tsCode) ?? 1;
          let pc = closes.get(tsCode);
          return bars.map(b => {
            pf = chainAdjFactor(pf, pc, b.pre_close, 0.001);
            if (b.close > 0) pc = b.close;
            return { ts_code: tsCode, trade_date: b.trade_date, adj_factor: pf };
          });
        }
        if (api === 'stk_limit') {
          // 历史按代码补洞不持久化规则推算涨跌停价，只保留腾讯上游显式限价。
          return [];
        }
        return [];
      }
      const date = String(params.trade_date);
      const snap = await getStockDaySnapshot(db, date);
      return snap[api];
    }

    case 'index_daily': {
      const tsCode = String(params.ts_code).trim().toUpperCase();
      const start = String(params.start_date);
      const end = String(params.end_date);
      const bars = await fetchBarsSingle(tsCode, start, end, true);
      return bars;
    }

    case 'fina_indicator_vip':
      return resolveFinancials(db, String(params.period));

    case 'fund_basic':
      return resolveFundBasic(db, params.ts_code ? String(params.ts_code).trim().toUpperCase() : undefined);

    case 'fund_daily': {
      if (params.ts_code) {
        const tsCode = String(params.ts_code).trim().toUpperCase();
        const start = String(params.start_date ?? params.trade_date);
        const end = String(params.end_date ?? params.trade_date);
        if (params.trade_date && start === end) {
          const snap = await getFundDaySnapshot(db, start);
          const hit = snap.rows.find(r => r.ts_code === tsCode);
          if (hit) return [hit];
        }
        return fetchBarsSingle(tsCode, start, end, false);
      }
      const date = String(params.trade_date);
      const snap = await getFundDaySnapshot(db, date);
      return snap.rows;
    }

    case 'fund_adj':
      return resolveFundAdj(db, String(params.ts_code).trim().toUpperCase(), String(params.start_date), String(params.end_date));

    case 'fund_share':
      return resolveFundShare(db, String(params.ts_code).trim().toUpperCase(), String(params.start_date), String(params.end_date));

    case 'fund_nav':
      return resolveFundNav(db, params);

    case 'sw_daily':
      return fetchSwIndexDailyFree(db, String(params.ts_code), String(params.start_date), String(params.end_date));

    case 'ths_daily':
      return fetchThsIndexDailyFree(db, String(params.ts_code), String(params.start_date), String(params.end_date));

    default:
      throw new Error(`免费行情路由暂不支持该上游接口: ${api}`);
  }
}
