import {
  finiteOrNull, normalizeYmd, parseTsCode, positiveOrNull, roundTo, runPool,
  shanghaiDateFromEpochSec, shanghaiTodayYmd,
} from './types.js';

const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

async function fetchJsonWithRetry(url: string, headers: Record<string, string> = HEADERS, retries = 2, timeoutMs = 9000): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

export interface EastmoneyCrossRow {
  ts_code: string;
  symbol: string;
  name: string;
  trade_date: string;
  close: number | null;
  pct_chg: number | null;
  change: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  pre_close: number | null;
  /** 手 */
  vol: number;
  /** 千元 */
  amount: number;
  turnover_rate: number | null;
  volume_ratio: number | null;
  pe_ttm: number | null;
  pb: number | null;
  ps_ttm: number | null;
  /** 万元 */
  total_mv: number | null;
  /** 万元 */
  circ_mv: number | null;
  list_date: string | null;
  industry: string | null;
}

const PUSH2_FIELDS = 'f2,f3,f4,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f26,f100,f115,f124,f130';

function parseEastmoneyCrossItem(item: Record<string, any>): EastmoneyCrossRow | null {
  const code = String(item.f12 ?? '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  const market = Number(item.f13);
  const suffix = market === 1 ? 'SH' : (/^(92|8[2378]|43)\d{4}$/.test(code) ? 'BJ' : 'SZ');
  const tsCode = `${code}.${suffix}`;
  const tradeDate = shanghaiDateFromEpochSec(Number(item.f124)) ?? shanghaiTodayYmd();
  const amountYuan = finiteOrNull(item.f6) ?? 0;
  const totalMvYuan = positiveOrNull(item.f20);
  const circMvYuan = positiveOrNull(item.f21);
  const listRaw = normalizeYmd(item.f26);

  return {
    ts_code: tsCode,
    symbol: code,
    name: String(item.f14 ?? '').trim(),
    trade_date: tradeDate,
    close: positiveOrNull(item.f2),
    pct_chg: finiteOrNull(item.f3),
    change: finiteOrNull(item.f4),
    vol: finiteOrNull(item.f5) ?? 0,
    amount: Math.round((amountYuan / 1000) * 10000) / 10000,
    turnover_rate: finiteOrNull(item.f8),
    volume_ratio: positiveOrNull(item.f10),
    high: positiveOrNull(item.f15),
    low: positiveOrNull(item.f16),
    open: positiveOrNull(item.f17),
    pre_close: positiveOrNull(item.f18),
    total_mv: totalMvYuan !== null ? roundTo(totalMvYuan / 10000, 4) : null,
    circ_mv: circMvYuan !== null ? roundTo(circMvYuan / 10000, 4) : null,
    pb: positiveOrNull(item.f23),
    pe_ttm: positiveOrNull(item.f115),
    ps_ttm: positiveOrNull(item.f130),
    list_date: listRaw,
    industry: typeof item.f100 === 'string' && item.f100 !== '-' ? item.f100.trim() : null,
  };
}

export async function fetchEastmoneyCrossSection(kind: 'stock' | 'fund'): Promise<Map<string, EastmoneyCrossRow>> {
  const fs = kind === 'stock'
    ? 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
    : 'b:MK0021,b:MK0022,b:MK0023,b:MK0024,m:0+t:5,m:1+t:3';
  const base = `https://push2.eastmoney.com/api/qt/clist/get?pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=${PUSH2_FIELDS}`;

  const first = await fetchJsonWithRetry(`${base}&pn=1`);
  const total = Number(first?.data?.total ?? 0);
  const firstDiff: Record<string, any>[] = Array.isArray(first?.data?.diff) ? first.data.diff : [];
  const totalPages = Math.max(1, Math.ceil(total / 100));
  const pageNums = Array.from({ length: Math.max(0, totalPages - 1) }, (_, idx) => idx + 2);
  const pages = await runPool(pageNums, 5, async pn => {
    const j = await fetchJsonWithRetry(`${base}&pn=${pn}`);
    return Array.isArray(j?.data?.diff) ? (j.data.diff as Record<string, any>[]) : [];
  });

  const out = new Map<string, EastmoneyCrossRow>();
  for (const list of [firstDiff, ...pages]) {
    for (const raw of list) {
      const parsed = parseEastmoneyCrossItem(raw);
      if (parsed) out.set(parsed.ts_code, parsed);
    }
  }
  return out;
}

export interface EastmoneyKlineBar {
  ts_code: string;
  trade_date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 手 */
  vol: number;
  /** 千元 */
  amount: number;
  pct_chg: number | null;
  change: number | null;
  pre_close: number | null;
}

export async function fetchEastmoneyKlines(
  tsCode: string,
  start: string,
  end: string,
): Promise<EastmoneyKlineBar[]> {
  const { eastmoneySecid } = parseTsCode(tsCode);
  if (!eastmoneySecid) return [];
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneySecid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=${start}&end=${end}`;
  const json = await fetchJsonWithRetry(url);
  const lines: string[] = Array.isArray(json?.data?.klines) ? json.data.klines : [];
  const out: EastmoneyKlineBar[] = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 7) continue;
    const tradeDate = normalizeYmd(p[0]);
    if (!tradeDate || tradeDate < start || tradeDate > end) continue;
    const open = Number(p[1]);
    const close = Number(p[2]);
    const high = Number(p[3]);
    const low = Number(p[4]);
    const vol = Number(p[5]);
    const amountYuan = Number(p[6]);
    const pctChg = finiteOrNull(p[8]);
    const change = finiteOrNull(p[9]);
    const preClose = change !== null && Number.isFinite(close) ? roundTo(close - change, 4) : null;
    out.push({
      ts_code: tsCode,
      trade_date: tradeDate,
      open,
      close,
      high,
      low,
      vol: Number.isFinite(vol) ? vol : 0,
      amount: Number.isFinite(amountYuan) ? roundTo(amountYuan / 1000, 4) : 0,
      pct_chg: pctChg,
      change,
      pre_close: preClose,
    });
  }
  return out;
}

export interface EastmoneyFundNavRow {
  ts_code: string;
  ann_date: string;
  nav_date: string;
  unit_nav: number;
  accum_nav: number | null;
  adj_nav: number | null;
}

export async function fetchEastmoneyFundNav(
  tsCode: string,
  pageSize = 20,
): Promise<EastmoneyFundNavRow[]> {
  const { code } = parseTsCode(tsCode);
  if (!/^\d{6}$/.test(code)) return [];
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${pageSize}`;
  const json = await fetchJsonWithRetry(url, {
    ...HEADERS,
    Referer: 'https://fundf10.eastmoney.com/',
  });
  const list: any[] = Array.isArray(json?.Data?.LSJZList) ? json.Data.LSJZList : [];
  const out: EastmoneyFundNavRow[] = [];
  for (const item of list) {
    const navDate = normalizeYmd(item.FSRQ);
    const unitNav = positiveOrNull(item.DWJZ);
    if (!navDate || unitNav === null) continue;
    const accumNav = positiveOrNull(item.LJJZ);
    out.push({
      ts_code: tsCode,
      ann_date: navDate,
      nav_date: navDate,
      unit_nav: unitNav,
      accum_nav: accumNav,
      adj_nav: accumNav ?? unitNav,
    });
  }
  return out;
}

export interface EastmoneyFinancialRow {
  ts_code: string;
  ann_date: string;
  end_date: string;
  roe: number | null;
  roe_dt: number | null;
  netprofit_yoy: number | null;
  dt_netprofit_yoy: number | null;
  or_yoy: number | null;
  grossprofit_margin: number | null;
  debt_to_assets: number | null;
  ocf_to_profit: number | null;
  ocfps: number | null;
  eps: number | null;
  update_flag: string;
}

async function fetchDatacenterReport(
  reportName: string,
  dateField: string,
  isoPeriod: string,
  columns: string,
): Promise<Record<string, any>[]> {
  const filter = encodeURIComponent(`(${dateField}='${isoPeriod}')`);
  const base = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}&columns=${columns}&pageSize=500&filter=${filter}`;
  const first = await fetchJsonWithRetry(`${base}&pageNumber=1`, HEADERS, 2, 12000);
  const result = first?.result;
  if (!result || !Array.isArray(result.data)) return [];
  const totalPages = Math.max(1, Number(result.pages ?? 1));
  const pageNums = Array.from({ length: Math.max(0, totalPages - 1) }, (_, idx) => idx + 2);
  const rest = await runPool(pageNums, 4, async pn => {
    const j = await fetchJsonWithRetry(`${base}&pageNumber=${pn}`, HEADERS, 2, 12000);
    return Array.isArray(j?.result?.data) ? (j.result.data as Record<string, any>[]) : [];
  });
  return [result.data, ...rest].flat();
}

export async function fetchEastmoneyFinancials(period: string): Promise<EastmoneyFinancialRow[]> {
  if (!/^\d{8}$/.test(period)) return [];
  const isoPeriod = `${period.slice(0, 4)}-${period.slice(4, 6)}-${period.slice(6, 8)}`;
  const [cpdRows, balRows, cfRows] = await Promise.all([
    fetchDatacenterReport(
      'RPT_LICO_FN_CPD',
      'REPORTDATE',
      isoPeriod,
      'SECUCODE,NOTICE_DATE,REPORTDATE,BASIC_EPS,WEIGHTAVG_ROE,YSTZ,SJLTZ,XSMLL,MGJYXJJE,PARENT_NETPROFIT',
    ),
    fetchDatacenterReport(
      'RPT_DMSK_FN_BALANCE',
      'REPORT_DATE',
      isoPeriod,
      'SECUCODE,DEBT_ASSET_RATIO',
    ).catch(() => []),
    // 现金流请求失败必须向上抛出：之前用 `.catch(() => [])` 吞掉异常，会让全市场
    // ocf_to_profit 静默变成 null，质量核心的现金流条件整体失效。上抛后由
    // resolveFinancials 回退到本地已缓存报告期，或由同步层记录 REFRESH_FAILED。
    fetchDatacenterReport(
      'RPT_DMSK_FN_CASHFLOW',
      'REPORT_DATE',
      isoPeriod,
      'SECUCODE,NETCASH_OPERATE',
    ),
  ]);

  const debtMap = new Map<string, number>();
  for (const r of balRows) {
    const code = String(r.SECUCODE ?? '').trim().toUpperCase();
    const debt = finiteOrNull(r.DEBT_ASSET_RATIO);
    if (code && debt !== null) debtMap.set(code, roundTo(debt, 4));
  }
  const ocfMap = new Map<string, number>();
  for (const r of cfRows) {
    const code = String(r.SECUCODE ?? '').trim().toUpperCase();
    const ocf = finiteOrNull(r.NETCASH_OPERATE);
    if (code && ocf !== null) ocfMap.set(code, ocf);
  }

  const out: EastmoneyFinancialRow[] = [];
  for (const r of cpdRows) {
    const tsCode = String(r.SECUCODE ?? '').trim().toUpperCase();
    const annDate = normalizeYmd(r.NOTICE_DATE);
    const endDate = normalizeYmd(r.REPORTDATE) ?? period;
    if (!tsCode || !annDate) continue;
    const roe = finiteOrNull(r.WEIGHTAVG_ROE);
    const profitYoy = finiteOrNull(r.SJLTZ);
    const netProfit = finiteOrNull(r.PARENT_NETPROFIT);
    const netOcf = ocfMap.get(tsCode) ?? null;
    let ocfToProfit: number | null = null;
    if (netOcf !== null && netProfit !== null && Math.abs(netProfit) > 1e-6) {
      if (netProfit > 0) ocfToProfit = roundTo((netOcf / netProfit) * 100, 4);
      else ocfToProfit = netOcf < 0 ? roundTo(-Math.abs(netOcf / netProfit) * 100, 4) : 0;
    }
    // 口径说明（已知上游定义差异，不是 bug）：本字段 = 经营活动现金净流量 / 归母净利润 × 100，
    // 与 V3 规格「OCF / 归母净利」一致；TactiCore 快照里的同名 `ocf_to_profit` 来自
    // Tushare fina_indicator（经营净收益口径），两者分母不同，跨源比较阈值时须注意。
    // 在没有回归测试锁定前，绝不静默改变这个公开字段的含义。
    out.push({
      ts_code: tsCode,
      ann_date: annDate,
      end_date: endDate,
      roe: roe !== null ? roundTo(roe, 4) : null,
      roe_dt: roe !== null ? roundTo(roe, 4) : null,
      netprofit_yoy: profitYoy !== null ? roundTo(profitYoy, 4) : null,
      dt_netprofit_yoy: profitYoy !== null ? roundTo(profitYoy, 4) : null,
      or_yoy: finiteOrNull(r.YSTZ) !== null ? roundTo(Number(r.YSTZ), 4) : null,
      grossprofit_margin: finiteOrNull(r.XSMLL) !== null ? roundTo(Number(r.XSMLL), 4) : null,
      debt_to_assets: debtMap.get(tsCode) ?? null,
      ocf_to_profit: ocfToProfit,
      ocfps: finiteOrNull(r.MGJYXJJE) !== null ? roundTo(Number(r.MGJYXJJE), 4) : null,
      eps: finiteOrNull(r.BASIC_EPS) !== null ? roundTo(Number(r.BASIC_EPS), 4) : null,
      update_flag: '0',
    });
  }
  return out;
}
