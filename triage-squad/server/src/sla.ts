// SLA breach sweep (D6) and periodic maintenance (D8 retention, D2 key expiry, D9 session expiry).
import { SLA_CRITICAL_MS } from '../../shared/rules';
import { SYSTEM_SLA } from './audit';
import { transact, type AppContext } from './context';
import { emitIncident, loadIncidentRow, saveIncidentRow, snapshotOf } from './incidents';
import { IDEMPOTENCY_TTL_MS } from './ingest';

const SWEEP_BATCH = 500;
const EVENT_RETENTION = 100_000;

/** Stamps one breach at its deadline. Returns false if the incident no longer qualifies. */
function breachIncident(ctx: AppContext, id: number): boolean {
  return transact(ctx, (unit) => {
    const now = ctx.clock.now();
    const row = loadIncidentRow(ctx.db, id);
    if (!row || row.status !== 'open' || row.sla_breached_at !== null || row.sla_started_at === null) {
      return false;
    }
    const deadline = row.sla_started_at + SLA_CRITICAL_MS;
    if (deadline > now) {
      return false;
    }

    const before = snapshotOf(row);
    row.sla_breached_at = deadline;
    row.rev += 1;
    row.updated_at = now;
    saveIncidentRow(ctx.db, row);
    unit.audit({
      incidentId: id,
      actor: SYSTEM_SLA,
      action: 'incident.sla_breached',
      before,
      after: snapshotOf(row),
    });
    emitIncident(ctx, unit, 'incident.sla_breached', id);
    return true;
  });
}

/** Applies every breach that is due. Loops in batches of 500 until none remain. Returns the number applied. */
export function sweepSla(ctx: AppContext): number {
  let applied = 0;
  for (;;) {
    const due = ctx.db.all<{ id: number }>(
      `SELECT id FROM incidents
        WHERE status = 'open' AND sla_breached_at IS NULL AND sla_started_at IS NOT NULL
          AND sla_started_at + ? <= ?
        ORDER BY id
        LIMIT ?`,
      SLA_CRITICAL_MS,
      ctx.clock.now(),
      SWEEP_BATCH,
    );
    if (due.length === 0) return applied;

    let batchApplied = 0;
    for (const { id } of due) {
      if (breachIncident(ctx, id)) batchApplied += 1;
    }
    applied += batchApplied;
    if (batchApplied === 0) return applied;
  }
}

/** Expired sessions, idempotency keys older than 24h, and events beyond the newest 100,000. */
export function runMaintenance(ctx: AppContext): void {
  transact(ctx, () => {
    const now = ctx.clock.now();
    ctx.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    ctx.db.run('DELETE FROM idempotency_keys WHERE created_at < ?', now - IDEMPOTENCY_TTL_MS);
    ctx.db.run(
      'DELETE FROM events WHERE seq < (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)',
      EVENT_RETENTION - 1,
    );
  });
}
