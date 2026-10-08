// Incident reads, state transitions (ack, resolve, reopen, assign) and bulk ack.
import { SLA_CRITICAL_MS, transition, type Action } from '../../shared/rules';
import type {
  AlertDTO,
  AuditDTO,
  BulkAckItem,
  BulkAckResult,
  IncidentDTO,
  IncidentEventData,
  Severity,
  Status,
} from '../../shared/types';
import { auditRowToDTO, type Actor, type AuditRow } from './audit';
import { transact, type AppContext, type Unit } from './context';
import type { Database, SqlValue } from './db';
import { HttpError } from './errors';
import { escapeLike } from './util';

export interface IncidentRow {
  id: number;
  fingerprint: string;
  source: string;
  title: string;
  severity: Severity;
  status: Status;
  assignee_id: string | null;
  version: number;
  rev: number;
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

export interface AlertRow {
  id: number;
  incident_id: number;
  source: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  payload: string;
  ts: number;
  received_at: number;
}

export interface ListParams {
  status?: Status;
  severity?: Severity;
  assignee?: string;
  q?: string;
  cursor?: number;
  limit: number;
}

export function loadIncidentRow(db: Database, id: number): IncidentRow | undefined {
  return db.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
}

/** Writes every mutable column of the row. Callers mutate the object, then save it once. */
export function saveIncidentRow(db: Database, r: IncidentRow): void {
  db.run(
    `UPDATE incidents SET source = ?, title = ?, severity = ?, status = ?, assignee_id = ?, version = ?, rev = ?,
            alert_count = ?, first_seen = ?, last_seen = ?, acked_at = ?, acked_by = ?, resolved_at = ?,
            resolved_by = ?, sla_started_at = ?, sla_breached_at = ?, updated_at = ?
      WHERE id = ?`,
    r.source,
    r.title,
    r.severity,
    r.status,
    r.assignee_id,
    r.version,
    r.rev,
    r.alert_count,
    r.first_seen,
    r.last_seen,
    r.acked_at,
    r.acked_by,
    r.resolved_at,
    r.resolved_by,
    r.sla_started_at,
    r.sla_breached_at,
    r.updated_at,
    r.id,
  );
}

export function insertIncidentRow(db: Database, r: Omit<IncidentRow, 'id'>): number {
  const values: SqlValue[] = [
    r.fingerprint,
    r.source,
    r.title,
    r.severity,
    r.status,
    r.assignee_id,
    r.version,
    r.rev,
    r.alert_count,
    r.first_seen,
    r.last_seen,
    r.acked_at,
    r.acked_by,
    r.resolved_at,
    r.resolved_by,
    r.sla_started_at,
    r.sla_breached_at,
    r.created_at,
    r.updated_at,
  ];
  return db.run(
    `INSERT INTO incidents (fingerprint, source, title, severity, status, assignee_id, version, rev, alert_count,
                            first_seen, last_seen, acked_at, acked_by, resolved_at, resolved_by, sla_started_at,
                            sla_breached_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...values,
  ).lastInsertRowid;
}

export function toIncidentDTO(r: IncidentRow): IncidentDTO {
  const slaRunning = r.sla_started_at !== null && r.sla_breached_at === null;
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    source: r.source,
    title: r.title,
    severity: r.severity,
    status: r.status,
    assigneeId: r.assignee_id,
    version: r.version,
    rev: r.rev,
    alertCount: r.alert_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    ackedAt: r.acked_at,
    ackedBy: r.acked_by,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    slaDueAt: slaRunning && r.sla_started_at !== null ? r.sla_started_at + SLA_CRITICAL_MS : null,
    slaBreachedAt: r.sla_breached_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toAlertDTO(r: AlertRow): AlertDTO {
  return {
    id: r.id,
    incidentId: r.incident_id,
    source: r.source,
    fingerprint: r.fingerprint,
    severity: r.severity,
    title: r.title,
    payload: JSON.parse(r.payload) as unknown,
    ts: r.ts,
    receivedAt: r.received_at,
  };
}

/** The audit snapshot shape (D7). */
export function snapshotOf(r: IncidentRow): Record<string, unknown> {
  return {
    status: r.status,
    severity: r.severity,
    assigneeId: r.assignee_id,
    version: r.version,
    rev: r.rev,
    alertCount: r.alert_count,
    lastSeen: r.last_seen,
    slaBreachedAt: r.sla_breached_at,
  };
}

/** Loads the incident as it now stands inside the transaction and queues an event carrying the audit entries written so far. */
export function emitIncident(ctx: AppContext, unit: Unit, type: string, id: number): IncidentDTO {
  const row = loadIncidentRow(ctx.db, id);
  if (!row) {
    throw new Error(`incident ${id} vanished inside a transaction`);
  }
  const incident = toIncidentDTO(row);
  const payload: IncidentEventData = { incident, audit: [...unit.audits] };
  unit.emit(type, payload);
  return incident;
}

export function listIncidents(
  ctx: AppContext,
  p: ListParams,
): { items: IncidentDTO[]; nextCursor: string | null; total: number | null } {
  const where: string[] = [];
  const params: SqlValue[] = [];

  if (p.status) {
    where.push('status = ?');
    params.push(p.status);
  }
  if (p.severity) {
    where.push('severity = ?');
    params.push(p.severity);
  }
  if (p.assignee === 'none') {
    where.push('assignee_id IS NULL');
  } else if (p.assignee) {
    where.push('assignee_id = ?');
    params.push(p.assignee);
  }
  const q = p.q?.trim();
  if (q) {
    if (q.length > 200) {
      throw new HttpError(400, 'bad_query', 'q must be at most 200 characters');
    }
    where.push("title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(q)}%`);
  }

