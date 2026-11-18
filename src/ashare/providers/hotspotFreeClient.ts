import type { DatabaseSync } from 'node:sqlite';
import { finiteOrNull, roundTo } from './types.js';

export interface IndustryDailyRow {
  ts_code: string;
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  pre_close?: number | null;
  avg_price?: number | null;
  change: number | null;
  pct_change: number | null;
  vol: number;
  amount?: number | null;
  pe?: number | null;
  pb?: number | null;
  float_mv?: number | null;
  total_mv?: number | null;
  turnover_rate?: number | null;
}

function tradeDatesInRange(db: DatabaseSync | null, start: string, end: string): string[] {
  if (!db) return [];
  const rows = db.prepare(
    'SELECT DISTINCT trade_date FROM daily WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date',
  ).all(start, end) as Array<{ trade_date: string }>;
  return rows.map(r => r.trade_date);
}

/**
 * 通过经验证 HTTPS 同花顺接口抓取 `88xxxx.TI` 板块日线；
 * 对于 404/不可得板块（如 `700xxx.TI`），自动回退成员加权合成。
 */
export async function fetchThsKlineRemote(tsCode: string, start: string, end: string): Promise<IndustryDailyRow[] | null> {
  const code6 = tsCode.split('.')[0];
  if (!/^88\d{4}$/.test(code6)) return null;
  const url = `https://d.10jqka.com.cn/v4/line/bk_${code6}/01/last.js`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://q.10jqka.com.cn/',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lp = text.indexOf('(');
    const rp = text.lastIndexOf(')');
    if (lp < 0 || rp <= lp) return null;
    const parsed = JSON.parse(text.slice(lp + 1, rp)) as { data?: string };
    if (!parsed?.data) return null;

    const out: IndustryDailyRow[] = [];
    let prevClose: number | null = null;
    for (const entry of parsed.data.split(';')) {
      if (!entry) continue;
      const p = entry.split(',');
      const ymd = (p[0] ?? '').trim();
      if (!/^\d{8}$/.test(ymd)) continue;
      const open = finiteOrNull(p[1]);
      const high = finiteOrNull(p[2]);
      const low = finiteOrNull(p[3]);
      const close = finiteOrNull(p[4]);
      const vol = finiteOrNull(p[5]) ?? 0;
      const amountYuan = finiteOrNull(p[6]);
      if (close !== null && close > 0 && ymd >= start && ymd <= end) {
        const change = prevClose !== null ? roundTo(close - prevClose, 4) : null;
        const pctChange = prevClose !== null && prevClose > 0 ? roundTo((change! / prevClose) * 100, 4) : null;
        out.push({
          ts_code: tsCode,
          trade_date: ymd,
          open,
          high,
          low,
          close,
          pre_close: prevClose,
          avg_price: vol > 0 && amountYuan !== null ? roundTo(amountYuan / (vol * 100), 4) : null,
          change,
          pct_change: pctChange,
          vol,
          amount: amountYuan !== null ? roundTo(amountYuan / 1000, 4) : null,
          turnover_rate: finiteOrNull(p[8]),
        });
      }
      if (close !== null && close > 0) prevClose = close;
    }
    return out;
  } catch {
    return null;
  }
}

