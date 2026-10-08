import {
  FUTURE_SKEW_MS,
  GROUP_WINDOW_MS,
  maxSeverity,
} from '../../shared/rules';
import {
  type AuditDTO,
  type IncidentDTO,
  type IngestResponse,
  SEVERITIES,
  type Severity,
} from '../../shared/types';
import { SYSTEM_INGEST, snapshot, writeAudit } from './audit';
import { type AppContext, transact, type Unit } from './context';
import { HttpError } from './errors';
import { decideGrouping, type GroupCandidate, type GroupDecision } from './grouping';
import {
  loadIncidentDto,
  loadIncidentRow,
  toGroupCandidate,
  updateIncidentRow,
} from './incidents';
import { sha256Hex, stableStringify } from './util';

export interface AlertInput {
  source: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  payload: Record<string, unknown>;
  ts: number;
}

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * V8 rolls impossible dates over (2026-02-31 becomes 2026-03-03) and Date.parse accepts them,
 * so the calendar and clock fields are checked explicitly before the string is trusted.
 */
function isRealIsoDateTime(match: RegExpMatchArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  if (match[4] !== undefined && Number(match[4]) > 23) return false;
  if (match[5] !== undefined && Number(match[5]) > 59) return false;
  if (match[6] !== undefined && Number(match[6]) > 59) return false;
  return true;
}

/**
 * D13 validation. Every problem is collected and reported together in one 400 validation_failed.
 * ts may be epoch milliseconds or an ISO 8601 string. A ts more than FUTURE_SKEW_MS after `now` is rejected.
 * payload is optional (absent means {}); null is not accepted.
 */
export function parseAlert(body: Record<string, unknown>, now: number): AlertInput {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'validation_failed', 'body: must be a JSON object');
  }
  const problems: string[] = [];

  const { source, fingerprint, severity, title: rawTitle, ts: rawTs, payload: rawPayload } = body;

  if (typeof source !== 'string' || source.length < 1 || source.length > 64) {
    problems.push('source: must be a string of 1-64 characters');
  }
  if (typeof fingerprint !== 'string' || fingerprint.length < 1 || fingerprint.length > 256) {
    problems.push('fingerprint: must be a string of 1-256 characters');
  }
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
    problems.push(`severity: must be one of ${SEVERITIES.join(', ')}`);
  }
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : null;
  if (title === null || title.length < 1 || title.length > 200) {
    problems.push('title: must be a string of 1-200 characters after trimming');
  }

  // ts is integer epoch milliseconds (a fractional value would make first_seen/last_seen REAL and
  // break the content hash), or an ISO 8601 string that names a real calendar date and time.
  let ts: number | null = null;
  if (typeof rawTs === 'number' && Number.isSafeInteger(rawTs) && rawTs >= 0) {
    ts = rawTs;
  } else if (typeof rawTs === 'string') {
    const match = ISO_TIMESTAMP.exec(rawTs);
    if (match && isRealIsoDateTime(match)) {
      // A date-time without a zone designator is read as UTC, not server-local time.
      const hasTime = match[4] !== undefined;
      const hasZone = match[7] !== undefined;
      const parsed = Date.parse(hasTime && !hasZone ? `${rawTs}Z` : rawTs);
      if (Number.isSafeInteger(parsed)) ts = parsed;
    }
  }
  if (ts === null) {
    problems.push('ts: must be epoch milliseconds or an ISO 8601 string');
  } else if (ts > now + FUTURE_SKEW_MS) {
    problems.push('ts: is more than 60 seconds in the future');
  }

  let payload: Record<string, unknown> = {};
  if (rawPayload !== undefined) {
    if (isPlainObject(rawPayload)) payload = rawPayload;
    else problems.push('payload: must be an object when present');
  }

  if (problems.length > 0) {
    throw new HttpError(400, 'validation_failed', problems.join('; '));
  }
  return {
    source: source as string,
    fingerprint: fingerprint as string,
    severity: severity as Severity,
    title: title as string,
    payload,
    ts: ts as number,
  };
}

/** sha256 over the stable JSON of the alert content (D2). */
export function alertContentHash(a: AlertInput): string {
  return sha256Hex(
    stableStringify({
      source: a.source,
      fingerprint: a.fingerprint,
      severity: a.severity,
      title: a.title,
      payload: a.payload,
      ts: a.ts,
    }),
  );
}

