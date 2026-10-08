// Append-only audit log (D7). Writes happen through Unit.audit() inside transact(); this module reads and maps rows.
import type { AuditDTO } from '../../shared/types';
import type { AppContext } from './context';

export interface Actor {
  id: string;
  name: string;
}

export const SYSTEM_INGEST: Actor = { id: 'system:ingest', name: 'Ingest' };
export const SYSTEM_SLA: Actor = { id: 'system:sla', name: 'SLA monitor' };

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

export function auditRowToDTO(row: AuditRow): AuditDTO {
  return {
    id: row.id,
    incidentId: row.incident_id,
    actor: row.actor,
    actorName: row.actor_name,
    action: row.action,
    before: row.before_state === null ? null : (JSON.parse(row.before_state) as Record<string, unknown>),
    after: row.after_state === null ? null : (JSON.parse(row.after_state) as Record<string, unknown>),
    createdAt: row.created_at,
  };
}

/** Newest first. `before` is an exclusive audit id cursor. */
export function auditFeed(ctx: AppContext, before: number | null, limit: number): AuditDTO[] {
  const n = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows =
    before === null
      ? ctx.db.all<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', n)
      : ctx.db.all<AuditRow>('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', before, n);
  return rows.map(auditRowToDTO);
}
