import type { AuditDTO } from '../../shared/types';
import type { AppConfig } from './config';
import type { Clock } from './clock';
import { Database } from './db';
import { Hub, type Frame } from './hub';

export interface AppContext {
  db: Database;
  clock: Clock;
  hub: Hub;
  config: AppConfig;
}

export function createContext(config: AppConfig, clock: Clock): AppContext {
  return {
    db: new Database(config.dbPath),
    clock,
    hub: new Hub(),
    config,
  };
}

export interface AuditEntry {
  incidentId: number | null;
  actor: { id: string; name: string };
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Writes made inside one transaction. Events are inserted into the events table immediately
 * (so they are part of the same COMMIT) and queued as frames for publishing after COMMIT.
 */
export class Unit {
  /** Audit entries written so far in this transaction. */
  readonly audits: AuditDTO[] = [];
  /** Frames to publish once the transaction has committed. */
  readonly frames: Frame[] = [];

  private readonly db: Database;
  private readonly clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  emit(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)',
      type,
      data,
      this.clock.now(),
    );
    this.frames.push({ seq: lastInsertRowid, type, data });
  }

  audit(entry: AuditEntry): AuditDTO {
    const createdAt = this.clock.now();
    const beforeJson = entry.before === null ? null : JSON.stringify(entry.before);
    const afterJson = entry.after === null ? null : JSON.stringify(entry.after);
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO audit_log (incident_id, actor, actor_name, action, before_state, after_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.incidentId,
      entry.actor.id,
      entry.actor.name,
      entry.action,
      beforeJson,
      afterJson,
      createdAt,
    );
    const dto: AuditDTO = {
      id: lastInsertRowid,
      incidentId: entry.incidentId,
      actor: entry.actor.id,
      actorName: entry.actor.name,
      action: entry.action,
      before: entry.before,
      after: entry.after,
      createdAt,
    };
    this.audits.push(dto);
    return dto;
  }
}

/** Runs fn in one BEGIN IMMEDIATE transaction; publishes its events to live subscribers only after COMMIT. */
export function transact<T>(ctx: AppContext, fn: (unit: Unit) => T): T {
  const unit = new Unit(ctx.db, ctx.clock);
  const result = ctx.db.tx(() => fn(unit));
  for (const frame of unit.frames) {
    ctx.hub.publish(frame);
  }
  return result;
}
