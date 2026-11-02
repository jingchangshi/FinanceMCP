/**
 * `finance-ashare technical-preview --date YYYYMMDD` — read-only V2 preview.
 *
 * Opens the market cache with SQLite `readOnly: true` (no migration, no
 * create, no WAL writes), runs the same discovery + five-family analysis the
 * daily pipeline runs, and prints or writes the view. It never persists a
 * hotspot snapshot and never allocates a formal version number.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ashareDbPath } from './db.js';
import { analyzeTechnicalDay, renderTechnicalViewMarkdown } from './technicalCandidatesV2.js';

export interface TechnicalPreviewOptions {
  date: string;
  dbPath?: string;
  format: 'json' | 'md';
  outDir?: string;
}

export interface TechnicalPreviewResult {
  command: 'technical-preview';
  as_of: string;
  db_path: string;
  persisted: false;
  output_format: 'json' | 'md';
  written: string[];
  view?: ReturnType<typeof analyzeTechnicalDay>;
  markdown?: string;
}

const PRAGMAS = 'PRAGMA busy_timeout = 15000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA mmap_size = 2147483648;';

export function runTechnicalPreview(opts: TechnicalPreviewOptions): TechnicalPreviewResult {
  const dbPath = opts.dbPath?.trim() || ashareDbPath();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(PRAGMAS);
    const view = analyzeTechnicalDay(db, opts.date);
    const markdown = renderTechnicalViewMarkdown(view);
    const written: string[] = [];
    if (opts.outDir) {
      mkdirSync(opts.outDir, { recursive: true });
      const jsonPath = join(opts.outDir, `${opts.date}-technical-v2.json`);
      const mdPath = join(opts.outDir, `${opts.date}-technical-v2.md`);
      writeFileSync(jsonPath, JSON.stringify(view, null, 2) + '\n');
      writeFileSync(mdPath, markdown + '\n');
      written.push(jsonPath, mdPath);
    }
    return {
      command: 'technical-preview',
      as_of: opts.date,
      db_path: dbPath,
      persisted: false,
      output_format: opts.format,
      written,
      ...(opts.format === 'md' ? { markdown } : { view }),
    };
  } finally {
    db.close();
  }
}

/** Parse the raw argv tail (everything after the command name). */
export function runTechnicalPreviewCommand(argv: string[]): TechnicalPreviewResult {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const date = arg('date');
  if (!date || !/^\d{8}$/.test(date)) throw new Error('technical-preview 需要 --date YYYYMMDD');
  if (flag('json') && flag('md')) throw new Error('--json 与 --md 只能选一个');
  return runTechnicalPreview({
    date,
    dbPath: arg('db'),
    format: flag('md') ? 'md' : 'json',
    outDir: arg('out'),
  });
}
