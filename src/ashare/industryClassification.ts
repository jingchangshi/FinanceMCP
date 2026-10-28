import type { SectorKey, ThemeKind } from './hotspotTypes.js';
import { THS_THEME_RULE_VERSION } from './hotspotTypes.js';

/**
 * Pure point-in-time / classification logic for the industry layer
 * (goal-1028). No I/O, no network, no clock: every function is deterministic
 * and imports only from hotspotTypes.
 */

/** One row of Tushare `index_member_all` / the `sw_member` table. */
export interface SwMemberRow {
  ts_code: string;
  l1_code: string;
  l2_code: string;
  l3_code: string;
  l1_name?: string | null;
  l2_name?: string | null;
  l3_name?: string | null;
  name?: string | null;
  /** YYYYMMDD; missing or malformed rows are never assumed active. */
  in_date?: string | null;
  /** YYYYMMDD or null/'' while the stock is still a member. */
  out_date?: string | null;
  is_new?: string | null;
}

const YMD = /^\d{8}$/;

/**
 * Point-in-time membership per architecture.md §2.2:
 * `in_date <= as_of AND (out_date IS NULL OR out_date > as_of)`.
 *
 * - `in_date` missing/empty/malformed → excluded (the historical-backfill
 *   guard: a row without a provable entry date must not enter a past pool).
 * - `out_date == as_of` → excluded: membership ends ON the out date, so the
 *   member is already out as of that day.
 * - A non-empty malformed `out_date` → excluded too: an exit we cannot parse
 *   is an exit we cannot prove around, and "unconfirmable availability must
 *   not be dressed up as availability" (§2.2.2).
 *
 * asOf is YYYYMMDD, the format Tushare returns; comparison is lexicographic
 * on that fixed-width form.
 */
export function activeSwMembers(rows: SwMemberRow[], asOf: string): SwMemberRow[] {
  const out: SwMemberRow[] = [];
  for (const row of rows) {
    const inDate = row.in_date;
    if (typeof inDate !== 'string' || !YMD.test(inDate) || inDate > asOf) continue;
    const outDate = row.out_date;
    if (typeof outDate === 'string' && outDate !== '') {
      if (!YMD.test(outDate) || outDate <= asOf) continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Convenience: active members of one SW index code (L1, L2 or L3 — the code
 * is matched against the corresponding level column), keyed by ts_code.
 * First row wins if upstream ever repeats a stock inside one index.
 */
export function swMemberIndex(
  rows: SwMemberRow[],
  indexCode: string,
  asOf: string,
): Map<string, SwMemberRow> {
  const map = new Map<string, SwMemberRow>();
  for (const row of activeSwMembers(rows, asOf)) {
    if (row.l1_code !== indexCode && row.l2_code !== indexCode && row.l3_code !== indexCode) continue;
    if (!map.has(row.ts_code)) map.set(row.ts_code, row);
  }
  return map;
}

/**
 * Names that mark a THS `type='N'` index as a sample/constituent set rather
 * than a theme (e.g. 沪深300样本股, 上证180成份股). Exported for tests and
 * for any rule-version audit; cross-source merging is NOT done from these.
 */
export const THS_SAMPLE_NAME_PATTERNS: readonly RegExp[] = [
  /样本/,
  /成份/,
  /成分/,
];

/**
 * Source-local THS theme kind (rule version `THS_THEME_RULE_VERSION`):
 * - `type='I'`  → THS_INDUSTRY
 * - `type='ST'` → THS_STYLE (风格指数, e.g. 同花顺小盘)
 * - `type='N'`  → THS_CONCEPT, unless the name matches a sample-set pattern
 *                 → THS_SAMPLE (样本/成份 indices are selection sets, not themes)
 * - `type='S'`  → THS_SAMPLE: these are event/selection indices such as
 *                 "昨日涨幅超过10%" — a one-day screen, not a concept and not
 *                 an industry; THS_SAMPLE is the honest bucket for indices
 *                 that carry no theme semantics.
 * - anything else (including missing type) → UNKNOWN.
 *
 * Only the kind is returned; `ruleVersion` is part of the published
 * signature so callers record `THS_THEME_RULE_VERSION` next to the kind —
 * the classification itself is versioned by this module's constant, not by
 * per-call drift.
 */
export function classifyThsTheme(
  index: { ts_code: string; name: string; type: string | null },
  ruleVersion: string = THS_THEME_RULE_VERSION,
): ThemeKind {
  void ruleVersion;
  switch (index.type) {
    case 'I':
      return 'THS_INDUSTRY';
    case 'ST':
      return 'THS_STYLE';
    case 'S':
      return 'THS_SAMPLE';
    case 'N': {
      const name = index.name ?? '';
      return THS_SAMPLE_NAME_PATTERNS.some(p => p.test(name)) ? 'THS_SAMPLE' : 'THS_CONCEPT';
    }
    default:
      return 'UNKNOWN';
  }
}

/**
 * Stable dedup of sector keys: exact keys only, first-seen order preserved.
 * Cross-source names are NEVER merged — `SW2021:801080.SI` and
 * `THS:801080.SI` are different keys forever; only an explicit, versioned
 * mapping may relate them (architecture.md §3).
 */
export function dedupeSectors(keys: SectorKey[]): SectorKey[] {
  const seen = new Set<SectorKey>();
  const out: SectorKey[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
