import type { DatabaseSync } from 'node:sqlite';
import { finiteOrNull, roundTo, runPool } from './types.js';

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

// ---------------------------------------------------------------- Free Catalogs (SW2021 via legulegu + THS Industry via 10jqka)

export interface SwClassifyRow {
  index_code: string;
  level: 'L1' | 'L2' | 'L3';
  name: string;
  industry_code: string;
  parent_code: string;
  src: string;
  is_pub: string;
  collected_at: string;
}

export interface SwMemberRow {
  ts_code: string;
  l1_code: string;
  l2_code: string;
  l3_code: string;
  l1_name: string;
  l2_name: string;
  l3_name: string;
  name: string;
  in_date: string;
  out_date: string;
  is_new: string;
  collected_at: string;
}

export interface ThsIndexRow {
  ts_code: string;
  name: string;
  idx_type: string;
  exchange: string;
  collected_at: string;
}

function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sliceIdSection(html: string, id: string, nextIds: string[]): string {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return '';
  let end = html.length;
  for (const nid of nextIds) {
    const idx = html.indexOf(`id="${nid}"`, start + id.length);
    if (idx > start && idx < end) end = idx;
  }
  return html.slice(start, end);
}

export function parseLeguleguSwClassifyHtml(html: string, collectedAt = new Date().toISOString()): SwClassifyRow[] {
  const levels: Array<{ id: string; nextIds: string[]; level: 'L1' | 'L2' | 'L3' }> = [
    { id: 'level1Items', nextIds: ['level2Items', 'level3Items'], level: 'L1' },
    { id: 'level2Items', nextIds: ['level3Items'], level: 'L2' },
    { id: 'level3Items', nextIds: [], level: 'L3' },
  ];
  const parsed: Array<{ index_code: string; level: 'L1' | 'L2' | 'L3'; name: string; parentName: string | null }> = [];
  const l1ByName = new Map<string, string>();
  const l2ByName = new Map<string, string>();

  for (const spec of levels) {
    const chunk = sliceIdSection(html, spec.id, spec.nextIds);
    if (!chunk) continue;
    const itemRe = /lg-industries-item-chinese-title[^>]*>\s*([^<\s]+)[\s\S]*?lg-industries-item-number[^>]*>([\s\S]*?)<\/div>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(chunk)) !== null) {
      const indexCode = m[1].trim();
      const numText = stripHtmlTags(m[2]);
      const nameMatch = numText.match(/^([^\(\[]+)/);
      const name = (nameMatch?.[1] ?? '').trim();
      if (!/^\d{6}\.SI$/i.test(indexCode) || !name) continue;
      const parentMatch = numText.match(/\[([^\]]+)\]/);
      const parentName = parentMatch ? parentMatch[1].trim() : null;
      const normalizedCode = indexCode.toUpperCase();
      if (spec.level === 'L1') l1ByName.set(name, normalizedCode);
      if (spec.level === 'L2') l2ByName.set(name, normalizedCode);
      parsed.push({ index_code: normalizedCode, level: spec.level, name, parentName });
    }
  }

  return parsed.map(item => {
    let parentCode = '0';
    if (item.level === 'L2' && item.parentName) {
      parentCode = l1ByName.get(item.parentName) ?? '0';
    } else if (item.level === 'L3' && item.parentName) {
      parentCode = l2ByName.get(item.parentName) ?? '0';
    }
    const code6 = item.index_code.split('.')[0];
    return {
      index_code: item.index_code,
      level: item.level,
      name: item.name,
      industry_code: `${code6.slice(2)}00`,
      parent_code: parentCode,
      src: 'SW2021',
      is_pub: '1',
      collected_at: collectedAt,
    };
  });
}

export async function fetchSwClassifyFromLegulegu(
  opts: { minL1?: number; minL2?: number; minL3?: number; timeoutMs?: number } = {},
): Promise<SwClassifyRow[]> {
  const minL1 = opts.minL1 ?? 25;
  const minL2 = opts.minL2 ?? 100;
  const minL3 = opts.minL3 ?? 250;
  const res = await fetch('https://legulegu.com/stockdata/sw-industry-overview', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
  });
  if (!res.ok) throw new Error(`legulegu sw-industry-overview HTTP ${res.status}`);
  const html = await res.text();
  const rows = parseLeguleguSwClassifyHtml(html);
  const c1 = rows.filter(r => r.level === 'L1').length;
  const c2 = rows.filter(r => r.level === 'L2').length;
  const c3 = rows.filter(r => r.level === 'L3').length;
  if (c1 < minL1 || c2 < minL2 || c3 < minL3) {
    throw new Error(`legulegu sw_classify incomplete: L1=${c1}, L2=${c2}, L3=${c3}`);
  }
  return rows;
}

