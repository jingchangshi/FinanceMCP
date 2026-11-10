import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ashareDataDir, isResearchDb, resolveReportPath } from './db.js';
import { checkQuality, QualityReport, recentTradeDays } from './ingest.js';
import { scanMarket, SCORE_RULES, SCORE_VERSION, SectorRow, StockRow } from './analysis.js';
import { indexPerformance, marketBreadth, Regime, REGIME_LABELS, regimeSeries } from './market.js';
import { INDICATOR_VERSION } from './indicators.js';
import { SIGNAL_BY_ID, SIGNAL_VERSION } from './signals.js';
import { updateWatchlist, WATCHLIST_RULES, WATCHLIST_VERSION } from './watchlist.js';
import { EVIDENCE_SCOPE, EVIDENCE_VERSION, evaluateWatchlist, loadVerdicts, SignalVerdict } from './evidence.js';

export { resolveReportPath };

export const REPORT_SCHEMA_VERSION = 'ashare-report-1.1.0';

export const DATA_SOURCES = [
  'Tushare Pro trade_cal（交易日历）',
  'Tushare Pro stock_basic（股票基础信息，行业为当前分类）',
  'Tushare Pro daily（日线行情，按交易日批量）',
  'Tushare Pro daily_basic（每日指标：估值/换手/市值）',
  'Tushare Pro adj_factor（复权因子）',
  'Tushare Pro stk_limit（涨跌停价）',
  'Tushare Pro index_daily（核心指数日线）',
  'Tushare Pro fina_indicator_vip（财务指标，按公告日约束）',
];

const nowCst = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00');
const r2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function newReportId(date: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `ASR-${date}-${stamp}-${randomBytes(3).toString('hex')}`;
}

export interface ReportMeta {
  report_id: string;
  trade_date: string;
  status: string;
  generated_at: string;
  path: string;
  run_mode?: string | null;
}

function signalView(id: string, verdicts: Map<string, SignalVerdict>) {
  const def = SIGNAL_BY_ID.get(id)!;
  const v = verdicts.get(id);
  return {
    id,
    name: def.name,
    direction: def.direction,
    trigger: def.trigger,
    invalidation: def.invalidation,
    risk: def.risk,
    evidence: v?.classification ?? 'research_only',
    evidence_basis: v?.basis ?? '尚无历史检验结果',
  };
}

function memberView(row: StockRow, verdicts: Map<string, SignalVerdict>, extra: Record<string, unknown>) {
  const f = row.fundamentals;
  return {
    ts_code: row.ts_code,
    name: row.name,
    industry: row.industry,
    close: r2(row.close),
    pct_chg: r2(row.pct_chg),
    score: row.score,
    rank: row.rank,
    ...extra,
    components: row.components,
    technical: {
      trend: row.state.trend,
      ret5_pct: r2(row.state.ret5 * 100),
      ret20_pct: r2(row.state.ret20 * 100),
      ret60_pct: r2(row.state.ret60 * 100),
      rsi14: r2(row.state.rsi14, 1),
      atr_pct: r2(row.state.atr_pct * 100),
      ma20: r2(row.ma20),
      ma60: r2(row.ma60),
      trend_context: '技术趋势描述价格与均线状态，仅作背景信息；趋势变化本身不是股票池移除条件。',
    },
    fundamentals: f ? {
      report_period: f.end_date,
      announced: f.ann_date,
      roe: r2(f.roe),
      netprofit_yoy: r2(f.netprofit_yoy),
      ocf_to_profit: r2(f.ocf_to_profit),
      debt_to_assets: r2(f.debt_to_assets),
    } : null,
    valuation: { pe_ttm: r2(row.pe_ttm), pb: r2(row.pb) },
    signals_today: row.signals.map(id => signalView(id, verdicts)),
    pool_membership: {
      status: extra.status,
      entered_on: extra.entered_on,
      current_membership_reason: extra.membership_reason,
      policy: `成员资格由准入条件、排名保留阈值（${WATCHLIST_RULES.exit_rank}）、最短持有期（${WATCHLIST_RULES.min_hold_days} 个交易日）、行业上限（${WATCHLIST_RULES.industry_cap} 只）及每日新增/替换规则共同决定；MA60 或技术趋势变化本身不直接触发移除。`,
    },
    watch_invalidation: [
      `按股票池规则评估：准入条件、排名保留阈值（${WATCHLIST_RULES.exit_rank}）、最短持有期（${WATCHLIST_RULES.min_hold_days} 个交易日）、行业上限及新增/替换规则；今日实际成员理由见 pool_membership.current_membership_reason。`,
      'MA60 与技术趋势仅为技术背景，不是独立的股票池移除条件。',
    ],
    risks: row.risk_flags,
  };
}

