import { DatabaseSync } from 'node:sqlite';
import { lstatSync, openSync, closeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { validateStrategyRelease, type StrategyRelease } from './strategyRelease.js';

export type AdmissionScope = { account: string; market: string; environment: string };
export type AdmissionAction = 'GRANT' | 'SUSPEND' | 'RESUME' | 'REVOKE';
type Event = { seq: number; action: AdmissionAction; strategy_id: string; version: string; release_hash: string; account: string; market: string; environment: string; valid_from: string; valid_until: string; recorded_at: string; uid: number; operator: string; reason: string };

function required(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.toUpperCase() === 'UNKNOWN') throw new Error('invalid_admission_input');
}
function timestamp(value: string): void {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('invalid_admission_time');
}
function releaseIdentity(value: unknown, scope: AdmissionScope): { release: StrategyRelease; hash: string } {
  const hash = validateStrategyRelease(value);
  const release = value as StrategyRelease;
  if (!['FROZEN', 'PROSPECTIVE_SHADOW_ACTIVE'].includes(release.research_status)) throw new Error('release_not_eligible');
  const containsUnknown = (v: unknown): boolean => typeof v === 'string' ? v.trim().toUpperCase() === 'UNKNOWN' : Array.isArray(v) ? v.some(containsUnknown) : !!v && typeof v === 'object' && Object.values(v).some(containsUnknown);
  if (containsUnknown(release)) throw new Error('release_not_eligible');
  for (const v of [scope?.account, scope?.market, scope?.environment]) required(v);
  if (scope.market !== release.applicability.market || scope.environment !== release.applicability.environment) throw new Error('scope_mismatch');
  return { release, hash };
}
function privatePath(path: string, create: boolean): void {
  if (!isAbsolute(path) || typeof process.getuid !== 'function') throw new Error('untrusted_admission_path');
  const uid = process.getuid();
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o700) throw new Error('untrusted_admission_directory');
  if (create) {
    const fd = openSync(path, 'wx', 0o600); closeSync(fd);
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o7777) !== 0o600) throw new Error('untrusted_admission_file');
}

/** The private directory and its owner are the local authority. This does not attest identity against that owner. */
export class StrategyAdmissionStore {
  private db: DatabaseSync;
  constructor(path: string, options: { create?: boolean } = {}) {
    privatePath(path, options.create === true);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      if (options.create) this.db.exec(`
        CREATE TABLE admission_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL CHECK(action IN ('GRANT','SUSPEND','RESUME','REVOKE')), strategy_id TEXT NOT NULL, version TEXT NOT NULL, release_hash TEXT NOT NULL, account TEXT NOT NULL, market TEXT NOT NULL, environment TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT NOT NULL, recorded_at TEXT NOT NULL, uid INTEGER NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL);
        CREATE TRIGGER admission_no_update BEFORE UPDATE ON admission_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;
        CREATE TRIGGER admission_no_replace BEFORE INSERT ON admission_events WHEN EXISTS (SELECT 1 FROM admission_events WHERE seq=NEW.seq) BEGIN SELECT RAISE(ABORT, 'append_only'); END;
        CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;
        PRAGMA user_version=1;
      `);
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version !== 1) throw new Error('invalid_admission_store');
      this.db.prepare('SELECT * FROM admission_events LIMIT 1').all();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private latest(release: StrategyRelease, hash: string, scope: AdmissionScope): Event | undefined {
    return this.db.prepare('SELECT * FROM admission_events WHERE strategy_id=? AND version=? AND release_hash=? AND account=? AND market=? AND environment=? ORDER BY seq DESC LIMIT 1').get(release.strategy.id, release.strategy.version, hash, scope.account, scope.market, scope.environment) as Event | undefined;
  }
  record(action: AdmissionAction, value: unknown, scope: AdmissionScope, options: { reason: string; operator?: string; validFrom?: string; validUntil?: string }): void {
    const { release, hash } = releaseIdentity(value, scope);
    required(options?.reason);
    const operator = options.operator ?? userInfo().username;
    required(operator);
    if (!['GRANT', 'SUSPEND', 'RESUME', 'REVOKE'].includes(action)) throw new Error('invalid_admission_action');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.latest(release, hash, scope);
      if (action === 'GRANT' && this.db.prepare('SELECT 1 FROM admission_events WHERE strategy_id=? AND version=? AND account=? AND market=? AND environment=? LIMIT 1').get(release.strategy.id, release.strategy.version, scope.account, scope.market, scope.environment)) throw new Error('conflicting_admission');
      const allowed = action === 'GRANT' ? !previous : action === 'SUSPEND' ? previous && ['GRANT', 'RESUME'].includes(previous.action) : action === 'RESUME' ? previous?.action === 'SUSPEND' : previous && previous.action !== 'REVOKE';
      if (!allowed) throw new Error('invalid_admission_transition');
      const from = action === 'GRANT' ? options.validFrom : previous?.valid_from;
      const until = action === 'GRANT' ? options.validUntil : previous?.valid_until;
      required(from); required(until); timestamp(from); timestamp(until);
      if (from >= until || (['GRANT', 'RESUME'].includes(action) && until <= new Date().toISOString())) throw new Error('invalid_admission_time');
      this.db.prepare('INSERT INTO admission_events(action,strategy_id,version,release_hash,account,market,environment,valid_from,valid_until,recorded_at,uid,operator,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(action, release.strategy.id, release.strategy.version, hash, scope.account, scope.market, scope.environment, from, until, new Date().toISOString(), process.getuid!(), operator, options.reason);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  check(value: unknown, scope: AdmissionScope, implementationSha256: string): boolean {
    try {
      const { release, hash } = releaseIdentity(value, scope);
      if (!/^[0-9a-f]{64}$/.test(implementationSha256) || release.strategy.implementation_sha256 !== implementationSha256) return false;
      const latest = this.latest(release, hash, scope);
      const now = new Date().toISOString();
      if (!latest) return false;
      timestamp(latest.valid_from); timestamp(latest.valid_until);
      return ['GRANT', 'RESUME'].includes(latest.action) && latest.valid_from < latest.valid_until && latest.valid_from <= now && now < latest.valid_until;
    } catch { return false; }
  }
  history(): Event[] { return this.db.prepare('SELECT * FROM admission_events ORDER BY seq').all() as Event[]; }
}
