import { TUSHARE_CONFIG } from '../../config.js';

export type DataProviderMode = 'free' | 'tushare';

export type MarketSuffix = 'SH' | 'SZ' | 'BJ' | 'SI' | 'TI' | 'OF';

export interface ParsedTsCode {
  tsCode: string;
  code: string;
  suffix: MarketSuffix | string;
  tdxMarket: 0 | 1 | null;
  tencentSymbol: string;
  eastmoneySecid: string | null;
}

/**
 * 解析当前行情数据源模式：
 * - `ASHARE_DATA_PROVIDER=free`：强制走免费多源路由（生产默认）；
 * - `ASHARE_DATA_PROVIDER=tushare`：强制走 Tushare Pro；
 * - 未设置或 `auto`：若上下文/环境配置了 TUSHARE_TOKEN 则走 `tushare`（兼容既有离线单测 mock），否则走 `free`。
 */
export function resolveDataProviderMode(explicit?: string): DataProviderMode {
  const raw = (explicit ?? process.env.ASHARE_DATA_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'free') return 'free';
  if (raw === 'tushare') return 'tushare';
  return TUSHARE_CONFIG.API_TOKEN.trim() ? 'tushare' : 'free';
}

export function normalizeYmd(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).trim().slice(0, 10).replace(/\D/g, '');
  if (digits.length === 8) return digits;
  return null;
}

export function shanghaiTodayYmd(nowMs = Date.now()): string {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

export function shanghaiDateFromEpochSec(epochSec: number): string | null {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  return new Date(epochSec * 1000 + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function positiveOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? n : null;
}

export function isAshareStockCode(code: string, suffix: string): boolean {
  if (suffix === 'SH') return /^(600|601|603|605|688|689)\d{3}$/.test(code);
  if (suffix === 'SZ') return /^(000|001|002|003|300|301)\d{3}$/.test(code);
  if (suffix === 'BJ') return /^(92\d{4}|8[2378]\d{4}|43\d{4})$/.test(code);
  return false;
}

export function isExchangeFundCode(code: string, suffix: string): boolean {
  if (suffix === 'SH') return /^(50|51|52|53|55|56|58)\d{4}$/.test(code);
  if (suffix === 'SZ') return /^(15|16|18)\d{4}$/.test(code);
  return false;
}

export function inferSuffixFromCode(code: string): MarketSuffix {
  if (/^(5|6|9)\d{5}$/.test(code)) return 'SH';
  if (/^(0|1|2|3)\d{5}$/.test(code)) return 'SZ';
  if (/^(4|8)\d{5}$/.test(code)) return 'BJ';
  return 'SZ';
}

export function inferExchangeLabel(suffix: string): string | null {
  if (suffix === 'SH') return 'SSE';
  if (suffix === 'SZ') return 'SZSE';
  if (suffix === 'BJ') return 'BSE';
  return null;
}

export function parseTsCode(rawCode: string): ParsedTsCode {
  const clean = rawCode.trim().toUpperCase();
  const [code, suffix = ''] = clean.split('.');
  if (suffix === 'SH') {
    return { tsCode: clean, code, suffix, tdxMarket: 1, tencentSymbol: `sh${code}`, eastmoneySecid: `1.${code}` };
  }
  if (suffix === 'SZ') {
    return { tsCode: clean, code, suffix, tdxMarket: 0, tencentSymbol: `sz${code}`, eastmoneySecid: `0.${code}` };
  }
  if (suffix === 'BJ') {
    return { tsCode: clean, code, suffix, tdxMarket: null, tencentSymbol: `bj${code}`, eastmoneySecid: `0.${code}` };
  }
  return { tsCode: clean, code, suffix, tdxMarket: null, tencentSymbol: '', eastmoneySecid: null };
}

export function inferMarketBoard(code: string, suffix: string): string | null {
  if (suffix === 'BJ') return '北交所';
  if (suffix === 'SZ') {
    if (/^(300|301)/.test(code)) return '创业板';
    return '主板';
  }
  if (suffix === 'SH') {
    if (/^(688|689)/.test(code)) return '科创板';
    return '主板';
  }
  return null;
}

/**
 * 计算法定/规则默认涨跌停价，仅供运行时下单/风控参考校验；
 * **严禁持久化写入 `stk_limit` 冒充交易所官方涨跌停价**。
 */
export function computeDefaultLimitPrices(
  preClose: number | null,
  tsCode: string,
  name?: string | null,
): { up_limit: number | null; down_limit: number | null } {
  if (preClose == null || !Number.isFinite(preClose) || preClose <= 0) {
    return { up_limit: null, down_limit: null };
  }
  const { code, suffix } = parseTsCode(tsCode);
  const isFund = isExchangeFundCode(code, suffix);
  const decimals = isFund ? 3 : 2;
  let pct = 0.1;
  if (suffix === 'BJ') pct = 0.3;
  else if (isFund) pct = /^(588|589|159915|158)/.test(code) ? 0.2 : 0.1;
  else if (/^(300|301|688|689)/.test(code)) pct = 0.2;
  else if (/ST|退/i.test(name ?? '')) pct = 0.05;
  return {
    up_limit: roundTo(preClose * (1 + pct), decimals),
    down_limit: roundTo(preClose * (1 - pct), decimals),
  };
}

export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: cap }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
