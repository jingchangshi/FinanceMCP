import {
  finiteOrNull, inferSuffixFromCode, parseTsCode, positiveOrNull,
  roundTo, runPool,
} from './types.js';

export interface TencentQuoteRow {
  ts_code: string;
  symbol: string;
  name: string;
  trade_date: string;
  quote_time?: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  pre_close: number | null;
  change: number | null;
  pct_chg: number | null;
  /** 手；null = 未知（不得伪造为 0） */
  vol: number | null;
  /** 千元；null = 上游未返回成交额（未知，不是 0，不能当作停牌或零成交证据） */
  amount: number | null;
  turnover_rate: number | null;
  pe_ttm: number | null;
  pb: number | null;
  volume_ratio: number | null;
  /** 万元 */
  circ_mv: number | null;
  /** 万元 */
  total_mv: number | null;
  up_limit: number | null;
  down_limit: number | null;
}

const gbkDecoder = new TextDecoder('gbk');

export function parseTencentQuoteLine(line: string): TencentQuoteRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx <= 0) return null;
  const key = trimmed.slice(0, eqIdx).trim();
  const body = trimmed.slice(eqIdx + 1).replace(/^"|"$/g, '').replace(/";$/, '');
  if (!body || body.startsWith('pv_none_match')) return null;

  const p = body.split('~');
  if (p.length < 40) return null;

  const symMatch = key.match(/^v_(sh|sz|bj)(\d{6})$/i);
  const code = (p[2] || symMatch?.[2] || '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  const suffix = symMatch ? symMatch[1].toUpperCase() : inferSuffixFromCode(code);
  const tsCode = `${code}.${suffix}`;
  const name = (p[1] ?? '').trim();

  const dateDigits = (p[30] ?? '').replace(/\D/g, '');
  if (dateDigits.length < 8) return null;
  const tradeDate = dateDigits.slice(0, 8);
  const quoteTime = dateDigits.length >= 14
    ? `${dateDigits.slice(8, 10)}:${dateDigits.slice(10, 12)}:${dateDigits.slice(12, 14)}`
    : null;

  const close = finiteOrNull(p[3]);
  const preClose = finiteOrNull(p[4]);
  const open = finiteOrNull(p[5]);
  const high = finiteOrNull(p[33]);
  const low = finiteOrNull(p[34]);
  const change = finiteOrNull(p[31]);
  const pctChg = finiteOrNull(p[32]);
  const vol = finiteOrNull(p[6]);

  let amountQian: number | null = null;
  const amtTuple = (p[35] ?? '').split('/');
  if (amtTuple.length >= 3 && finiteOrNull(amtTuple[2]) !== null) {
    amountQian = Number(amtTuple[2]) / 1000;
  } else {
    const amtWan = finiteOrNull(p[37]);
    if (amtWan !== null) amountQian = amtWan * 10;
  }

  const turnoverRate = finiteOrNull(p[38]);
  const peTtm = positiveOrNull(p[39]);
  const circYi = finiteOrNull(p[44]);
  const totalYi = finiteOrNull(p[45]);
  const pb = positiveOrNull(p[46]);
  // 涨跌停价只保留上游腾讯行情提供的原始字段，不回退规则推算值（避免冒充交易所限价持久化）。
  const upLimit = positiveOrNull(p[47]);
  const downLimit = positiveOrNull(p[48]);
  const volumeRatio = positiveOrNull(p[49]);

  return {
    ts_code: tsCode,
    symbol: code,
    name,
    trade_date: tradeDate,
    quote_time: quoteTime,
    open,
    high,
    low,
    close,
    pre_close: preClose,
    change,
    pct_chg: pctChg,
    vol,
    amount: amountQian !== null ? Math.round(amountQian * 10000) / 10000 : null,
    turnover_rate: turnoverRate,
    pe_ttm: peTtm,
    pb,
    volume_ratio: volumeRatio,
    circ_mv: circYi !== null && circYi > 0 ? roundTo(circYi * 10000, 4) : null,
    total_mv: totalYi !== null && totalYi > 0 ? roundTo(totalYi * 10000, 4) : null,
    up_limit: upLimit,
    down_limit: downLimit,
  };
}

async function fetchTextGbkWithRetry(url: string, retries = 2, timeoutMs = 8000): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return gbkDecoder.decode(buf);
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function fetchTencentQuotes(
  tsCodes: readonly string[],
  opts: { batchSize?: number; concurrency?: number } = {},
): Promise<Map<string, TencentQuoteRow>> {
  const batchSize = Math.max(1, Math.min(80, opts.batchSize ?? 80));
  const concurrency = Math.max(1, Math.min(12, opts.concurrency ?? 8));
  const symbols = [...new Set(
    tsCodes
      .map(c => parseTsCode(c).tencentSymbol)
      .filter(Boolean),
  )];
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    chunks.push(symbols.slice(i, i + batchSize));
  }

  const map = new Map<string, TencentQuoteRow>();
  await runPool(chunks, concurrency, async chunk => {
    const raw = await fetchTextGbkWithRetry(`https://qt.gtimg.cn/q=${chunk.join(',')}`);
    for (const line of raw.split(/\r?\n/)) {
      const row = parseTencentQuoteLine(line);
      if (row) map.set(row.ts_code, row);
    }
  });
  return map;
}

export interface TencentDailyBar {
  ts_code: string;
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number | null;
  pct_chg: number | null;
  /** 手 */
  vol: number;
  /** 千元；腾讯日K不返回精确成交额，恒为 null（未知），优先用 TDX/东财补齐 */
  amount: number | null;
}

export async function fetchTencentDailyBars(
  tsCode: string,
  start: string,
  end: string,
): Promise<TencentDailyBar[]> {
  const { tencentSymbol } = parseTsCode(tsCode);
  if (!tencentSymbol) return [];
  const isoStart = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`;
  const isoEnd = `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentSymbol},day,${isoStart},${isoEnd},640,bfq`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Tencent daily HTTP ${res.status}`);
  const payload = await res.json() as any;
  // 只接受不复权（bfq）日线。qfqday 是前复权价，若拿来当原始价会把复权跳空
  // 混进 raw 价格序列，PRE_CLOSE 与 adj_factor 随之全部错误。
  const items = payload?.data?.[tencentSymbol]?.day;
  if (!Array.isArray(items)) return [];

  const bars: TencentDailyBar[] = [];
  let prevClose: number | null = null;
  for (const row of items) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const tradeDate = String(row[0]).replace(/\D/g, '').slice(0, 8);
    if (tradeDate.length !== 8 || tradeDate < start || tradeDate > end) continue;
    const open = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    const vol = Number(row[5]);
    const pctChg = prevClose && prevClose > 0 ? roundTo(((close - prevClose) / prevClose) * 100, 4) : null;
    bars.push({
      ts_code: tsCode,
      trade_date: tradeDate,
      open,
      high,
      low,
      close,
      pre_close: prevClose,
      pct_chg: pctChg,
      vol: Number.isFinite(vol) ? vol : 0,
      amount: null,
    });
    prevClose = Number.isFinite(close) && close > 0 ? close : prevClose;
  }
  return bars;
}
