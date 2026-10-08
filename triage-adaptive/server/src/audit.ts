import type { AuditDTO, IncidentDTO } from '../../shared/types';
import type { AppContext } from './context';
import type { Database } from './db';

export interface Actor {
  id: string;
  name: string;
}

export const SYSTEM_INGEST: Actor = { id: 'system:ingest', name: 'Ingest' };
export const SYSTEM_SLA: Actor = { id: 'system:sla', name: 'SLA monitor' };

export type AuditAction =
  | 'incident.created'
  | 'incident.acked'
  | 'incident.resolved'
  | 'incident.reopened'
  | 'incident.assigned'
  | 'incident.escalated'
  | 'incident.sla_breached'
  | 'alert.attached'
  | 'user.role_changed'
  | 'auth.login';

export interface AuditRow {
  id: number;
  incident_id: number | null;
  actor: string;
  actor_name: string;
  action: string;
  before_state: string | null;
  after_state: string | null;
  created_at: number;
}

/** The fields snapshotted into audit before/after state (D7). */
export function snapshot(d: IncidentDTO): Record<string, unknown> {
  return {
    status: d.status,
    severity: d.severity,
    assigneeId: d.assigneeId,
    version: d.version,
    rev: d.rev,
    alertCount: d.alertCount,
    lastSeen: d.lastSeen,
    slaBreachedAt: d.slaBreachedAt,
  };
}

export function auditToDto(r: AuditRow): AuditDTO {
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

export interface AuditWrite {
  incidentId: number | null;
  actor: Actor;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: number;
}

/** Appends one audit row. Must be called inside a transaction. */
export function writeAudit(db: Database, w: AuditWrite): AuditDTO {
  const before = w.before === null ? null : JSON.stringify(w.before);
  const after = w.after === null ? null : JSON.stringify(w.after);
  const r = db.run(
    'INSERT INTO audit_log (incident_id, actor, actor_name, action, before_state, after_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    w.incidentId,
    w.actor.id,
    w.actor.name,
    w.action,
    before,
    after,
    w.now,
  );
  return {
    id: r.lastInsertRowid,
    incidentId: w.incidentId,
    actor: w.actor.id,
    actorName: w.actor.name,
    action: w.action,
    before: w.before,
    after: w.after,
    createdAt: w.now,
  };
}

const AUDIT_COLUMNS =
  'id, incident_id, actor, actor_name, action, before_state, after_state, created_at';

/** Newest-first audit feed. before is an exclusive id cursor. */
export function auditFeed(ctx: AppContext, before: number | null, limit: number): AuditDTO[] {
  const rows = ctx.db.all<AuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    before,
    before,
    limit,
  );
  return rows.map(auditToDto);
}
