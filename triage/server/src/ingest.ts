import { FUTURE_SKEW_MS, maxSeverity } from '../../shared/rules';
import { SEVERITIES, type AuditDTO, type IngestResponse, type Severity } from '../../shared/types';
import { writeAudit, SYSTEM_INGEST } from './audit';
import { transact, type AppContext, type Unit } from './context';
import { HttpError } from './errors';
import { decideGrouping, type GroupCandidate } from './grouping';
import { loadIncident, snapshotOf, toIncidentDTO, updateIncident, type Changes, type IncidentRow } from './incidents';
import { isPlainObject, parseTimestamp, sha256, stableStringify } from './util';

export interface AlertInput {
  source: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  payload: Record<string, unknown>;
  /** Event time in epoch ms, as claimed by the source. */
  ts: number;
}

/** Validates a raw POST /ingest body. Collects every problem so the client can fix them all at once. */
export function parseAlert(body: Record<string, unknown>, now: number): AlertInput {
  const problems: string[] = [];
  const text = (field: string, min: number, max: number): string => {
    const v = body[field];
    if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
      problems.push(`${field} must be a string of ${min}-${max} characters`);
      return '';
    }
    return v.trim();
  };
  const source = text('source', 1, 64);
  const fingerprint = text('fingerprint', 1, 256);
  const title = text('title', 1, 200);

  let severity: Severity = 'info';
  if (typeof body.severity === 'string' && (SEVERITIES as readonly string[]).includes(body.severity)) {
    severity = body.severity as Severity;
  } else {
    problems.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  }

  let ts = 0;
  const parsed = parseTimestamp(body.ts);
  if (parsed === null) {
    problems.push('ts must be epoch milliseconds or an ISO-8601 string');
  } else if (parsed > now + FUTURE_SKEW_MS) {
    problems.push('ts is more than 60s ahead of server time');
  } else {
    ts = parsed;
  }

  let payload: Record<string, unknown> = {};
  if (body.payload !== undefined) {
    if (isPlainObject(body.payload)) payload = body.payload;
    else problems.push('payload must be a JSON object');
  }

  if (problems.length > 0) {
    throw new HttpError(400, 'validation_failed', problems.join('; '), undefined, { problems });
  }
  return { source, fingerprint, severity, title, payload, ts };
}

interface ProcessResult {
  response: IngestResponse;
}

function toCandidate(r: IncidentRow): GroupCandidate {
  return { id: r.id, status: r.status, lastSeen: r.last_seen, resolvedAt: r.resolved_at };
}

