import { type Action, SLA_CRITICAL_MS, transition } from '../../shared/rules';
import {
  type AlertDTO,
  type AuditDTO,
  type BulkAckItem,
  type BulkAckResult,
  type IncidentDTO,
  type Severity,
  type Status,
} from '../../shared/types';
import { type Actor, auditFeed, auditToDto, type AuditRow, snapshot, writeAudit, type AuditAction } from './audit';
import { type AppContext, transact, type Unit } from './context';
import { HttpError } from './errors';
import { type GroupCandidate } from './grouping';
import { clamp, escapeLike } from './util';

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

export const INCIDENT_COLUMNS = `id, fingerprint, source, title, severity, status, assignee_id, version, rev,
  alert_count, first_seen, last_seen, acked_at, acked_by, resolved_at, resolved_by,
  sla_started_at, sla_breached_at, created_at, updated_at`;

/**
 * Row to DTO. slaDueAt is the deadline while the incident is critical, open and not yet breached.
 * Ack and resolve clear sla_started_at, so a non-null start means open and critical.
 */
export function toIncidentDto(r: IncidentRow): IncidentDTO {
  const slaDueAt =
    r.sla_started_at !== null && r.sla_breached_at === null ? r.sla_started_at + SLA_CRITICAL_MS : null;
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
    slaDueAt,
    slaBreachedAt: r.sla_breached_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function loadIncidentRow(ctx: AppContext, id: number): IncidentRow | undefined {
  return ctx.db.get<IncidentRow>(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`, id);
}

export function loadIncidentDto(ctx: AppContext, id: number): IncidentDTO | null {
  const row = loadIncidentRow(ctx, id);
  return row ? toIncidentDto(row) : null;
}

export function toGroupCandidate(id: number, status: Status, lastSeen: number, resolvedAt: number | null): GroupCandidate {
  return { id, status, lastSeen, resolvedAt };
}

/** Writes the given columns plus rev+1 and updated_at. Callers compute the new values inside a transaction. */
export function updateIncidentRow(
  ctx: AppContext,
  id: number,
  set: Record<string, string | number | null>,
  now: number,
  bumpVersion: boolean,
): void {
  const cols = Object.keys(set);
  const sets = cols.map((c) => `${c} = ?`);
  const values = cols.map((c) => set[c] ?? null);
  sets.push('rev = rev + 1', 'updated_at = ?');
  values.push(now);
  if (bumpVersion) sets.push('version = version + 1');
  ctx.db.run(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
}

export interface ListParams {
  status?: Status;
  severity?: Severity;
  assignee?: string;
  q?: string;
  cursor?: number;
  limit: number;
}

export const MAX_QUERY_LENGTH = 200;

/**
 * D11 list: newest id first, exclusive keyset cursor (id < cursor), so pages stay stable under inserts.
 * total is only computed on the first page (no cursor).
 */
export function listIncidents(
  ctx: AppContext,
  p: ListParams,
): { items: IncidentDTO[]; nextCursor: string | null; total: number | null } {
  const limit = clamp(Math.floor(p.limit) || 50, 1, 200);
  const where: string[] = [];
  const params: (string | number)[] = [];
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
  const q = p.q?.trim() ?? '';
  if (q.length > MAX_QUERY_LENGTH) {
    throw new HttpError(400, 'validation_failed', `q must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  if (q) {
    // Known gap: SQLite LIKE folds case for ASCII letters only, while the client's live membership
    // check (shared/rules matchesFilters) uses Unicode-aware toLowerCase. A non-ASCII title such as
    // 'Éclair' can therefore match on the client but not in this list. Accepted for now; see README.
    where.push("title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(q)}%`);
  }
  const filterSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // A missing cursor (undefined or null from untyped callers) means the first page.
  const hasCursor = p.cursor !== undefined && p.cursor !== null;
  let total: number | null = null;
  if (!hasCursor) {
    total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents ${filterSql}`, ...params)?.n ?? 0;
  }

  const pageWhere = hasCursor ? [...where, 'id < ?'] : where;
  const pageParams = hasCursor ? [...params, p.cursor as number] : params;
  const pageSql = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
  const rows = ctx.db.all<IncidentRow>(
    `SELECT ${INCIDENT_COLUMNS} FROM incidents ${pageSql} ORDER BY id DESC LIMIT ?`,
    ...pageParams,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore && page.length > 0 ? String(page[page.length - 1]!.id) : null;
  return { items: page.map(toIncidentDto), nextCursor, total };
}

export function getIncidentDetail(
  ctx: AppContext,
  id: number,
): { incident: IncidentDTO; alerts: AlertDTO[]; audit: AuditDTO[] } | null {
  const incident = loadIncidentDto(ctx, id);
  if (!incident) return null;
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
    }>(
      `SELECT id, incident_id, source, fingerprint, severity, title, payload, ts, received_at
         FROM alerts WHERE incident_id = ? ORDER BY ts DESC, id DESC LIMIT 50`,
      id,
    )
    .map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      source: r.source,
      fingerprint: r.fingerprint,
      severity: r.severity,
      title: r.title,
      payload: JSON.parse(r.payload) as unknown,
      ts: r.ts,
      receivedAt: r.received_at,
    }));
  const audit = ctx.db
    .all<AuditRow>(
      `SELECT id, incident_id, actor, actor_name, action, before_state, after_state, created_at
         FROM audit_log WHERE incident_id = ? ORDER BY id DESC LIMIT 200`,
      id,
    )
    .map(auditToDto);
  return { incident, alerts, audit };
}

const ACTION_AUDIT: Record<Exclude<Action, 'assign'>, AuditAction> = {
  ack: 'incident.acked',
  resolve: 'incident.resolved',
  reopen: 'incident.reopened',
};

/**
 * Applies a human action to one incident. Check order: 404, 409 version_conflict (with current),
 * 409 illegal_transition (with current), then for assign 400 unknown_assignee. Assigning the current
 * assignee is a no-op (no bump, no event). Each call is its own transaction.
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
    const row = loadIncidentRow(ctx, id);
    if (!row) throw new HttpError(404, 'not_found', 'Incident not found');
    const before = toIncidentDto(row);
    if (row.version !== expectedVersion) {
      throw new HttpError(
        409,
        'version_conflict',
        `Incident is at version ${row.version}, the request was based on version ${expectedVersion}`,
        before,
      );
    }
    const t = transition(row.status, action);
    if (!t.ok) {
      throw new HttpError(409, 'illegal_transition', `Cannot ${action} an incident that is ${row.status}`, before);
    }

    const now = unit.now;
    if (action === 'assign') {
      if (assigneeId === undefined) {
        throw new HttpError(400, 'validation_failed', 'assigneeId is required');
      }
      if (assigneeId !== null) {
        const user = ctx.db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', assigneeId);
        if (!user) throw new HttpError(400, 'unknown_assignee', 'Assignee is not a known user');
      }
      if (assigneeId === row.assignee_id) return before;
      updateIncidentRow(ctx, id, { assignee_id: assigneeId }, now, true);
      return recordChange(ctx, unit, id, before, actor, 'incident.assigned');
    }

    let set: Record<string, string | number | null>;
    if (action === 'ack') {
      set = { status: 'acked', acked_at: now, acked_by: actor.id, sla_started_at: null };
    } else if (action === 'resolve') {
      set = { status: 'resolved', resolved_at: now, resolved_by: actor.id, sla_started_at: null };
    } else {
      // Manual reopen: the incident is open again, so resolved and acked fields are cleared.
      const critical = row.severity === 'critical';
      set = {
        status: 'open',
        resolved_at: null,
        resolved_by: null,
        acked_at: null,
        acked_by: null,
        sla_started_at: critical ? now : null,
        sla_breached_at: null,
      };
    }
    updateIncidentRow(ctx, id, set, now, true);
    return recordChange(ctx, unit, id, before, actor, ACTION_AUDIT[action]);
  });
}

/**
 * Writes one audit row (before and after snapshots), then emits incident.updated with the
 * post-write DTO and the audit rows of this transaction. Must run inside transact().
 */
export function recordChange(
  ctx: AppContext,
  unit: Unit,
  id: number,
  before: IncidentDTO,
  actor: Actor,
  action: AuditAction,
): IncidentDTO {
  const incident = loadIncidentDto(ctx, id);
  if (!incident) throw new Error(`incident ${id} vanished inside a transaction`);
  const audit = writeAudit(ctx.db, {
    incidentId: id,
    actor,
    action,
    before: snapshot(before),
    after: snapshot(incident),
    now: unit.now,
  });
  unit.emit('incident.updated', { incident, audit: [audit] });
  return incident;
}

/**
 * Bulk ack. Each item is its own transaction and is judged independently:
 * 200 with the incident, 404, or 409 (version_conflict or illegal_transition) with current.
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
          ...(err.current ? { current: err.current } : {}),
        };
      }
      throw err;
    }
  });
}

