import { type AppConfig } from './config';
import { type Clock } from './clock';
import { Database } from './db';
import { type Frame, Hub } from './hub';

export interface AppContext {
  db: Database;
  clock: Clock;
  hub: Hub;
  config: AppConfig;
}

export function createContext(config: AppConfig, clock: Clock): AppContext {
  return { db: new Database(config.dbPath), clock, hub: new Hub(), config };
}

export function closeContext(ctx: AppContext): void {
  ctx.db.close();
}

/**
 * Write-side handle inside transact(). emit() inserts the event row in the same
 * transaction and remembers the frame; frames reach the hub only after COMMIT.
 */
export class Unit {
  readonly frames: Frame[] = [];
  /** Clock reading taken when the transaction started. */
  readonly now: number;
  private readonly db: Database;

  constructor(db: Database, now: number) {
    this.db = db;
    this.now = now;
  }

  emit(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    const r = this.db.run('INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)', type, data, this.now);
    this.frames.push({ seq: r.lastInsertRowid, type, data });
  }
}

/**
 * Runs fn in one BEGIN IMMEDIATE transaction. If fn throws, the transaction is
 * rolled back and no frames are published. Otherwise the frames are published
 * to the hub after COMMIT, in seq order.
 */
export function transact<T>(ctx: AppContext, fn: (unit: Unit) => T): T {
  const unit = new Unit(ctx.db, ctx.clock.now());
  const result = ctx.db.tx(() => fn(unit));
  for (const frame of unit.frames) ctx.hub.publish(frame);
  return result;
}
