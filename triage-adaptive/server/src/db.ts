import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { applySchema } from './schema';

export type SqlParam = string | number | null;

/**
 * Thin wrapper over node:sqlite's DatabaseSync with a cached prepare.
 * Transactions are BEGIN IMMEDIATE and cannot be nested.
 */
export class Database {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTx = false;

  constructor(dbPath: string) {
    const isMemory = dbPath === ':memory:';
    if (!isMemory) fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (!isMemory) this.raw.exec('PRAGMA journal_mode = WAL');
    applySchema(this.raw);
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params) as unknown as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params) as unknown as T[];
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Runs fn inside BEGIN IMMEDIATE ... COMMIT. Rolls back and rethrows on error. */
  tx<T>(fn: () => T): T {
    if (this.inTx) throw new Error('Nested transactions are not supported');
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // The transaction may already be closed by SQLite; the original error is what matters.
      }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
