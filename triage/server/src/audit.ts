import type { AuditDTO } from '../../shared/types';
import type { AppContext } from './context';

export interface Actor {
  id: string;
  name: string;
}

export const SYSTEM_INGEST: Actor = { id: 'system:ingest', name: 'Ingest' };
export const SYSTEM_SLA: Actor = { id: 'system:sla', name: 'SLA monitor' };

interface AuditRow {
  id: number;
  incident_id: number | null;
  actor: string;
  actor_name: string;
  action: string;
  before_state: string | null;
  after_state: string | null;
  created_at: number;
}

function toDTO(r: AuditRow): AuditDTO {
  return {
    id: r.id,
    incidentId: r.incident_id,
    actor: r.actor,
    actorName: r.actor_name,
    action: r.action,
    before: r.before_state === null ? null : (JSON.parse(r.before_state) as Record<string, unknown>),
    after: r.after_state === null ? null : (JSON.parse(r.after_state) as Record<string, unknown>),
    createdAt: r.created_at,
  };
}

/** Appends one audit row. The table has no UPDATE or DELETE path (see schema triggers). */
export function writeAudit(
  ctx: AppContext,
  input: {
    incidentId: number | null;
    actor: Actor;
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): AuditDTO {
  const createdAt = ctx.clock.now();
  const before = input.before === null ? null : JSON.stringify(input.before);
  const after = input.after === null ? null : JSON.stringify(input.after);
  const { lastInsertRowid } = ctx.db.run(
    `INSERT INTO audit_log (incident_id, actor, actor_name, action, before_state, after_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.incidentId,
    input.actor.id,
    input.actor.name,
    input.action,
    before,
    after,
    createdAt,
  );
  return toDTO({
    id: lastInsertRowid,
    incident_id: input.incidentId,
    actor: input.actor.id,
    actor_name: input.actor.name,
    action: input.action,
    before_state: before,
    after_state: after,
    created_at: createdAt,
  });
}

export function auditForIncident(ctx: AppContext, incidentId: number, limit: number): AuditDTO[] {
  return ctx.db
    .all<AuditRow>('SELECT * FROM audit_log WHERE incident_id = ? ORDER BY id DESC LIMIT ?', incidentId, limit)
    .map(toDTO);
}

/** Global feed, newest first. `before` is an exclusive cursor on audit id. */
export function auditFeed(ctx: AppContext, before: number | null, limit: number): AuditDTO[] {
  const rows =
    before === null
      ? ctx.db.all<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit)
      : ctx.db.all<AuditRow>('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit);
  return rows.map(toDTO);
}
