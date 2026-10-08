// Alert ingestion: validation (D13), content dedupe and idempotency (D2), grouping (D1) and the events they emit.
import { FUTURE_SKEW_MS, maxSeverity, SEVERITY_RANK } from '../../shared/rules';
import { SEVERITIES, type IncidentDTO, type IngestResponse, type Severity } from '../../shared/types';
import { SYSTEM_INGEST } from './audit';
import { transact, type AppContext, type Unit } from './context';
import { decideGrouping, type GroupCandidate } from './grouping';
import {
  emitIncident,
  insertIncidentRow,
  loadIncidentRow,
  saveIncidentRow,
  snapshotOf,
  toIncidentDTO,
  type IncidentRow,
} from './incidents';
import { HttpError } from './errors';
import type { Database } from './db';
import { sha256Hex, stableStringify } from './util';

export interface AlertInput {
  source: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  payload: Record<string, unknown>;
  ts: number;
}

/** Idempotency keys are honoured for 24 hours (D2). */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

interface IdempotencyRow {
  content_hash: string;
  status: number;
  body: string;
  created_at: number;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Validates an ingest body. Every problem is reported together in one 400 validation_failed. */
export function parseAlert(body: Record<string, unknown>, now: number): AlertInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'validation_failed', 'Invalid alert: body must be a JSON object');
  }
  const problems: string[] = [];

  // D13: only the title is trimmed. source and fingerprint are kept as sent, because the fingerprint is the grouping identity.
  const source = typeof body.source === 'string' ? body.source : '';
  if (source.length < 1 || source.length > 64) problems.push('source must be 1-64 characters');

  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
  if (fingerprint.length < 1 || fingerprint.length > 256) problems.push('fingerprint must be 1-256 characters');

  const title = trimmedString(body.title);
  if (title.length < 1 || title.length > 200) problems.push('title must be 1-200 characters');

  const severity = body.severity;
  const severityOk = typeof severity === 'string' && (SEVERITIES as readonly string[]).includes(severity);
  if (!severityOk) problems.push(`severity must be one of ${SEVERITIES.join(', ')}`);

  const ts = parseTs(body.ts);
  if (ts === null) {
    problems.push('ts must be epoch milliseconds or an ISO 8601 string');
  } else if (ts > now + FUTURE_SKEW_MS) {
    problems.push('ts is more than 60 seconds in the future');
  }

  let payload: Record<string, unknown> = {};
  if (body.payload !== undefined) {
    if (typeof body.payload === 'object' && body.payload !== null && !Array.isArray(body.payload)) {
      payload = body.payload as Record<string, unknown>;
    } else {
      problems.push('payload must be an object');
    }
  }

  if (problems.length > 0) {
    throw new HttpError(400, 'validation_failed', `Invalid alert: ${problems.join('; ')}`);
  }
  return {
    source,
    fingerprint,
    severity: severity as Severity,
    title,
    payload,
    ts: ts as number,
  };
}

/** sha256 of the stable JSON of the alert content (D2). */
export function contentHash(alert: AlertInput): string {
  return sha256Hex(
    stableStringify({
      source: alert.source,
      fingerprint: alert.fingerprint,
      severity: alert.severity,
      title: alert.title,
      payload: alert.payload,
      ts: alert.ts,
    }),
  );
}

function toCandidate(r: IncidentRow): GroupCandidate {
  return { id: r.id, status: r.status, lastSeen: r.last_seen, resolvedAt: r.resolved_at };
}

function insertAlert(db: Database, incidentId: number, alert: AlertInput, hash: string, receivedAt: number): void {
  db.run(
    'INSERT INTO alerts (incident_id, source, fingerprint, severity, title, payload, content_hash, ts, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    incidentId,
    alert.source,
    alert.fingerprint,
    alert.severity,
    alert.title,
    JSON.stringify(alert.payload),
    hash,
    alert.ts,
    receivedAt,
  );
}

/** Folds an alert's timing, count and text into an existing incident. Severity is not touched here. */
function absorb(r: IncidentRow, alert: AlertInput, now: number): void {
  if (alert.ts >= r.last_seen) {
    r.title = alert.title;
    r.source = alert.source;
  }
  r.last_seen = Math.max(r.last_seen, alert.ts);
  r.first_seen = Math.min(r.first_seen, alert.ts);
  r.alert_count += 1;
  r.rev += 1;
  r.updated_at = now;
}

/** Starts the SLA clock when a critical incident is open and has no clock running (D6). */
function startSlaIfCriticalOpen(r: IncidentRow, now: number): void {
  if (r.status === 'open' && r.severity === 'critical' && r.sla_started_at === null && r.sla_breached_at === null) {
    r.sla_started_at = now;
  }
}

/** Escalates severity on fold or reopen (never on attach). Returns true when severity went up. */
function escalate(r: IncidentRow, alertSeverity: Severity): boolean {
  const next = maxSeverity(r.severity, alertSeverity);
  if (SEVERITY_RANK[next] === SEVERITY_RANK[r.severity]) return false;
  r.severity = next;
  return true;
}