  const limit = Math.min(200, Math.max(1, Math.trunc(p.limit)));
  const filterSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  const total =
    p.cursor === undefined
      ? (ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents${filterSql}`, ...params)?.n ?? 0)
      : null;

  const pageWhere = p.cursor === undefined ? where : [...where, 'id < ?'];
  const pageParams: SqlValue[] = p.cursor === undefined ? [...params] : [...params, p.cursor];
  const pageSql = `SELECT * FROM incidents${pageWhere.length > 0 ? ` WHERE ${pageWhere.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const rows = ctx.db.all<IncidentRow>(pageSql, ...pageParams, limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toIncidentDTO),
    nextCursor: hasMore && last ? String(last.id) : null,
    total,
  };
}

export function getIncidentDetail(
  ctx: AppContext,
  id: number,
): { incident: IncidentDTO; alerts: AlertDTO[]; audit: AuditDTO[] } | null {
  const row = loadIncidentRow(ctx.db, id);
  if (!row) return null;
  const alerts = ctx.db
    .all<AlertRow>(
      'SELECT id, incident_id, source, fingerprint, severity, title, payload, ts, received_at FROM alerts WHERE incident_id = ? ORDER BY ts DESC, id DESC LIMIT 50',
      id,
    )
    .map(toAlertDTO);
  const audit = ctx.db
    .all<AuditRow>('SELECT * FROM audit_log WHERE incident_id = ? ORDER BY id DESC LIMIT 200', id)
    .map(auditRowToDTO);
  return { incident: toIncidentDTO(row), alerts, audit };
}

function userExists(db: Database, id: string): boolean {
  return db.get('SELECT id FROM users WHERE id = ?', id) !== undefined;
}

function bumpRev(r: IncidentRow, now: number): void {
  r.rev += 1;
  r.updated_at = now;
}

function bumpVersion(r: IncidentRow, now: number): void {
  r.version += 1;
  bumpRev(r, now);
}

/**
 * Applies a human action with optimistic concurrency. Check order (D5): exists, version, legality, then body.
 * `assigneeId` is only used by the 'assign' action; undefined is treated as unassigned.
 */
export function applyAction(
  ctx: AppContext,
  id: number,
  action: Action,
  actor: Actor,
  expectedVersion: number,
  assigneeId?: string | null,
): IncidentDTO {
  return transact(ctx, (unit) => {
    const now = ctx.clock.now();
    const row = loadIncidentRow(ctx.db, id);
    if (!row) {
      throw new HttpError(404, 'not_found', `Incident ${id} not found`);
    }
    const current = toIncidentDTO(row);

    if (row.version !== expectedVersion) {
      throw new HttpError(
        409,
        'version_conflict',
        `Incident ${id} is at version ${row.version}, not ${expectedVersion}`,
        current,
      );
    }
    if (!transition(row.status, action).ok) {
      throw new HttpError(409, 'illegal_transition', `Cannot ${action} an incident that is ${row.status}`, current);
    }

    const before = snapshotOf(row);

    switch (action) {
      case 'ack': {
        row.status = 'acked';
        row.acked_at = now;
        row.acked_by = actor.id;
        row.sla_started_at = null;
        bumpVersion(row, now);
        break;
      }
      case 'resolve': {
        row.status = 'resolved';
        row.resolved_at = now;
        row.resolved_by = actor.id;
        row.sla_started_at = null;
        bumpVersion(row, now);
        break;
      }
      case 'reopen': {
        row.status = 'open';
        row.acked_at = null;
        row.acked_by = null;
        row.resolved_at = null;
        row.resolved_by = null;
        row.sla_breached_at = null;
        row.sla_started_at = row.severity === 'critical' ? now : null;
        bumpVersion(row, now);
        break;
      }
      case 'assign': {
        const target = assigneeId ?? null;
        if (target !== null && !userExists(ctx.db, target)) {
          throw new HttpError(400, 'unknown_assignee', `Unknown user ${target}`);
        }
        if (target === row.assignee_id) {
          return current;
        }
        row.assignee_id = target;
        bumpVersion(row, now);
        break;
      }
    }

    saveIncidentRow(ctx.db, row);
    const auditAction =
      action === 'ack'
        ? 'incident.acked'
        : action === 'resolve'
          ? 'incident.resolved'
          : action === 'reopen'
            ? 'incident.reopened'
            : 'incident.assigned';
    unit.audit({ incidentId: id, actor, action: auditAction, before, after: snapshotOf(row) });
    return emitIncident(ctx, unit, 'incident.updated', id);
  });
}

/** Each item is its own transaction; each result carries that item's own outcome. */
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
