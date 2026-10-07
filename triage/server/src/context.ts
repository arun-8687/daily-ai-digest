import type { AppConfig } from './config';
import type { Clock } from './clock';
import { Database } from './db';
import { Hub, type Frame } from './hub';

export interface AppContext {
  readonly db: Database;
  readonly clock: Clock;
  readonly hub: Hub;
  readonly config: AppConfig;
}

export function createContext(config: AppConfig, clock: Clock): AppContext {
  return { db: new Database(config.dbPath), clock, hub: new Hub(), config };
}

/**
 * Collects the events a transaction emits. Each one is written to the events table
 * inside the transaction (so the log is atomic with the data) and published to live
 * subscribers only after COMMIT.
 */
export class Unit {
  private readonly frames: Frame[] = [];

  constructor(private readonly ctx: AppContext) {}

  emit(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    const { lastInsertRowid } = this.ctx.db.run(
      'INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)',
      type,
      data,
      this.ctx.clock.now(),
    );
    this.frames.push({ seq: lastInsertRowid, type, data });
  }

  flush(): void {
    for (const frame of this.frames) this.ctx.hub.publish(frame);
  }
}

export function transact<T>(ctx: AppContext, fn: (unit: Unit) => T): T {
  const unit = new Unit(ctx);
  const result = ctx.db.tx(() => fn(unit));
  unit.flush();
  return result;
}
