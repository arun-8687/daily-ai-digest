import { SLA_CRITICAL_MS } from '../../shared/rules';
import { type IncidentDTO } from '../../shared/types';
import { SYSTEM_SLA, snapshot, writeAudit } from './audit';
import { type AppContext, transact } from './context';
import { loadIncidentDto, type IncidentRow, INCIDENT_COLUMNS, toIncidentDto, updateIncidentRow } from './incidents';

export const SLA_BATCH_SIZE = 500;
export const EVENT_RETENTION = 100_000;

const DUE_WHERE = `status = 'open' AND severity = 'critical' AND sla_started_at IS NOT NULL
  AND sla_breached_at IS NULL AND sla_started_at <= ?`;

/**
 * D6 SLA sweep. A critical incident that is still open 5 minutes after its SLA start is breached.
 * sla_breached_at is stamped at the deadline (sla_started_at + SLA_CRITICAL_MS), not the sweep time.
 * Each breach bumps rev only, writes audit incident.sla_breached (SYSTEM_SLA), and emits
 * incident.sla_breached. Batches of 500, each in its own transaction, until none are due.
 * Returns the number of breaches applied.
 */
export function sweepSla(ctx: AppContext): number {
  let total = 0;
  for (;;) {
    const cutoff = ctx.clock.now() - SLA_CRITICAL_MS;
    const due = ctx.db.get<{ id: number }>(`SELECT id FROM incidents WHERE ${DUE_WHERE} LIMIT 1`, cutoff);
    if (!due) break;

    const applied = transact(ctx, (unit) => {
      const rows = ctx.db.all<IncidentRow>(
        `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE ${DUE_WHERE} ORDER BY sla_started_at, id LIMIT ?`,
        cutoff,
        SLA_BATCH_SIZE,
      );
      for (const row of rows) {
        const deadline = row.sla_started_at! + SLA_CRITICAL_MS;
        const before: IncidentDTO = toIncidentDto(row);
        updateIncidentRow(ctx, row.id, { sla_breached_at: deadline }, unit.now, false);
        const incident = loadIncidentDto(ctx, row.id);
        if (!incident) throw new Error(`incident ${row.id} vanished during SLA sweep`);
        const audit = writeAudit(ctx.db, {
          incidentId: row.id,
          actor: SYSTEM_SLA,
          action: 'incident.sla_breached',
          before: snapshot(before),
          after: snapshot(incident),
          now: unit.now,
        });
        unit.emit('incident.sla_breached', { incident, audit: [audit] });
      }
      return rows.length;
    });

    total += applied;
    if (applied < SLA_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Housekeeping: deletes expired sessions, idempotency rows older than 24h, and events beyond the
 * newest EVENT_RETENTION. audit_log is never touched.
 */
export function runMaintenance(ctx: AppContext): void {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    ctx.db.run('DELETE FROM idempotency WHERE created_at < ?', now - 24 * 3_600_000);
    const cutoff = ctx.db.get<{ seq: number }>(
      'SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?',
      EVENT_RETENTION - 1,
    );
    if (cutoff) ctx.db.run('DELETE FROM events WHERE seq < ?', cutoff.seq);
  });
}