function insertAlert(ctx: AppContext, incidentId: number, a: AlertInput, contentHash: string): void {
  ctx.db.run(
    `INSERT INTO alerts (incident_id, fingerprint, source, severity, title, payload, ts, received_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    incidentId,
    a.fingerprint,
    a.source,
    a.severity,
    a.title,
    JSON.stringify(a.payload),
    a.ts,
    ctx.clock.now(),
    contentHash,
  );
}

function createIncident(ctx: AppContext, unit: Unit, a: AlertInput, contentHash: string): ProcessResult {
  const now = ctx.clock.now();
  const { lastInsertRowid: id } = ctx.db.run(
    `INSERT INTO incidents (fingerprint, source, title, severity, status, assignee_id, version, alert_count,
       first_seen, last_seen, acked_at, acked_by, resolved_at, resolved_by, sla_started_at, sla_breached_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', NULL, 1, 1, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    a.fingerprint,
    a.source,
    a.title,
    a.severity,
    a.ts,
    a.ts,
    // The SLA clock starts when we received the alert, not when the source says it happened.
    a.severity === 'critical' ? now : null,
    now,
    now,
  );
  insertAlert(ctx, id, a, contentHash);
  const row = loadIncident(ctx, id) as IncidentRow;
  const audit = writeAudit(ctx, {
    incidentId: id,
    actor: SYSTEM_INGEST,
    action: 'incident.created',
    before: null,
    after: snapshotOf(row),
  });
  unit.emit('incident.created', { incident: toIncidentDTO(row), audit: [audit] });
  return { response: { action: 'created', incidentId: id, incident: toIncidentDTO(row) } };
}

type ApplyMode = 'fold' | 'reopen' | 'attach';

/**
 * Applies an alert to an existing incident in one place. Fold, reopen and attach differ
 * only in whether status changes. last_seen is only ever moved forward (max).
 */
function applyToIncident(ctx: AppContext, unit: Unit, row: IncidentRow, a: AlertInput, contentHash: string, mode: ApplyMode): ProcessResult {
  const now = ctx.clock.now();
  const before = snapshotOf(row);
  const reopen = mode === 'reopen';
  const attach = mode === 'attach';

  const severity = attach ? row.severity : maxSeverity(row.severity, a.severity);
  const escalated = severity !== row.severity;
  const status: Changes['status'] = reopen ? 'open' : row.status;
  const isLatest = a.ts >= row.last_seen;

  let slaStarted = row.sla_started_at;
  if (reopen) {
    slaStarted = severity === 'critical' ? now : null;
  } else if (status === 'open' && severity === 'critical' && slaStarted === null) {
    // Escalation to critical starts the clock for an unacked incident.
    slaStarted = now;
  }

  const changes: Changes = {
    severity,
    status,
    alert_count: row.alert_count + 1,
    first_seen: Math.min(row.first_seen, a.ts),
    last_seen: Math.max(row.last_seen, a.ts),
    sla_started_at: slaStarted,
  };
  if (isLatest) {
    changes.title = a.title;
    changes.source = a.source;
  }
  if (reopen) {
    Object.assign(changes, {
      acked_at: null,
      acked_by: null,
      resolved_at: null,
      resolved_by: null,
      sla_breached_at: null,
    });
  }

  insertAlert(ctx, row.id, a, contentHash);
  const next = updateIncident(ctx, row.id, changes);

  const audits: AuditDTO[] = [];
  const record = (action: string) =>
    audits.push(writeAudit(ctx, { incidentId: row.id, actor: SYSTEM_INGEST, action, before, after: snapshotOf(next) }));
  if (reopen) record('incident.reopened');
  if (attach) record('alert.attached');
  if (escalated && !reopen) record('incident.escalated');

  unit.emit('incident.updated', { incident: toIncidentDTO(next), audit: audits });
  const action = reopen ? 'reopened' : attach ? 'attached' : 'folded';
  return { response: { action, incidentId: row.id, incident: toIncidentDTO(next) } };
}

function processAlert(ctx: AppContext, unit: Unit, a: AlertInput, contentHash: string): ProcessResult {
  // The same alert (same fingerprint, same content) is a duplicate even without an Idempotency-Key.
  const dup = ctx.db.get<{ incident_id: number }>(
    'SELECT incident_id FROM alerts WHERE fingerprint = ? AND content_hash = ?',
    a.fingerprint,
    contentHash,
  );
  if (dup) {
    const row = loadIncident(ctx, dup.incident_id) as IncidentRow;
    return { response: { action: 'duplicate', incidentId: row.id, incident: toIncidentDTO(row) } };
  }

  const unresolved = ctx.db.all<IncidentRow>(
    "SELECT * FROM incidents WHERE fingerprint = ? AND status != 'resolved' ORDER BY id",
    a.fingerprint,
  );
  const latestResolved = ctx.db.get<IncidentRow>(
    "SELECT * FROM incidents WHERE fingerprint = ? AND status = 'resolved' ORDER BY resolved_at DESC, id DESC LIMIT 1",
    a.fingerprint,
  );

  const decision = decideGrouping(
    a.ts,
    unresolved.map(toCandidate),
    latestResolved ? toCandidate(latestResolved) : null,
  );

  switch (decision.kind) {
    case 'create':
      return createIncident(ctx, unit, a, contentHash);
    case 'fold':
      return applyToIncident(ctx, unit, unresolved.find((r) => r.id === decision.incidentId) as IncidentRow, a, contentHash, 'fold');
    case 'reopen':
      return applyToIncident(ctx, unit, latestResolved as IncidentRow, a, contentHash, 'reopen');
    case 'attach':
      return applyToIncident(ctx, unit, latestResolved as IncidentRow, a, contentHash, 'attach');
  }
}

/**
 * Ingests one alert. With an Idempotency-Key, the first response is stored in the same
 * transaction as the effects. A retry with the same key and body replays it. The same
 * key with a different body is rejected with 422.
 */
export function ingestAlert(
  ctx: AppContext,
  alert: AlertInput,
  idempotencyKey?: string,
): { status: number; body: IngestResponse; replayed: boolean } {
  const contentHash = sha256(stableStringify(alert));
  return transact(ctx, (unit) => {
    if (idempotencyKey !== undefined) {
      const prior = ctx.db.get<{ request_hash: string; status: number; response: string }>(
        'SELECT request_hash, status, response FROM idempotency_keys WHERE key = ?',
        idempotencyKey,
      );
      if (prior) {
        if (prior.request_hash !== contentHash) {
          throw new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request body');
        }
        return { status: prior.status, body: JSON.parse(prior.response) as IngestResponse, replayed: true };
      }
    }

    const { response } = processAlert(ctx, unit, alert, contentHash);
    if (idempotencyKey !== undefined) {
      ctx.db.run(
        'INSERT INTO idempotency_keys (key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?)',
        idempotencyKey,
        contentHash,
        202,
        JSON.stringify(response),
        ctx.clock.now(),
      );
    }
    return { status: 202, body: response, replayed: false };
  });
}
