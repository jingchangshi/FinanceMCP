import type { DatabaseSync } from 'node:sqlite';
import { previousTradeDay, recentTradeDays } from './ingest.js';
import { latestReportMeta, loadReport, ReportMeta } from './report.js';

/**
 * Continuous live acceptance for one trading day, under the unified 19:30
 * pipeline (readiness deadline 21:15 Beijing).
 *
 * A day passes when all of these hold:
 * - live_report: a `run_mode=live` report for the target day was generated on
 *   the same Beijing calendar day after the 15:00 close, no later than the
 *   assessment time. The latest such report is the evidence report; replay and
 *   next-day catch-up runs are excluded from that evidence;
 * - data_rechecked: `sync_history` holds at least one `daily` request for the
 *   target day that completed with REFRESH_OK after that day's close and no
 *   later than the evidence report. A later retry that succeeds satisfies it;
 *   REFRESH_INCOMPLETE / REFRESH_FAILED do not. One good free-provider refresh
 *   is enough — the old "two runs, two refreshes" rule is retired;
 * - final_status: the evidence report is READY. DEGRADED (a non-core gap) is
 *   PASS_DEGRADED by default and fails under `--strict-ready`; NOT_READY fails;
 * - mcp_consistent: the report the MCP tools serve for the date is the latest
 *   live target-day report at the assessment time (a later same-day recovery or
 *   next-day catch-up may be what is served; that does not make it evidence);
 * - on_time: some same-day post-close report by the 21:15 Beijing deadline was
 *   not NOT_READY. A day that only becomes ready after 21:15 is a late recovery,
 *   recorded as `late_recovery`, never as an on-time SLA; it is also not
 *   evidence that the systemd timer fired.
 *
 * Before 21:15 Beijing on the assessed day, failed checks are PENDING; from
 * 21:15 they are FAIL. Records generated/synced after the assessment time are
 * excluded, so evaluating "now" cannot see the future.
 *
 * Watchlist continuity, retry counts, the 19:30 journal origin/outcome and the
 * optional 22:15 month-end job are diagnostics or separate scheduler evidence,
 * never report-success gates. This function reads only the database; timer
 * evidence stays in deploy/ashare/check-schedule.sh.
 */
export const ACCEPTANCE_DEADLINE_HM = '21:15:00';
export const MARKET_CLOSE_HM = '15:00:00';

export type AcceptanceCheck = 'live_report' | 'data_rechecked' | 'final_status' | 'mcp_consistent' | 'on_time';

export interface AcceptanceRun {
  report_id: string;
  status: string;
  generated_at: string;
  same_day: boolean;
  post_close: boolean;
  by_deadline: boolean;
  before_assessment: boolean;
  /** Live, same Beijing day, after close and no later than the assessment time. */
  eligible: boolean;
}

export interface AcceptanceFetch {
  synced_at: string;
  rows: number;
  status: string;
  refresh_status: string | null;
  message: string;
  same_day: boolean;
  post_close: boolean;
  before_report: boolean;
  before_assessment: boolean;
  /** REFRESH_OK, same day, after close, no later than the selected report and the assessment time. */
  eligible: boolean;
}

export interface AcceptanceDay {
  trade_date: string;
  result: 'PASS' | 'PASS_DEGRADED' | 'FAIL' | 'PENDING';
  failed: AcceptanceCheck[];
  checks: Record<AcceptanceCheck, boolean>;
  assessment: { now: string; beijing_date: string; beijing_time: string; deadline: string; close: string };
  live_runs: AcceptanceRun[];
  daily_fetches: AcceptanceFetch[];
  final: { report_id: string; status: string; generated_at: string; reasons: string[]; by_deadline: boolean } | null;
  /** The day was not ready by 21:15 and its latest live run before assessment is late (after the deadline or a later day). */
  late_recovery: boolean;
  mcp_report_id: string | null;
  watchlist: {
    previous_date: string | null; expected_previous: string | null; count: number | null; previous_count: number | null;
    added: number; removed: number; continuous: boolean;
  } | null;
}

export interface AcceptanceOptions {
  /** Compatibility alias; DEGRADED is allowed by default. */
  allowDegraded?: boolean;
  /** DEGRADED becomes a failure. Takes precedence over allowDegraded. */
  strictReady?: boolean;
  now?: Date;
}

const cstDate = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
const cstClock = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(11, 19);
const at = (iso: string) => Date.parse(iso);
const byTime = (a: string, b: string) => at(a) - at(b);

const degradedAllowed = (opts: AcceptanceOptions) => !opts.strictReady && opts.allowDegraded !== false;

