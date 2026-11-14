import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type NewsKind = 'PRIMARY_FILING' | 'NEWS' | 'INDUSTRY_UPDATE' | 'OTHER';
export type NewsStance = 'SUPPORT' | 'COUNTER' | 'NEUTRAL';
export interface NewsEvidence {
  id: string; source_url: string; publisher: string; published_at: string; fetched_at: string;
  entity_codes: string[]; kind: NewsKind; stance: NewsStance; title: string | null; claim: string | null; content_hash: string;
}

export function newsEvidencePath(): string {
  return join(homedir(), '.local', 'share', 'ashare-private', 'news-evidence.sqlite');
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error(`${field}: timezone-qualified ISO timestamp required`);
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(value)!;
  const [, y, m, d, h, min, s] = match;
  const calendar = new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
  if (calendar.getUTCFullYear() !== +y || calendar.getUTCMonth() !== +m - 1 || calendar.getUTCDate() !== +d || +h > 23 || +min > 59 || +s > 59 || !Number.isFinite(Date.parse(value))) throw new Error(`${field}: invalid timestamp`);
  return new Date(value).toISOString();
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}: nonempty string required`);
  return value.trim();
}
function optionalText(value: unknown, field: string): string | null {
  return value == null ? null : text(value, field);
}
export function validateNewsEvidence(input: unknown, now = new Date()): NewsEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('evidence must be an object');
  const v = input as Record<string, unknown>;
  const source_url = text(v.source_url, 'source_url');
  let url: URL;
  try { url = new URL(source_url); } catch { throw new Error('source_url: invalid URL'); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.href.split('/')[2].includes('@') || !/^https?:\/\//i.test(source_url)) throw new Error('source_url: http(s) URL required');
  const published_at = timestamp(v.published_at, 'published_at');
  const fetched_at = timestamp(v.fetched_at, 'fetched_at');
  if (published_at > fetched_at || Date.parse(fetched_at) > now.getTime()) throw new Error('invalid time order: published_at <= fetched_at <= now required');
  if (!Array.isArray(v.entity_codes) || !v.entity_codes.length || v.entity_codes.some(c => typeof c !== 'string' || !c.trim())) throw new Error('entity_codes: nonempty string array required');
  const entity_codes = [...new Set((v.entity_codes as string[]).map(c => c.trim()))].sort();
  if (!['PRIMARY_FILING', 'NEWS', 'INDUSTRY_UPDATE', 'OTHER'].includes(v.kind as string)) throw new Error('invalid kind');
  if (!['SUPPORT', 'COUNTER', 'NEUTRAL'].includes(v.stance as string)) throw new Error('invalid stance');
  const title = optionalText(v.title, 'title');
  const claim = optionalText(v.claim, 'claim');
  if (!title && !claim) throw new Error('title or claim required');
  const content_hash = text(v.content_hash, 'content_hash').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(content_hash)) throw new Error('content_hash: SHA-256 hex required');
  return { id: text(v.id, 'id'), source_url, publisher: text(v.publisher, 'publisher'), published_at, fetched_at, entity_codes, kind: v.kind as NewsKind, stance: v.stance as NewsStance, title, claim, content_hash };
}

export function openNewsEvidenceDb(path = newsEvidencePath()): DatabaseSync {
  path = resolve(path);
  const dir = dirname(path);
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed || path === resolve(newsEvidencePath())) chmodSync(dir, 0o700);
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('evidence database must be a regular file');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { chmodSync(path, 0o600); } finally { closeSync(fd); }
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS news_evidence (
      id TEXT PRIMARY KEY, source_url TEXT NOT NULL, publisher TEXT NOT NULL, published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL, entity_codes TEXT NOT NULL, kind TEXT NOT NULL, stance TEXT NOT NULL,
      title TEXT, claim TEXT, content_hash TEXT NOT NULL UNIQUE
    );
    CREATE TRIGGER IF NOT EXISTS news_evidence_no_replace BEFORE INSERT ON news_evidence
      WHEN EXISTS (SELECT 1 FROM news_evidence WHERE id = NEW.id OR content_hash = NEW.content_hash)
      BEGIN SELECT RAISE(ABORT, 'append-only conflict'); END;
    CREATE TRIGGER IF NOT EXISTS news_evidence_no_update BEFORE UPDATE ON news_evidence BEGIN SELECT RAISE(ABORT, 'append-only'); END;
    CREATE TRIGGER IF NOT EXISTS news_evidence_no_delete BEFORE DELETE ON news_evidence BEGIN SELECT RAISE(ABORT, 'append-only'); END;`);
    return db;
  } catch (error) { db.close(); throw error; }
}

function fromRow(row: any): NewsEvidence { return { ...row, entity_codes: JSON.parse(row.entity_codes) }; }
/** All records are validated before an atomic import. Existing identical records are idempotent. */
export function importNewsEvidence(db: DatabaseSync, inputs: unknown[], now = new Date()): { inserted: number; existing: number } {
  const records = inputs.map(v => validateNewsEvidence(v, now));
  let inserted = 0, existing = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const find = db.prepare('SELECT * FROM news_evidence WHERE id = ? OR content_hash = ?');
    const insert = db.prepare('INSERT INTO news_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of records) {
      const rows = find.all(r.id, r.content_hash) as any[];
      if (rows.length) {
        if (rows.length !== 1 || JSON.stringify(fromRow(rows[0])) !== JSON.stringify(r)) throw new Error(`news evidence conflict: ${r.id}`);
        existing++; continue;
      }
      insert.run(r.id, r.source_url, r.publisher, r.published_at, r.fetched_at, JSON.stringify(r.entity_codes), r.kind, r.stance, r.title, r.claim, r.content_hash);
      inserted++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { inserted, existing };
}

/** YYYYMMDD refers to the end of that calendar day in China; timestamps are exact instants. */
export function listNewsEvidence(db: DatabaseSync, asOf: string, codes: string[]): NewsEvidence[] {
  let cutoff: string;
  if (/^\d{8}$/.test(asOf)) cutoff = timestamp(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T23:59:59.999+08:00`, 'date');
  else cutoff = timestamp(asOf, 'date');
  if (!Array.isArray(codes) || !codes.length || codes.some(c => typeof c !== 'string' || !c.trim())) throw new Error('codes required');
  const wanted = new Set(codes.map(c => c.trim()));
  return (db.prepare('SELECT * FROM news_evidence WHERE published_at <= ? AND fetched_at <= ? ORDER BY published_at DESC, id').all(cutoff, cutoff) as any[])
    .map(fromRow).filter(r => r.entity_codes.some(c => wanted.has(c)));
}