export interface IngestOutcome {
  status: number;
  body: IngestResponse;
  replayed: boolean;
}

/**
 * D2 ingest, one BEGIN IMMEDIATE transaction:
 *  1. Idempotency-Key: same key + same content hash replays the stored response; a different hash is 422.
 *  2. (fingerprint, content_hash) already present: action duplicate, no changes.
 *  3. Grouping (D1) against SQL candidates. Then fold, reopen, attach or create, with the D4 counters,
 *     D6 SLA start and D7 audits.
 *  4. The response is stored under the key in the same transaction.
 */
export function ingestAlert(ctx: AppContext, alert: AlertInput, idempotencyKey?: string): IngestOutcome {
  if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 255)) {
    throw new HttpError(400, 'validation_failed', 'Idempotency-Key: must be 1-255 characters');
  }
  const hash = alertContentHash(alert);
  return transact(ctx, (unit) => {
    const db = ctx.db;
    const now = unit.now;

    if (idempotencyKey !== undefined) {
      const stored = db.get<{ content_hash: string; status: number; body: string; created_at: number }>(
        'SELECT content_hash, status, body, created_at FROM idempotency WHERE key = ?',
        idempotencyKey,
      );
      if (stored && now - stored.created_at < IDEMPOTENCY_TTL_MS) {
        if (stored.content_hash !== hash) {
          throw new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different alert');
        }
        return { status: stored.status, body: JSON.parse(stored.body) as IngestResponse, replayed: true };
      }
      if (stored) db.run('DELETE FROM idempotency WHERE key = ?', idempotencyKey);
    }

    const outcome = applyAlert(ctx, unit, alert, hash);

    if (idempotencyKey !== undefined) {
      db.run(
        'INSERT OR REPLACE INTO idempotency (key, content_hash, status, body, created_at) VALUES (?, ?, ?, ?, ?)',
        idempotencyKey,
        hash,
        outcome.status,
        JSON.stringify(outcome.body),
        now,
      );
    }
    return { ...outcome, replayed: false };
  });
}