export function acceptanceDay(db: DatabaseSync, day: string, opts: AcceptanceOptions = {}): AcceptanceDay {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const nowTs = now.getTime();
  const degraded = degradedAllowed(opts);

  const metas = db.prepare("SELECT * FROM report WHERE trade_date = ? AND run_mode = 'live' ORDER BY generated_at, report_id").all(day) as unknown as ReportMeta[];
  const runEntries = metas.map(meta => {
    const sameDay = cstDate(meta.generated_at) === day;
    const postClose = cstClock(meta.generated_at) >= MARKET_CLOSE_HM;
    const beforeAssessment = at(meta.generated_at) <= nowTs;
    return {
      meta,
      run: {
        report_id: meta.report_id,
        status: meta.status,
        generated_at: meta.generated_at,
        same_day: sameDay,
        post_close: postClose,
        by_deadline: sameDay && cstClock(meta.generated_at) <= ACCEPTANCE_DEADLINE_HM,
        before_assessment: beforeAssessment,
        eligible: sameDay && postClose && beforeAssessment,
      } satisfies AcceptanceRun,
    };
  }).sort((a, b) => byTime(a.run.generated_at, b.run.generated_at) || a.run.report_id.localeCompare(b.run.report_id));

  // Evidence for the day: live, same-day, post-close, no later than the
  // assessment time. The latest such report is the one other checks reference.
  // Replay and next-day catch-up runs are excluded here even though MCP may serve
  // the latter (the MCP consistency check below uses the latest live report).
  const sameDay = runEntries.filter(x => x.run.eligible);
  const selectedEntry = sameDay.at(-1);
  const selected = selectedEntry?.meta;
  const selectedTs = selected ? at(selected.generated_at) : null;
  const selectedRun = selectedEntry?.run ?? null;
  const latestLive = runEntries.filter(x => x.run.before_assessment).at(-1)?.run;

  const fetchRows = db.prepare("SELECT synced_at, rows, status, refresh_status, message FROM sync_history WHERE dataset = 'daily' AND key = ? ORDER BY synced_at").all(day) as any[];
  const fetches: AcceptanceFetch[] = fetchRows.map(r => {
    const sameDay = cstDate(r.synced_at) === day;
    const postClose = cstClock(r.synced_at) >= MARKET_CLOSE_HM;
    const beforeReport = selectedTs !== null && at(r.synced_at) <= selectedTs;
    const beforeAssessment = at(r.synced_at) <= nowTs;
    return {
      synced_at: r.synced_at,
      rows: r.rows,
      status: r.status,
      refresh_status: r.refresh_status ?? null,
      message: r.message,
      same_day: sameDay,
      post_close: postClose,
      before_report: beforeReport,
      before_assessment: beforeAssessment,
      eligible: r.refresh_status === 'REFRESH_OK' && sameDay && postClose && beforeReport && beforeAssessment,
    };
  }).sort((a, b) => byTime(a.synced_at, b.synced_at));

  const served = latestReportMeta(db, day);
  // SLA timing is about a same-day report that was already usable by 21:15.
  // Whether that report is the latest one is a separate question (final_status).
  const onTimeReady = sameDay.some(x => x.run.by_deadline && x.run.status !== 'NOT_READY');
  const checks: Record<AcceptanceCheck, boolean> = {
    live_report: !!selectedRun,
    data_rechecked: fetches.some(f => f.eligible),
    final_status: !!selectedRun && (selectedRun.status === 'READY' || (selectedRun.status === 'DEGRADED' && degraded)),
    mcp_consistent: !!latestLive && served?.report_id === latestLive.report_id,
    on_time: onTimeReady,
  };
  const failed = (Object.keys(checks) as AcceptanceCheck[]).filter(k => !checks[k]);

  let watchlist: AcceptanceDay['watchlist'] = null;
  let finalReport: any = null;
  if (selected) {
    finalReport = loadReport(selected);
    if (finalReport.watchlist) {
      const expected = previousTradeDay(db, day) ?? null;
      const count = (date: string | null) => date
        ? (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(date) as any).n as number
        : null;
      const previousDate = finalReport.watchlist.previous_date ?? null;
      const countToday = count(day);
      const previousCount = count(expected);
      const added = finalReport.watchlist.added?.length ?? 0;
      const removed = finalReport.watchlist.removed?.length ?? 0;
      watchlist = {
        previous_date: previousDate,
        expected_previous: expected,
        count: countToday,
        previous_count: previousCount,
        added,
        removed,
        continuous: previousDate === expected && countToday === (previousCount ?? 0) + added - removed,
      };
    }
  }

  const nowSameDay = cstDate(nowIso) === day && cstClock(nowIso) < ACCEPTANCE_DEADLINE_HM;
  const result = failed.length === 0
    ? (selectedRun?.status === 'DEGRADED' ? 'PASS_DEGRADED' : 'PASS')
    : nowSameDay ? 'PENDING' : 'FAIL';

  return {
    trade_date: day,
    result,
    failed,
    checks,
    assessment: {
      now: nowIso, beijing_date: cstDate(nowIso), beijing_time: cstClock(nowIso).slice(0, 5),
      deadline: ACCEPTANCE_DEADLINE_HM.slice(0, 5), close: MARKET_CLOSE_HM.slice(0, 5),
    },
    live_runs: runEntries.map(x => x.run),
    daily_fetches: fetches,
    final: selectedRun ? {
      report_id: selectedRun.report_id,
      status: selectedRun.status,
      generated_at: selectedRun.generated_at,
      reasons: finalReport?.data?.quality?.reasons ?? [],
      by_deadline: selectedRun.by_deadline,
    } : null,
    late_recovery: !onTimeReady && !!latestLive && !latestLive.by_deadline,
    mcp_report_id: served?.report_id ?? null,
    watchlist,
  };
}

export function acceptance(db: DatabaseSync, end: string, days: number, opts: AcceptanceOptions = {}) {
  const tradeDays = recentTradeDays(db, end, days);
  const checks = tradeDays.map(day => acceptanceDay(db, day, opts));
  return {
    required_consecutive_days: days,
    strict_ready: !!opts.strictReady,
    allow_degraded: degradedAllowed(opts),
    trade_days: tradeDays,
    passed: checks.length === days && checks.every(c => c.result === 'PASS' || c.result === 'PASS_DEGRADED'),
    criteria: ['live_report', 'data_rechecked', 'final_status', 'mcp_consistent', 'on_time'] as AcceptanceCheck[],
    checks,
  };
}
