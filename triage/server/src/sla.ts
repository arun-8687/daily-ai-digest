import { SLA_CRITICAL_MS } from '../../shared/rules';
import { SYSTEM_SLA, writeAudit } from './audit';
import { transact, type AppContext } from './context';
import { loadIncident, snapshotOf, toIncidentDTO, updateIncident } from './incidents';

const BATCH = 500;
const EVENT_RETENTION = 100_000;
const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

/**
 * Marks critical, unacked incidents whose SLA clock has run out as breached. The state
 * lives in SQLite (sla_started_at, sla_breached_at), not in memory, so a restart simply
 * resumes: the next sweep finds whatever came due while the server was down.
 */
export function sweepSla(ctx: AppContext): number {
  let total = 0;
  for (;;) {
    const n = sweepBatch(ctx);
    total += n;
    if (n < BATCH) return total;
  }
}

function sweepBatch(ctx: AppContext): number {
  const now = ctx.clock.now();
  const due = ctx.db.all<{ id: number }>(
    `SELECT id FROM incidents
     WHERE status = 'open' AND severity = 'critical'
       AND sla_started_at IS NOT NULL AND sla_breached_at IS NULL
       AND sla_started_at + ? <= ?
     ORDER BY sla_started_at, id LIMIT ?`,
    SLA_CRITICAL_MS,
    now,
    BATCH,
  );
  if (due.length === 0) return 0;

  return transact(ctx, (unit) => {
    let breached = 0;
    for (const { id } of due) {
      const row = loadIncident(ctx, id);
      if (!row || row.status !== 'open' || row.sla_breached_at !== null) continue;
      const before = snapshotOf(row);
      // Stamp the deadline, not the sweep time, so a breach that was noticed late still reports when it was due.
      const dueAt = (row.sla_started_at as number) + SLA_CRITICAL_MS;
      const next = updateIncident(ctx, id, { sla_breached_at: dueAt });
      const audit = writeAudit(ctx, {
        incidentId: id,
        actor: SYSTEM_SLA,
        action: 'incident.sla_breached',
        before,
        after: snapshotOf(next),
      });
      unit.emit('incident.sla_breached', { incident: toIncidentDTO(next), audit: [audit] });
      breached++;
    }
    return breached;
  });
}

/** Housekeeping: expired sessions, old idempotency keys, and events older than the replay window. */
export function runMaintenance(ctx: AppContext): void {
  const now = ctx.clock.now();
  ctx.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
  ctx.db.run('DELETE FROM idempotency_keys WHERE created_at < ?', now - IDEMPOTENCY_TTL_MS);
  const head = ctx.db.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events') as { seq: number };
  ctx.db.run('DELETE FROM events WHERE seq <= ?', head.seq - EVENT_RETENTION);
}