function marketJudgement(regime: Regime | undefined, breadth: ReturnType<typeof marketBreadth>, pctMa20: number, pctMa60: number, indices: ReturnType<typeof indexPerformance>) {
  const points: string[] = [];
  if (regime) points.push(`市场趋势状态（沪深300）：${REGIME_LABELS[regime]}；仅按沪深300收盘相对 MA60 与 MA20 相对五个交易日前的斜率判定，上升需收盘高于 MA60 且 MA20 上行，下降需收盘低于 MA60 且 MA20 不上行，其余为震荡。`);
  points.push(`全市场当日有日线记录的 ${breadth.stocks} 只股票中，上涨 ${breadth.up} 家 / 下跌 ${breadth.down} 家（上涨占比 ${(breadth.up_ratio * 100).toFixed(1)}%），涨停 ${breadth.limit_up}、跌停 ${breadth.limit_down}；停牌或当日无行情股票不在此分母内。`);
  points.push(`扫描股票中站上 MA20 的占比 ${(pctMa20 * 100).toFixed(1)}%，站上 MA60 占比 ${(pctMa60 * 100).toFixed(1)}%；这是技术广度，分母与全市场上涨占比不同。`);
  if (breadth.amount_ma20_yi) {
    const ratio = breadth.amount_yi / breadth.amount_ma20_yi;
    points.push(`全市场当日成交额 ${breadth.amount_yi.toFixed(0)} 亿，相对前 20 个交易日（不含当日）日成交额均值为 ${(ratio * 100).toFixed(0)}%（${ratio > 1.1 ? '高于均值' : ratio < 0.9 ? '低于均值' : '接近均值'}）。`);
  }
  if (breadth.amount_chg_pct !== null && breadth.amount_chg_pct !== undefined) {
    points.push(`全市场成交额较前一交易日 ${breadth.amount_chg_pct > 0 ? '+' : ''}${breadth.amount_chg_pct.toFixed(1)}%（环比；与20日均值为不同基准）。`);
  }
  const big = indices.find(i => i.ts_code === '000300.SH');
  const small = indices.find(i => i.ts_code === '000852.SH');
  if (big?.ret20 != null && small?.ret20 != null) {
    const diff = small.ret20 - big.ret20;
    points.push(`近 20 日中证1000 相对沪深300 ${diff >= 0 ? '强' : '弱'} ${Math.abs(diff).toFixed(1)} 个百分点（指数相对收益，不参与上述市场宽度或成交额判定）。`);
  }
  let tone: 'risk_on' | 'neutral' | 'risk_off' = 'neutral';
  if (breadth.up_ratio >= 0.6 && pctMa20 >= 0.5) tone = 'risk_on';
  else if (breadth.up_ratio <= 0.35 && pctMa20 <= 0.4) tone = 'risk_off';
  points.push(`市场情绪 tone=${tone}：risk_on 要求全市场上涨占比 ≥60% 且扫描股票站上 MA20 占比 ≥50%；risk_off 要求分别 ≤35% 与 ≤40%；其他情况为 neutral。`);
  return { tone, points };
}

function sectorView(s: SectorRow) {
  return {
    industry: s.industry, rank: s.rank, strength: r2(s.strength, 3), stocks: s.stocks,
    ret5_median_pct: r2(s.ret5_median * 100), ret20_median_pct: r2(s.ret20_median * 100),
    pct_above_ma20: r2(s.pct_above_ma20 * 100, 1), amount20_yi: r2(s.amount_yi, 0),
  };
}

function versions() {
  return {
    report_schema: REPORT_SCHEMA_VERSION,
    indicators: INDICATOR_VERSION,
    signals: SIGNAL_VERSION,
    score: SCORE_VERSION,
    watchlist: WATCHLIST_VERSION,
    evidence: EVIDENCE_VERSION,
  };
}

function persist(db: DatabaseSync, report: any): ReportMeta {
  // Research reports (replay / back-dated) get their own tree and never touch the live latest.json.
  const research = isResearchDb(db);
  const rel = join(research ? 'research' : '', 'reports', report.as_of_trade_date);
  const dir = join(ashareDataDir(), rel);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.report_id}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  if (!research) writeFileSync(join(dir, 'latest.json'), JSON.stringify(report, null, 2));
  // Store the path relative to the data directory so host and container (/data) agree.
  db.prepare('INSERT INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(report.report_id, report.as_of_trade_date, report.status, report.generated_at, join(rel, `${report.report_id}.json`), report.run_mode);
  return { report_id: report.report_id, trade_date: report.as_of_trade_date, status: report.status, generated_at: report.generated_at, path, run_mode: report.run_mode };
}

