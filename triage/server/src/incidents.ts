import {
  SLA_CRITICAL_MS,
  transition,
  type Action,
} from '../../shared/rules';
import type {
  AlertDTO,
  AuditDTO,
  BulkAckItem,
  BulkAckResult,
  IncidentDTO,
  Severity,
  Status,
} from '../../shared/types';
import { auditForIncident, writeAudit, type Actor } from './audit';
import { transact, type AppContext, type Unit } from './context';
import { HttpError } from './errors';
import { findUserById } from './users';

export interface IncidentRow {
  id: number;
  fingerprint: string;
  source: string;
  title: string;
  severity: Severity;
  status: Status;
  assignee_id: string | null;
  version: number;
  alert_count: number;
  first_seen: number;
  last_seen: number;
  acked_at: number | null;
  acked_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  sla_started_at: number | null;
  sla_breached_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Columns the domain may write. Anything else is rejected at compile time. */
export type UpdatableColumn =
  | 'status'
  | 'severity'
  | 'title'
  | 'source'
  | 'assignee_id'
  | 'alert_count'
  | 'first_seen'
  | 'last_seen'
  | 'acked_at'
  | 'acked_by'
  | 'resolved_at'
  | 'resolved_by'
  | 'sla_started_at'
  | 'sla_breached_at';

export type Changes = Partial<Record<UpdatableColumn, string | number | null>>;

export function loadIncident(ctx: AppContext, id: number): IncidentRow | undefined {
  return ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
}

export function toIncidentDTO(r: IncidentRow): IncidentDTO {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    source: r.source,
    title: r.title,
    severity: r.severity,
    status: r.status,
    assigneeId: r.assignee_id,
    version: r.version,
    alertCount: r.alert_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    ackedAt: r.acked_at,
    ackedBy: r.acked_by,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    slaDueAt: r.sla_started_at !== null && r.sla_breached_at === null ? r.sla_started_at + SLA_CRITICAL_MS : null,
    slaBreachedAt: r.sla_breached_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The fields an audit entry records as "before" and "after". */
export function snapshotOf(r: IncidentRow): Record<string, unknown> {
  return {
    status: r.status,
    severity: r.severity,
    assigneeId: r.assignee_id,
    version: r.version,
    alertCount: r.alert_count,
    lastSeen: r.last_seen,
    slaBreachedAt: r.sla_breached_at,
  };
}

/** Writes the given columns, bumps `version`, and returns the fresh row. Every write goes through here. */
export function updateIncident(ctx: AppContext, id: number, changes: Changes): IncidentRow {
  const entries = Object.entries(changes) as [UpdatableColumn, string | number | null][];
  const sets = entries.map(([col]) => `${col} = ?`);
  sets.push('version = version + 1', 'updated_at = ?');
  ctx.db.run(
    `UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`,
    ...entries.map(([, value]) => value),
    ctx.clock.now(),
    id,
  );
  return loadIncident(ctx, id) as IncidentRow;
}

export function conflictError(row: IncidentRow): HttpError {
  return new HttpError(
    409,
    'version_conflict',
    `INC-${row.id} was changed by someone else (it is now at version ${row.version}). Your change was not applied.`,
    toIncidentDTO(row),
  );
}

function illegalError(row: IncidentRow, message: string): HttpError {
  return new HttpError(409, 'illegal_transition', message, toIncidentDTO(row));
}

export interface ListParams {
  status?: Status;
  severity?: Severity;
  /** A user id, or "none" for unassigned. */
  assignee?: string;
  q?: string;
  /** Exclusive upper bound on incident id. Ids are monotonic, so pages stay stable under inserts. */
  cursor?: number;
  limit: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listIncidents(ctx: AppContext, p: ListParams): { items: IncidentDTO[]; nextCursor: string | null; total: number | null } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (p.status) {
    where.push('status = ?');
    args.push(p.status);
  }
  if (p.severity) {
    where.push('severity = ?');
    args.push(p.severity);
  }
  if (p.assignee === 'none') {
    where.push('assignee_id IS NULL');
  } else if (p.assignee) {
    where.push('assignee_id = ?');
    args.push(p.assignee);
  }
  if (p.q) {
    where.push("title LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(p.q)}%`);
  }

  const filterSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total =
    p.cursor === undefined
      ? (ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents ${filterSql}`, ...args) as { n: number }).n
      : null;

  const pageWhere = p.cursor === undefined ? where : [...where, 'id < ?'];
  const pageArgs = p.cursor === undefined ? args : [...args, p.cursor];
  const pageSql = `SELECT * FROM incidents ${pageWhere.length > 0 ? `WHERE ${pageWhere.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const rows = ctx.db.all<IncidentRow>(pageSql, ...pageArgs, p.limit + 1);

  const hasMore = rows.length > p.limit;
  const items = rows.slice(0, p.limit).map(toIncidentDTO);
  const nextCursor = hasMore && items.length > 0 ? String(items[items.length - 1].id) : null;
  return { items, nextCursor, total };
}

export function getIncidentDetail(ctx: AppContext, id: number): { incident: IncidentDTO; alerts: AlertDTO[]; audit: AuditDTO[] } | null {
  const row = loadIncident(ctx, id);
  if (!row) return null;
  const alerts = ctx.db
    .all<{
      id: number;
      incident_id: number;
      source: string;
      fingerprint: string;
      severity: Severity;
      title: string;
      payload: string;
      ts: number;
      received_at: number;
    }>('SELECT * FROM alerts WHERE incident_id = ? ORDER BY ts DESC, id DESC LIMIT 50', id)
    .map((a) => ({
      id: a.id,
      incidentId: a.incident_id,
      source: a.source,
      fingerprint: a.fingerprint,
      severity: a.severity,
      title: a.title,
      payload: JSON.parse(a.payload) as unknown,
      ts: a.ts,
      receivedAt: a.received_at,
    }));
  return { incident: toIncidentDTO(row), alerts, audit: auditForIncident(ctx, id, 200) };
}

function userExists(ctx: AppContext, id: string): boolean {
  return findUserById(ctx, id) !== null;
}

/**
 * Applies a lifecycle action or assignment under optimistic concurrency.
 * Order of checks: exists (404), version matches If-Match (409 version_conflict),
 * transition is legal (409 illegal_transition). Stale writes are therefore rejected
 * even when the stale action would also have been illegal.
 */
export function applyAction(
  ctx: AppContext,
  id: number,
  action: Action,
  actor: Actor,
  expectedVersion: number,
  assigneeId?: string | null,
): IncidentDTO {
  return transact(ctx, (unit: Unit) => {
    const row = loadIncident(ctx, id);
    if (!row) throw new HttpError(404, 'not_found', `INC-${id} does not exist`);
    if (row.version !== expectedVersion) throw conflictError(row);

    const now = ctx.clock.now();
    const before = snapshotOf(row);
    let next: IncidentRow;
    let auditAction: string;

    switch (action) {
      case 'ack': {
        if (!transition(row.status, 'ack').ok) {
          throw illegalError(row, `INC-${id} is ${row.status}. Only an open incident can be acked.`);
        }
        next = updateIncident(ctx, id, { status: 'acked', acked_at: now, acked_by: actor.id, sla_started_at: null });
        auditAction = 'incident.acked';
        break;
      }
      case 'resolve': {
        if (!transition(row.status, 'resolve').ok) {
          throw illegalError(row, `INC-${id} is already resolved.`);
        }
        next = updateIncident(ctx, id, {
          status: 'resolved',
          resolved_at: now,
          resolved_by: actor.id,
          sla_started_at: null,
        });
        auditAction = 'incident.resolved';
        break;
      }
      case 'reopen': {
        if (!transition(row.status, 'reopen').ok) {
          throw illegalError(row, `INC-${id} is ${row.status}. Only a resolved incident can be reopened.`);
        }
        next = updateIncident(ctx, id, {
          status: 'open',
          acked_at: null,
          acked_by: null,
          resolved_at: null,
          resolved_by: null,
          sla_breached_at: null,
          sla_started_at: row.severity === 'critical' ? now : null,
        });
        auditAction = 'incident.reopened';
        break;
      }
      case 'assign': {
        if (!transition(row.status, 'assign').ok) {
          throw illegalError(row, `INC-${id} is resolved. Reopen it before changing the assignee.`);
        }
        const target = assigneeId ?? null;
        if (target !== null && !userExists(ctx, target)) {
          throw new HttpError(400, 'unknown_assignee', `No user with id "${target}"`);
        }
        if (target === row.assignee_id) return toIncidentDTO(row);
        next = updateIncident(ctx, id, { assignee_id: target });
        auditAction = 'incident.assigned';
        break;
      }
    }

    const audit = writeAudit(ctx, {
      incidentId: id,
      actor,
      action: auditAction,
      before,
      after: snapshotOf(next),
    });
    unit.emit('incident.updated', { incident: toIncidentDTO(next), audit: [audit] });
    return toIncidentDTO(next);
  });
}

/**
 * Each item is its own transaction, so one failure never rolls back the others.
 * Callers get a per-item report and can retry just the failed ids.
 */
export function bulkAck(ctx: AppContext, actor: Actor, items: BulkAckItem[]): BulkAckResult[] {
  return items.map((item): BulkAckResult => {
    try {
      const incident = applyAction(ctx, item.id, 'ack', actor, item.version);
      return { id: item.id, ok: true, status: 200, incident };
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          id: item.id,
          ok: false,
          status: err.status,
          error: { code: err.code, message: err.message },
          current: err.current,
        };
      }
      throw err;
    }
  });
}
