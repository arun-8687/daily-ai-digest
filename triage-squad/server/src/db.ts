import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';

export type SqlValue = string | number | null;

/** Thin wrapper over node:sqlite's DatabaseSync with a prepared-statement cache and BEGIN IMMEDIATE transactions. */
export class Database {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;

  constructor(path: string) {
    const inMemory = path === ':memory:';
    if (!inMemory) {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (!inMemory) {
      this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
    this.raw.exec(SCHEMA_SQL);
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as unknown as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as unknown as T[];
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /** Runs fn inside BEGIN IMMEDIATE ... COMMIT. Rolls back if fn throws. Nesting is an error. */
  tx<T>(fn: () => T): T {
    if (this.inTransaction) {
      throw new Error('nested transactions are not supported');
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        if (this.raw.isTransaction) this.raw.exec('ROLLBACK');
      } catch {
        // The original error is the one worth reporting.
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