/**
 * The report served for a date (or, without a date, the most recent one).
 * Ordered by trade date first, so a report generated later for an older date
 * never becomes "latest"; within a date the live pipeline report wins, then
 * manual reports (left in older live databases), then rows without a run_mode,
 * then replays, and only then the generation time. `asOf` limits the search
 * to trade dates on or before it.
 */
export function latestReportMeta(db: DatabaseSync, date?: string, readyOnly = false, asOf?: string): ReportMeta | undefined {
  const cond: string[] = [];
  const params: string[] = [];
  if (date) { cond.push('trade_date = ?'); params.push(date); }
  if (asOf) { cond.push('trade_date <= ?'); params.push(asOf); }
  if (readyOnly) cond.push("status != 'NOT_READY'");
  return db.prepare(`SELECT * FROM report ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
    ORDER BY trade_date DESC,
      CASE run_mode WHEN 'live' THEN 0 WHEN 'manual' THEN 1 WHEN 'replay' THEN 3 ELSE 2 END,
      generated_at DESC LIMIT 1`).get(...params) as ReportMeta | undefined;
}

export function loadReport(meta: ReportMeta): any {
  const path = resolveReportPath(meta.path);
  if (!existsSync(path)) throw new Error(`报告文件不存在: ${meta.path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Build and persist the report for one trading day from the local cache.
 * When core data for that day is missing, the report is NOT_READY and carries
 * no watchlist or signals; earlier days are never substituted.
 */
export type RunMode = 'live' | 'replay' | 'manual';

export function generateReport(db: DatabaseSync, date: string, mode: RunMode = 'manual'): { meta: ReportMeta; report: any } {
  // Live watchlists, scores and latest.json are written only by the daily pipeline.
  if (!isResearchDb(db) && mode !== 'live') throw new Error(`${mode} 报告只能写入研究库（openResearchDb），正式库只接受 daily 流水线的 live 报告`);
  if (isResearchDb(db) && mode === 'live') throw new Error('研究库不能生成 live 报告');
  const quality: QualityReport = checkQuality(db, date);
  const generatedAt = nowCst();
  const base = {
    report_id: newReportId(date),
    schema: REPORT_SCHEMA_VERSION,
    as_of_trade_date: date,
    generated_at: generatedAt,
    status: quality.status,
    run_mode: mode,
    run_mode_note: mode === 'replay'
      ? '历史重放：基于本地缓存在事后生成，行业分类为当前口径，非当日实时发布'
      : mode === 'live' ? '日常流水线（同步→检查→分析→发布）生成，生成时间见 generated_at' : '手动生成',
    versions: versions(),
    data: {
      sources: DATA_SOURCES,
      quality,
      last_sync: db.prepare("SELECT dataset, MAX(synced_at) synced_at FROM sync_log GROUP BY dataset").all(),
    },
  };

  if (quality.status === 'NOT_READY') {
    const lastReady = latestReportMeta(db, undefined, true, date);
    const report = {
      ...base,
      not_ready: {
        reasons: quality.reasons,
        policy: '核心数据缺失，本报告不生成市场判断、股票池或交易信号，也不使用前一交易日数据替代。',
        latest_ready_report: lastReady ? { report_id: lastReady.report_id, trade_date: lastReady.trade_date } : null,
      },
      disclaimer: '本报告仅为研究辅助，不构成投资建议。',
    };
    return { meta: persist(db, report), report };
  }

  const scan = scanMarket(db, date);
  const watch = updateWatchlist(db, scan);
  const { verdicts, meta: evidenceMeta } = loadVerdicts(db, date);
  const regimes = regimeSeries(db, date);
  const regime = regimes.get(date);
  const indices = indexPerformance(db, date);
  const breadth = marketBreadth(db, date);
  const judgement = marketJudgement(regime, breadth, scan.pct_above_ma20, scan.pct_above_ma60, indices);
  const byCode = new Map(scan.rows.map(r => [r.ts_code, r]));
  const { per_date: _perDate, ...trackRecord } = evaluateWatchlist(db, recentTradeDays(db, date, 65)[0], date, 5);

  const members = watch.members.map(m => memberView(byCode.get(m.ts_code)!, verdicts, {
    status: m.status, entered_on: m.entered_on, membership_reason: m.reason,
  }));
  const signalSummary = Object.entries(scan.signal_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ ...signalView(id, verdicts), market_count: count }));

  const report = {
    ...base,
    market: {
      regime: regime ?? null,
      regime_label: regime ? REGIME_LABELS[regime] : '历史不足',
      regime_method: '沪深300收盘价与MA60比较，并比较当日MA20与五个交易日前MA20：收盘高于MA60且MA20上行=uptrend；收盘低于MA60且MA20不高于五日前=downtrend；其他=range。需要足够历史数据，使用截至报告日的数据。',
      tone: judgement.tone,
      tone_method: 'risk_on: 全市场当日有行情股票上涨占比≥60%且扫描股票站上MA20占比≥50%；risk_off: 两者分别≤35%和≤40%；否则neutral。两个比例的股票分母口径不同。',
      judgement: judgement.points,
      indices,
      breadth_scope: 'up/down/flat、涨跌停和成交额覆盖当日 daily 表中有市场行记录的全市场股票；MA20/MA60 技术广度来自 scanMarket 扫描股票。没有当日市场行的停牌或缺行情股票不在日线宽度分母中。',
      volume_scope: '全市场成交额由当日有行情记录的股票 daily.amount 求和；20日基准为前20个交易日（不含当日）的日成交额均值，环比为前一交易日基准。',
      breadth: { ...breadth, pct_above_ma20: r2(scan.pct_above_ma20 * 100, 1), pct_above_ma60: r2(scan.pct_above_ma60 * 100, 1) },
      suspended_or_missing: scan.suspended_or_missing,
    },
    sectors: {
      method: '行业为 Tushare stock_basic 当前行业分类；每行业至少5只扫描股票才纳入。strength 是当日纳入行业之间的横截面复合百分位（0.5×行业成分股20日收益中位数百分位 + 0.3×5日收益中位数百分位 + 0.2×站上MA20比例百分位），用于行业间相对排序，不是市场趋势、全市场宽度或绝对收益指标。amount20_yi 为行业扫描股票各自20日平均成交额之和。',
      top: scan.sectors.slice(0, 8).map(sectorView),
      bottom: scan.sectors.slice(-5).reverse().map(sectorView),
      all: scan.sectors.map(sectorView),
    },
    watchlist: {
      rules: WATCHLIST_RULES,
      score_rules: SCORE_RULES,
      previous_date: watch.previous_date,
      count: members.length,
      eligible_universe: scan.rows.filter(r => r.eligible).length,
      industry_distribution: watch.industry_distribution,
      track_record: {
        ...trackRecord,
        horizon: 5,
        horizon_unit: 'trading_days',
        method: `实际 horizon 固定为5个交易日：每个股票池日期 t 的成员在 t+1 日开盘入场，于 t+5 日收盘退出，计算已定价池成员等权收益减去同期全市场等权收益。最多回看60个池日期；日期分母及排除情况见 selected_dates、mature_dates、evaluated_dates、immature_dates、excluded_dates、inadequate_market_coverage_dates、no_priced_pool_member_dates；成员分母为成熟池日期上的 selected_members 观察数，priced_pool_members 是其中可定价观察数，pool_member_coverage=priced_pool_members/selected_members。pending_dates 为 immature_dates 加 excluded_dates；exclusions 逐日给出原因与市场覆盖数。`,
        research_scope: '这是按历史股票池成员日期计算的描述性池表现记录，不是今日信号事件证据分类、召回率测量、个人账户研究或完整策略回测。历史成员来自各日期当时形成的评分和股票池规则，可能跨越不同 score/watchlist 版本；该结果不能作为当前 score-3 或当前规则有效性的证据。',
      },
      added: watch.changes.filter(c => c.action === 'add'),
      removed: watch.changes.filter(c => c.action === 'remove'),
      members,
    },
    signals: {
      market_summary: signalSummary,
      evidence_window: evidenceMeta,
      evidence_scope: EVIDENCE_SCOPE,
      note: 'evidence_supported = 样本内信号触发事件的方向性统计证据（收益窗口重叠、未做多重检验校正），不是策略有效性；research_only 为研究指标；contradicted 为样本内方向相反。此分类是信号事件研究，与历史股票池成员 track_record、召回率评估及个人账户前向研究分别独立；均不应视为交易规则。',
    },
    risks: [
      ...(quality.status === 'DEGRADED' ? quality.reasons.map(r => `数据降级：${r}`) : []),
      ...(judgement.tone === 'risk_off' ? ['市场宽度弱，技术信号失败率通常上升'] : []),
      '行业分类为当前口径，历史重放存在行业归属偏差',
    ],
    disclaimer: '评分为启发式规则排序，不代表盈利概率；本报告仅为研究辅助，不构成投资建议。',
  };
  return { meta: persist(db, report), report };
}
