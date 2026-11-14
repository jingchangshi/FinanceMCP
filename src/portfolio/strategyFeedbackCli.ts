#!/usr/bin/env node
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { appendFeedbackEvents, initFeedbackStore, listFeedbackEvents } from './strategyFeedbackStore.js';

/** Standalone, account-free feedback CLI; returns JSON-serializable data. */
export function runStrategyFeedbackCli(args: string[]): unknown {
  const [command, ...rest] = args;
  if (command !== 'import' && command !== 'list') throw new Error('usage: list [--db PATH] | import [--db PATH] --file JSONL --confirm');
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--db', '--file', '--confirm'].includes(key) || options.has(key)) throw new Error('invalid or duplicate option');
    if (key === '--confirm') options.set(key, true);
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
      options.set(key, value);
    }
  }
  const path = options.get('--db') ?? (process.env.ASHARE_STRATEGY_FEEDBACK_DB || join(homedir(), '.local', 'share', 'ashare-private', 'strategy-feedback.sqlite'));
  if (typeof path !== 'string' || path === ':memory:') throw new Error('a database file is required');
  if (command === 'list' && !existsSync(path)) return [];
  if (command === 'import' && (options.get('--confirm') !== true || typeof options.get('--file') !== 'string')) throw new Error('import requires --file and --confirm');
  if (command === 'list' && (options.has('--file') || options.has('--confirm'))) throw new Error('invalid list options');
  // Parse the complete input before creating a database file.
  const values = command === 'import' ? readFileSync(options.get('--file') as string, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : [];
  const directory = dirname(path);
  if (command === 'import') mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(directory);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())) throw new Error('feedback directory must be owner-only');
  if (command === 'import') {
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('feedback database must be an owner-only regular file');
  const db = new DatabaseSync(path, { readOnly: command === 'list' });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (command === 'list') return listFeedbackEvents(db);
    initFeedbackStore(db);
    return appendFeedbackEvents(db, values);
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(runStrategyFeedbackCli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