function insertAlert(ctx: AppContext, incidentId: number, alert: AlertInput, hash: string, now: number): void {
  ctx.db.run(
    `INSERT INTO alerts (incident_id, source, fingerprint, severity, title, payload, ts, received_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    incidentId,
    alert.source,
    alert.fingerprint,
    alert.severity,
    alert.title,
    JSON.stringify(alert.payload),
    alert.ts,
    now,
    hash,
  );
}

function applyAlert(ctx: AppContext, unit: Unit, alert: AlertInput, hash: string): { status: number; body: IngestResponse } {
  const db = ctx.db;
  const now = unit.now;
  const ts = alert.ts;

  const dup = db.get<{ incident_id: number }>(
    'SELECT incident_id FROM alerts WHERE fingerprint = ? AND content_hash = ? ORDER BY id LIMIT 1',
    alert.fingerprint,
    hash,
  );
  if (dup) {
    const incident = loadIncidentDto(ctx, dup.incident_id);
    if (!incident) throw new Error(`alert points at missing incident ${dup.incident_id}`);
    return { status: 202, body: { action: 'duplicate', incidentId: incident.id, incident } };
  }

  const unresolvedRows = db.all<{ id: number; status: GroupCandidate['status']; last_seen: number; resolved_at: number | null }>(
    `SELECT id, status, last_seen, resolved_at FROM incidents
      WHERE fingerprint = ? AND status IN ('open', 'acked') AND last_seen BETWEEN ? AND ?
      ORDER BY id`,
    alert.fingerprint,
    ts - GROUP_WINDOW_MS,
    ts + GROUP_WINDOW_MS,
  );
  const latestRow = db.get<{ id: number; status: GroupCandidate['status']; last_seen: number; resolved_at: number | null }>(
    `SELECT id, status, last_seen, resolved_at FROM incidents
      WHERE fingerprint = ? AND status = 'resolved'
      ORDER BY resolved_at DESC, id DESC LIMIT 1`,
    alert.fingerprint,
  );
  const decision: GroupDecision = decideGrouping(
    ts,
    unresolvedRows.map((r) => toGroupCandidate(r.id, r.status, r.last_seen, r.resolved_at)),
    latestRow ? toGroupCandidate(latestRow.id, latestRow.status, latestRow.last_seen, latestRow.resolved_at) : null,
  );

  if (decision.kind === 'create') return createIncident(ctx, unit, alert, hash);
  return foldIntoIncident(ctx, unit, decision.kind, decision.incidentId, alert, hash);
}

function createIncident(ctx: AppContext, unit: Unit, alert: AlertInput, hash: string): { status: number; body: IngestResponse } {
  const now = unit.now;
  const slaStart = alert.severity === 'critical' ? now : null;
  const r = ctx.db.run(
    `INSERT INTO incidents (fingerprint, source, title, severity, status, assignee_id, version, rev, alert_count,
                            first_seen, last_seen, sla_started_at, sla_breached_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', NULL, 1, 1, 1, ?, ?, ?, NULL, ?, ?)`,
    alert.fingerprint,
    alert.source,
    alert.title,
    alert.severity,
    alert.ts,
    alert.ts,
    slaStart,
    now,
    now,
  );
  const id = r.lastInsertRowid;
  insertAlert(ctx, id, alert, hash, now);
  const incident = loadIncidentDto(ctx, id);
  if (!incident) throw new Error(`incident ${id} missing after insert`);
  const audit = writeAudit(ctx.db, {
    incidentId: id,
    actor: SYSTEM_INGEST,
    action: 'incident.created',
    before: null,
    after: snapshot(incident),
    now,
  });
  unit.emit('incident.created', { incident, audit: [audit] });
  return { status: 202, body: { action: 'created', incidentId: id, incident } };
}

function foldIntoIncident(
  ctx: AppContext,
  unit: Unit,
  kind: 'fold' | 'reopen' | 'attach',
  id: number,
  alert: AlertInput,
  hash: string,
): { status: number; body: IngestResponse } {
  const db = ctx.db;
  const now = unit.now;
  const row = loadIncidentRow(ctx, id);
  if (!row) throw new Error(`grouping chose missing incident ${id}`);
  const before = loadIncidentDto(ctx, id) as IncidentDTO;

  const newSeverity: Severity = kind === 'attach' ? row.severity : maxSeverity(row.severity, alert.severity);
  const escalated = newSeverity !== row.severity;

  const set: Record<string, string | number | null> = {
    last_seen: Math.max(row.last_seen, alert.ts),
    first_seen: Math.min(row.first_seen, alert.ts),
    alert_count: row.alert_count + 1,
  };
  if (alert.ts >= row.last_seen) {
    set.title = alert.title;
    set.source = alert.source;
  }
  if (escalated) set.severity = newSeverity;

  let bumpVersion = false;
  if (kind === 'reopen') {
    bumpVersion = true;
    const critical = newSeverity === 'critical';
    Object.assign(set, {
      status: 'open',
      resolved_at: null,
      resolved_by: null,
      acked_at: null,
      acked_by: null,
      sla_started_at: critical ? now : null,
      sla_breached_at: null,
    });
  } else if (escalated && newSeverity === 'critical' && row.status === 'open') {
    // Escalation to critical while open starts the SLA clock at server receipt (D6).
    set.sla_started_at = now;
  }

  updateIncidentRow(ctx, id, set, now, bumpVersion);
  insertAlert(ctx, id, alert, hash, now);

  const after = loadIncidentDto(ctx, id) as IncidentDTO;
  const audits: AuditDTO[] = [];
  if (kind === 'reopen') {
    audits.push(
      writeAudit(db, {
        incidentId: id,
        actor: SYSTEM_INGEST,
        action: 'incident.reopened',
        before: snapshot(before),
        after: snapshot(after),
        now,
      }),
    );
  }
  if (kind === 'attach') {
    audits.push(
      writeAudit(db, {
        incidentId: id,
        actor: SYSTEM_INGEST,
        action: 'alert.attached',
        before: snapshot(before),
        after: snapshot(after),
        now,
      }),
    );
  }
  if (escalated) {
    audits.push(
      writeAudit(db, {
        incidentId: id,
        actor: SYSTEM_INGEST,
        action: 'incident.escalated',
        before: snapshot(before),
        after: snapshot(after),
        now,
      }),
    );
  }
  // Routine folds are not audited; the alerts table records them.
  unit.emit('incident.updated', { incident: after, audit: audits });

  const action = kind === 'fold' ? 'folded' : kind === 'reopen' ? 'reopened' : 'attached';
  return { status: 202, body: { action, incidentId: id, incident: after } };
}

