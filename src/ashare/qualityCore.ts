import type { DatabaseSync } from 'node:sqlite';
import { scanMarket } from './analysis.js';
import { rawFactors, sourceQualityForDate } from './engine.js';
import { recentTradeDays } from './ingest.js';

/** Explicit research baseline; thresholds are hypotheses, not a validated ranking. */
export const QUALITY_CORE_VERSION = 'quality-core/1.0';
export const QUALITY_CORE_RULES = [
  { id: 'close', rule: '基准日有效收盘价 > 0' },
  { id: 'amount20_yi', rule: '最近20个成交bar的日均成交额 >= 1亿元' },
  { id: 'circ_mv_yi', rule: '当日流通市值 >= 50亿元' },
  { id: 'roe', rule: '最近可用财报 ROE > 0%' },
  { id: 'eps', rule: '最近可用财报每股收益 > 0' },
  { id: 'ocf_to_profit', rule: '最近可用财报经营现金流/利润 > 0%' },
] as const;

export function qualityCore(db: DatabaseSync, asOf: string) {
  if (!/^\d{8}$/.test(asOf)) throw new Error('as_of must be YYYYMMDD');
  if (!recentTradeDays(db, asOf, 1).length) throw new Error('交易日历不可用');
  const basics = db.prepare('SELECT ts_code, name, list_date, delist_date, list_status FROM stock_basic ORDER BY ts_code').all() as unknown as {
    ts_code: string; name: string | null; list_date: string | null; delist_date: string | null; list_status: string | null;
  }[];
  const scan = scanMarket(db, asOf);
  const byCode = new Map(scan.rows.map(row => [row.ts_code, row]));
  const sourceQuality = sourceQualityForDate(db, asOf);
  const scopeExcluded = basics.flatMap(row => {
    const reasons: string[] = [];
    if (!row.name) reasons.push('名称缺失');
    else if (/ST|退/i.test(row.name)) reasons.push('ST/退市风险标记');
    if (!row.list_date) reasons.push('上市日期缺失');
    else if (row.list_date > asOf) reasons.push('尚未上市');
    if (!row.list_status) reasons.push('当前上市状态缺失');
    else if (row.list_status !== 'L') reasons.push('当前状态非上市');
    if (row.delist_date && row.delist_date <= asOf) reasons.push('已退市');
    return reasons.length ? [{ ts_code: row.ts_code, reasons }] : [];
  });
  const excludedCodes = new Set(scopeExcluded.map(row => row.ts_code));
  const scope = basics.filter(row => !excludedCodes.has(row.ts_code));
  const evaluations = scope.map(info => {
    const row = byCode.get(info.ts_code);
    const raw = row ? rawFactors(row, sourceQuality.get(info.ts_code)) : null;
    const values = {
      close: raw?.close ?? null,
      amount20_yi: row && row.bars >= 20 ? raw!.amount20_yi : null,
      circ_mv_yi: raw?.circ_mv_yi ?? null,
      roe: raw?.roe ?? null,
      eps: raw?.eps ?? null,
      ocf_to_profit: raw?.ocf_to_profit ?? null,
    };
    const checks = QUALITY_CORE_RULES.map(({ id, rule }) => {
      const value = values[id];
      const passed = value === null ? null : id === 'amount20_yi' ? value >= 1 : id === 'circ_mv_yi' ? value >= 50 : value > 0;
      return { id, rule, value, passed, reason: passed === null ? '数据缺失或不可用' : passed ? '通过' : '未达到阈值' };
    });
    return {
      ts_code: info.ts_code, name: info.name,
      financial_report: row?.fundamentals ? { end_date: row.fundamentals.end_date, ann_date: row.fundamentals.ann_date } : null,
      checks, passed: checks.every(check => check.passed === true),
      exclusion_reasons: checks.filter(check => check.passed !== true).map(check => ({ id: check.id, reason: check.reason })),
    };
  });
  const passed = evaluations.filter(row => row.passed);
  const excluded = evaluations.filter(row => !row.passed);
  const complete = evaluations.filter(row => row.checks.every(check => check.passed !== null)).length;
  return {
    version: QUALITY_CORE_VERSION, as_of: asOf, research_status: 'unvalidated' as const,
    status: basics.length === 0 ? 'UNAVAILABLE' as const : complete < scope.length || scopeExcluded.some(row => row.reasons.some(reason => reason.includes('缺失'))) ? 'DEGRADED' as const : 'OK' as const,
    rules: QUALITY_CORE_RULES,
    investable_scope: {
      count: scope.length, denominator: basics.length, scope_excluded: scopeExcluded,
      definition: '本地 stock_basic 当前状态为上市、名称非 ST/退且上市日期不晚于基准日的股票；缺少必要主数据不进入范围。主数据不是历史时点快照，也不能证明全市场覆盖。',
    },
    evaluated: { count: evaluations.length, denominator: scope.length, complete, incomplete: evaluations.length - complete, definition: '范围内逐只检查；数据不全仍计入已检查，但不能通过。' },
    core: { count: passed.length, denominator: scope.length, rows: passed },
    exclusions: { count: excluded.length, denominator: scope.length, rows: excluded },
    limitations: ['阈值为待验证研究假设，不代表收益或投资建议。', '财务数据采用公告日可用且报告期距基准日不超过550天的最近报告；单期指标可能受行业、季节和会计口径影响。', '流动性使用最近20个成交bar，停牌或历史缺口可能延长时间窗口；缺当日行情或成交额不通过。', '当前主数据存在幸存者偏差，范围和历史状态可能不完整。'],
  };
}