function ingestInTransaction(
  ctx: AppContext,
  unit: Unit,
  alert: AlertInput,
  hash: string,
  now: number,
): IngestResponse {
  const db = ctx.db;

  // Content dedupe (D2): an identical alert for the same fingerprint changes nothing.
  const duplicate = db.get<{ incident_id: number }>(
    'SELECT incident_id FROM alerts WHERE fingerprint = ? AND content_hash = ?',
    alert.fingerprint,
    hash,
  );
  if (duplicate) {
    const row = loadIncidentRow(db, duplicate.incident_id);
    if (!row) throw new Error(`alert points at missing incident ${duplicate.incident_id}`);
    return { action: 'duplicate', incidentId: row.id, incident: toIncidentDTO(row) };
  }

  const unresolved = db
    .all<IncidentRow>("SELECT * FROM incidents WHERE fingerprint = ? AND status IN ('open', 'acked')", alert.fingerprint)
    .map(toCandidate);
  const latestResolvedRow = db.get<IncidentRow>(
    "SELECT * FROM incidents WHERE fingerprint = ? AND status = 'resolved' ORDER BY resolved_at DESC, id DESC LIMIT 1",
    alert.fingerprint,
  );
  const decision = decideGrouping(alert.ts, unresolved, latestResolvedRow ? toCandidate(latestResolvedRow) : null);

  if (decision.kind === 'create') {
    const critical = alert.severity === 'critical';
    const id = insertIncidentRow(db, {
      fingerprint: alert.fingerprint,
      source: alert.source,
      title: alert.title,
      severity: alert.severity,
      status: 'open',
      assignee_id: null,
      version: 1,
      rev: 1,
      alert_count: 1,
      first_seen: alert.ts,
      last_seen: alert.ts,
      acked_at: null,
      acked_by: null,
      resolved_at: null,
      resolved_by: null,
      sla_started_at: critical ? now : null,
      sla_breached_at: null,
      created_at: now,
      updated_at: now,
    });
    insertAlert(db, id, alert, hash, now);
    const created = loadIncidentRow(db, id);
    if (!created) throw new Error('inserted incident not found');
    unit.audit({
      incidentId: id,
      actor: SYSTEM_INGEST,
      action: 'incident.created',
      before: null,
      after: snapshotOf(created),
    });
    const incident = emitIncident(ctx, unit, 'incident.created', id);
    return { action: 'created', incidentId: id, incident };
  }

  const row = loadIncidentRow(db, decision.incidentId);
  if (!row) throw new Error(`grouping chose missing incident ${decision.incidentId}`);
  const before = snapshotOf(row);
  insertAlert(db, row.id, alert, hash, now);

  if (decision.kind === 'fold') {
    absorb(row, alert, now);
    const escalated = escalate(row, alert.severity);
    startSlaIfCriticalOpen(row, now);
    saveIncidentRow(db, row);
    if (escalated) {
      unit.audit({
        incidentId: row.id,
        actor: SYSTEM_INGEST,
        action: 'incident.escalated',
        before,
        after: snapshotOf(row),
      });
    }
    const incident: IncidentDTO = emitIncident(ctx, unit, 'incident.updated', row.id);
    return { action: 'folded', incidentId: row.id, incident };
  }

  if (decision.kind === 'reopen') {
    absorb(row, alert, now);
    row.status = 'open';
    row.version += 1;
    row.acked_at = null;
    row.acked_by = null;
    row.resolved_at = null;
    row.resolved_by = null;
    row.sla_breached_at = null;
    row.sla_started_at = null;
    const escalated = escalate(row, alert.severity);
    startSlaIfCriticalOpen(row, now);
    saveIncidentRow(db, row);
    unit.audit({
      incidentId: row.id,
      actor: SYSTEM_INGEST,
      action: 'incident.reopened',
      before,
      after: snapshotOf(row),
    });
    if (escalated) {
      unit.audit({
        incidentId: row.id,
        actor: SYSTEM_INGEST,
        action: 'incident.escalated',
        before,
        after: snapshotOf(row),
      });
    }
    const incident = emitIncident(ctx, unit, 'incident.updated', row.id);
    return { action: 'reopened', incidentId: row.id, incident };
  }

  // attach: a late alert for a resolved incident. Status and severity do not change.
  absorb(row, alert, now);
  saveIncidentRow(db, row);
  unit.audit({
    incidentId: row.id,
    actor: SYSTEM_INGEST,
    action: 'alert.attached',
    before,
    after: snapshotOf(row),
  });
  const incident = emitIncident(ctx, unit, 'incident.updated', row.id);
  return { action: 'attached', incidentId: row.id, incident };
}

interface IngestOutcome {
  status: number;
  body: IngestResponse;
  replayed: boolean;
}

/**
 * Ingests one alert in a single transaction. Order: idempotency key (D2), then content dedupe, then grouping.
 * The stored response for a key is written in the same transaction as the effects.
 */
export function ingestAlert(ctx: AppContext, alert: AlertInput, idempotencyKey?: string): IngestOutcome {
  if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 255)) {
    throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 1-255 characters');
  }
  const hash = contentHash(alert);

  return transact(ctx, (unit): IngestOutcome => {
    const now = ctx.clock.now();

    if (idempotencyKey !== undefined) {
      const prior = ctx.db.get<IdempotencyRow>(
        'SELECT content_hash, status, body, created_at FROM idempotency_keys WHERE key = ?',
        idempotencyKey,
      );
      if (prior && prior.created_at > now - IDEMPOTENCY_TTL_MS) {
        if (prior.content_hash !== hash) {
          throw new HttpError(422, 'idempotency_key_reused', 'Idempotency-Key was already used for a different alert');
        }
        return {
          status: prior.status,
          body: JSON.parse(prior.body) as IngestResponse,
          replayed: true,
        };
      }
    }

    const body = ingestInTransaction(ctx, unit, alert, hash, now);
    const status = 202;

    if (idempotencyKey !== undefined) {
      ctx.db.run(
        'INSERT OR REPLACE INTO idempotency_keys (key, content_hash, status, body, created_at) VALUES (?, ?, ?, ?, ?)',
        idempotencyKey,
        hash,
        status,
        JSON.stringify(body),
        now,
      );
    }
    return { status, body, replayed: false };
  });
}