function synthesizeSectorBars(
  db: DatabaseSync,
  table: 'sw_index_daily' | 'ths_index_daily',
  memberQuerySql: string,
  code: string,
  start: string,
  end: string,
): IndustryDailyRow[] {
  const days = tradeDatesInRange(db, start, end);
  if (!days.length) return [];

  const prevCloseRow = db.prepare(
    `SELECT close FROM ${table} WHERE ts_code = ? AND trade_date < ? AND close > 0 ORDER BY trade_date DESC LIMIT 1`,
  ).get(code, start) as { close?: number } | undefined;
  let runningClose = prevCloseRow?.close && prevCloseRow.close > 0 ? prevCloseRow.close : 1000;

  const memberStmt = db.prepare(memberQuerySql);
  const out: IndustryDailyRow[] = [];

  for (const day of days) {
    const existing = db.prepare(
      `SELECT close FROM ${table} WHERE ts_code = ? AND trade_date = ? AND close > 0`,
    ).get(code, day) as { close?: number } | undefined;

    const rows = (table === 'sw_index_daily'
      ? memberStmt.all(day, code, day, day)
      : memberStmt.all(day, code)) as Array<{
      open: number | null; high: number | null; low: number | null; close: number | null;
      pre_close: number | null; pct_chg: number | null; vol: number | null; amount: number | null;
      circ_mv: number | null; total_mv: number | null; turnover_rate: number | null;
    }>;
    if (!rows.length) continue;

    let wSum = 0;
    let wPctSum = 0;
    let totalVol = 0;
    let totalAmount = 0;
    let floatMv = 0;
    let totalMv = 0;
    let turnSum = 0;
    let turnCount = 0;

    for (const r of rows) {
      totalVol += r.vol ?? 0;
      totalAmount += r.amount ?? 0;
      floatMv += r.circ_mv ?? 0;
      totalMv += r.total_mv ?? 0;
      if (r.turnover_rate != null && Number.isFinite(r.turnover_rate)) {
        turnSum += r.turnover_rate;
        turnCount++;
      }
      if (r.pct_chg != null && Number.isFinite(r.pct_chg)) {
        const w = r.circ_mv && r.circ_mv > 0 ? r.circ_mv : 1;
        wSum += w;
        wPctSum += w * r.pct_chg;
      }
    }

    const avgPct = wSum > 0 ? wPctSum / wSum : 0;
    const preClose = runningClose;
    const close = existing?.close ?? roundTo(preClose * (1 + avgPct / 100), 4);
    const change = roundTo(close - preClose, 4);
    const pctChange = preClose > 0 ? roundTo((change / preClose) * 100, 4) : roundTo(avgPct, 4);
    runningClose = close;

    out.push({
      ts_code: code,
      trade_date: day,
      open: preClose,
      high: Math.max(preClose, close),
      low: Math.min(preClose, close),
      close,
      pre_close: preClose,
      avg_price: null,
      change,
      pct_change: pctChange,
      vol: roundTo(totalVol, 2),
      amount: roundTo(totalAmount, 4),
      pe: null,
      pb: null,
      float_mv: floatMv > 0 ? roundTo(floatMv, 4) : null,
      total_mv: totalMv > 0 ? roundTo(totalMv, 4) : null,
      turnover_rate: turnCount > 0 ? roundTo(turnSum / turnCount, 4) : null,
    });
  }
  return out;
}

export async function fetchSwIndexDailyFree(
  db: DatabaseSync | null,
  tsCode: string,
  start: string,
  end: string,
): Promise<IndustryDailyRow[]> {
  if (!db) return [];
  return synthesizeSectorBars(
    db,
    'sw_index_daily',
    `SELECT d.open, d.high, d.low, d.close, d.pre_close, d.pct_chg, d.vol, d.amount, b.circ_mv, b.total_mv, b.turnover_rate
     FROM sw_member m
     JOIN daily d ON d.ts_code = m.ts_code AND d.trade_date = ?
     LEFT JOIN daily_basic b ON b.ts_code = d.ts_code AND b.trade_date = d.trade_date
     WHERE m.l1_code = ?
       AND (m.in_date IS NULL OR m.in_date = '' OR m.in_date <= ?)
       AND (m.out_date IS NULL OR m.out_date = '' OR m.out_date > ?)`,
    tsCode,
    start,
    end,
  );
}

export async function fetchThsIndexDailyFree(
  db: DatabaseSync | null,
  tsCode: string,
  start: string,
  end: string,
): Promise<IndustryDailyRow[]> {
  const remote = await fetchThsKlineRemote(tsCode, start, end);
  if (remote && remote.length > 0) return remote;
  if (!db) return [];
  return synthesizeSectorBars(
    db,
    'ths_index_daily',
    `SELECT d.open, d.high, d.low, d.close, d.pre_close, d.pct_chg, d.vol, d.amount, b.circ_mv, b.total_mv, b.turnover_rate
     FROM ths_member m
     JOIN daily d ON d.ts_code = m.con_code AND d.trade_date = ?
     LEFT JOIN daily_basic b ON b.ts_code = d.ts_code AND b.trade_date = d.trade_date
     WHERE m.ts_code = ?`,
    tsCode,
    start,
    end,
  );
}
