import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export type Param = string | number | null;

/**
 * Thin wrapper over node:sqlite. The server is single-threaded and every write goes
 * through `tx`, so each transaction is serialised with respect to every other request.
 */
export class Database {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private inTx = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.raw.exec(SCHEMA_SQL);
    const { user_version } = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version === 0) this.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** BEGIN IMMEDIATE so the write lock is taken up front. Nesting is a bug, so it throws. */
  tx<T>(fn: () => T): T {
    if (this.inTx) throw new Error('nested transactions are not supported');
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
