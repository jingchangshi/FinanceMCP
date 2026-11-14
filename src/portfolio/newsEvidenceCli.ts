import { existsSync, readFileSync } from 'node:fs';
import { importNewsEvidence, listNewsEvidence, newsEvidencePath, openNewsEvidenceDb } from '../ashare/newsEvidence.js';
import type { PortfolioCliHelpers } from './cli.js';

export const NEWS_EVIDENCE_USAGE = `  news-evidence-import --file INPUT.jsonl --confirm [--db PATH]
  news-evidence-list --date YYYYMMDD --codes CODE[,CODE...] [--db PATH]`;

export function runNewsEvidenceCommand(command: string, h: PortfolioCliHelpers): boolean {
  if (!['news-evidence-import', 'news-evidence-list'].includes(command)) return false;
  const path = h.arg('db') ?? newsEvidencePath();
  if (command === 'news-evidence-import') {
    if (!h.flag('confirm')) throw new Error('news evidence import requires --confirm');
    const file = h.arg('file');
    if (!file) throw new Error('--file required');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
    const records = lines.map((line, i) => { try { return JSON.parse(line); } catch { throw new Error(`invalid JSONL line ${i + 1}`); } });
    const db = openNewsEvidenceDb(path);
    try { h.print(importNewsEvidence(db, records)); } finally { db.close(); }
  } else {
    const date = h.arg('date'), codes = h.arg('codes');
    if (!date || !codes) throw new Error('--date and --codes required');
    if (!existsSync(path)) { h.print([]); return true; }
    const db = openNewsEvidenceDb(path);
    try { h.print(listNewsEvidence(db, date, codes.split(','))); } finally { db.close(); }
  }
  return true;
}