export function parseLeguleguCompositionHtml(
  html: string,
  meta: { l1Code: string; l1Name: string; l2Code: string; l2Name: string; l3Code: string; l3Name: string },
  collectedAt = new Date().toISOString(),
): SwMemberRow[] {
  const out: SwMemberRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      cells.push(stripHtmlTags(cm[1]));
    }
    if (cells.length < 4) continue;
    const tsCode = (cells[1] ?? '').trim().toUpperCase();
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(tsCode)) continue;
    const stockName = (cells[2] ?? '').trim();
    const rawInDate = (cells[3] ?? '').trim().replace(/-/g, '');
    const inDate = /^\d{8}$/.test(rawInDate) ? rawInDate : '';
    out.push({
      ts_code: tsCode,
      l1_code: meta.l1Code,
      l2_code: meta.l2Code,
      l3_code: meta.l3Code,
      l1_name: meta.l1Name,
      l2_name: meta.l2Name,
      l3_name: meta.l3Name,
      name: stockName,
      in_date: inDate,
      out_date: '',
      is_new: 'Y',
      collected_at: collectedAt,
    });
  }
  return out;
}

export async function fetchSwMembersFromLegulegu(
  classifyRows: Array<{ index_code: string; level: string | null; name: string | null; parent_code: string | null }>,
  opts: { concurrency?: number; timeoutMs?: number; minUniqueStocks?: number; maxFailureRatio?: number } = {},
): Promise<SwMemberRow[]> {
  const byCode = new Map(classifyRows.map(r => [r.index_code, r]));
  const l3Rows = classifyRows.filter(r => r.level === 'L3');
  if (!l3Rows.length) throw new Error('sw_classify has no L3 entries');

  const collectedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 12000;
  let failed = 0;
  const nested = await runPool(l3Rows, opts.concurrency ?? 4, async l3 => {
    const l2 = l3.parent_code ? byCode.get(l3.parent_code) : undefined;
    const l1 = l2?.parent_code ? byCode.get(l2.parent_code) : undefined;
    const meta = {
      l1Code: l1?.index_code ?? '',
      l1Name: l1?.name ?? '',
      l2Code: l2?.index_code ?? '',
      l2Name: l2?.name ?? '',
      l3Code: l3.index_code,
      l3Name: l3.name ?? '',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://legulegu.com/stockdata/index-composition?industryCode=${encodeURIComponent(l3.index_code)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        return parseLeguleguCompositionHtml(html, meta, collectedAt);
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 250));
      }
    }
    failed++;
    return [] as SwMemberRow[];
  });

  const maxFailureRatio = opts.maxFailureRatio ?? 0.2;
  if (failed / l3Rows.length > maxFailureRatio) {
    throw new Error(`legulegu sw_member too many failures: ${failed}/${l3Rows.length}`);
  }
  const flat = nested.flat();
  const uniqueStocks = new Set(flat.map(r => r.ts_code)).size;
  const minUniqueStocks = opts.minUniqueStocks ?? 3000;
  if (uniqueStocks < minUniqueStocks) {
    throw new Error(`legulegu sw_member incomplete: uniqueStocks=${uniqueStocks} < ${minUniqueStocks}`);
  }
  return flat;
}

export function parseThsIndustryIndexHtml(html: string, collectedAt = new Date().toISOString()): ThsIndexRow[] {
  const seen = new Map<string, ThsIndexRow>();
  const re = /\/thshy\/detail\/code\/(88\d{4})\/"[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tsCode = `${m[1]}.TI`;
    const name = stripHtmlTags(m[2]);
    if (!name || seen.has(tsCode)) continue;
    seen.set(tsCode, {
      ts_code: tsCode,
      name,
      idx_type: 'I',
      exchange: 'A',
      collected_at: collectedAt,
    });
  }
  return [...seen.values()];
}

export async function fetchThsIndustryIndexFrom10jqka(
  opts: { minCount?: number; timeoutMs?: number } = {},
): Promise<ThsIndexRow[]> {
  const res = await fetch('https://q.10jqka.com.cn/thshy/', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://q.10jqka.com.cn/' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
  });
  if (!res.ok) throw new Error(`10jqka thshy HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const html = new TextDecoder('gbk').decode(buf);
  const rows = parseThsIndustryIndexHtml(html);
  const minCount = opts.minCount ?? 50;
  if (rows.length < minCount) {
    throw new Error(`10jqka ths_index incomplete: ${rows.length} < ${minCount}`);
  }
  return rows;
}
