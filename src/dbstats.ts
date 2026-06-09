import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DbStats {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  languages: string[];
}

/** Path to a view's CodeGraph SQLite database. */
export function dbPath(viewDir: string): string {
  return join(viewDir, '.codegraph', 'codegraph.db');
}

/**
 * Cheap index stats read straight from SQLite — counts only, NO change scan.
 * This is the deliberate fast path for `workspace_repos` (the `codegraph status`
 * CLI always runs a full-tree change scan, which is expensive on non-git views).
 * Returns null when the repo isn't indexed yet.
 */
export function readDbStats(viewDir: string): DbStats | null {
  const file = dbPath(viewDir);
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
    const languages = (
      db.prepare('SELECT DISTINCT language FROM files WHERE language IS NOT NULL').all() as {
        language: string;
      }[]
    ).map((r) => r.language);
    return {
      fileCount: count('files'),
      nodeCount: count('nodes'),
      edgeCount: count('edges'),
      dbSizeBytes: statSync(file).size,
      languages,
    };
  } finally {
    db.close();
  }
}
