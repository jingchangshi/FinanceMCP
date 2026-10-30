/**
 * Entry-layer research identity (goal-1031 §2.1 / WP1).
 *
 * The signal freeze (`IMPLEMENTATION_MODULES`) deliberately excludes every
 * entry module: an entry-assessment edit cannot change a recorded top-40, so it
 * must not invalidate the forward signal cohort. That exclusion is correct, and
 * it left the entry layer with no content identity at all — a run of
 * `entry-rules-1.1.0` and one of `entry-rules-1.2.0` were indistinguishable in
 * anything the system persisted.
 *
 * This module gives the entry layer its own content-addressed identity, hashed
 * over a curated module list, and `entryFreezeCli` records it in an append-only
 * `entry_freeze` ledger next to (not inside) `validation_freeze`. Nothing here
 * is imported by `validation.ts`, so the signal `implementation_hash` and the
 * closure test in `test/upgrade-validation.test.mjs` are untouched.
 *
 * Boundary: candidate INPUTS (`hotspotPool`, ETF weights, bars, fetch …) are NOT
 * hashed here. They are what the snapshot data fingerprint is for; binding them
 * here would re-freeze the entry layer on every data-side change.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTRY_RULES_VERSION } from './entryAssessment.js';
import { RANKING_RULES_VERSION } from './entryRanking.js';
import { SIGNAL_LIFECYCLE_VERSION } from './signalLifecycle.js';

/** Bump only if the HASH ALGORITHM changes, never when a module's content does. */
export const ENTRY_IMPLEMENTATION_SCHEME = 'entry-modules-v1';

/**
 * Compiled modules whose bytes decide what an entry view *contains*.
 * `strategies` is listed because it owns the trigger/invalidation predicates the
 * assessment quotes; `hotspotPipeline` because it decides what reaches
 * `buildEntryView`. Everything else that an entry row reads is a candidate
 * input, covered by the snapshot fingerprint instead.
 */
export const ENTRY_MODULES = [
  'entryAssessment', 'entryRanking', 'entryResearch',
  'hotspotPipeline', 'hotspotTypes', 'signalLifecycle', 'strategies',
] as const;

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function entryImplementationHash(dirs: { ashare?: string } = {}): string {
  const ashare = dirs.ashare ?? fileURLToPath(new URL('./', import.meta.url));
  const h = createHash('sha256').update(ENTRY_IMPLEMENTATION_SCHEME).update('\0');
  for (const name of [...ENTRY_MODULES].sort()) {
    h.update(name).update('\0').update(readFileSync(join(ashare, `${name}.js`))).update('\0');
  }
  return digest({ scheme: ENTRY_IMPLEMENTATION_SCHEME, entry_build: h.digest('hex') });
}

export function entryIdentity(dirs: { ashare?: string } = {}) {
  return {
    entry_scheme: ENTRY_IMPLEMENTATION_SCHEME,
    entry_modules: [...ENTRY_MODULES].sort(),
    entry_rules_version: ENTRY_RULES_VERSION,
    ranking_rules_version: RANKING_RULES_VERSION,
    signal_lifecycle_version: SIGNAL_LIFECYCLE_VERSION,
    entry_hash: entryImplementationHash(dirs),
  };
}

export type EntryIdentity = ReturnType<typeof entryIdentity>;
