// D1 grouping. Pure: no I/O, no clock. The caller loads the candidates inside the transaction.
import { FLAP_WINDOW_MS, GROUP_WINDOW_MS } from '../../shared/rules';
import type { Status } from '../../shared/types';

export interface GroupCandidate {
  id: number;
  status: Status;
  lastSeen: number;
  resolvedAt: number | null;
}

export type GroupDecision = { kind: 'fold' | 'reopen' | 'attach'; incidentId: number } | { kind: 'create' };

/**
 * Decides where an alert with event time `ts` goes.
 *
 * @param unresolved every open or acked incident with the same fingerprint
 * @param latestResolved the most recently resolved incident with the same fingerprint (max resolved_at, tie max id)
 */
export function decideGrouping(
  ts: number,
  unresolved: GroupCandidate[],
  latestResolved: GroupCandidate | null,
): GroupDecision {
  // 1. Fold into an unresolved incident within the group window; the newest last_seen wins, then the highest id.
  let best: GroupCandidate | null = null;
  for (const candidate of unresolved) {
    if (candidate.status === 'resolved') continue;
    if (Math.abs(ts - candidate.lastSeen) > GROUP_WINDOW_MS) continue;
    if (
      best === null ||
      candidate.lastSeen > best.lastSeen ||
      (candidate.lastSeen === best.lastSeen && candidate.id > best.id)
    ) {
      best = candidate;
    }
  }
  if (best !== null) {
    return { kind: 'fold', incidentId: best.id };
  }

  if (latestResolved !== null && latestResolved.resolvedAt !== null) {
    const resolvedAt = latestResolved.resolvedAt;

    // 2. Flap: an alert close to the resolution reopens the incident.
    if (Math.abs(ts - resolvedAt) <= FLAP_WINDOW_MS) {
      return { kind: 'reopen', incidentId: latestResolved.id };
    }

    // 3. Late alert for a resolved incident: attach without changing status.
    if (ts < resolvedAt - FLAP_WINDOW_MS && Math.abs(ts - latestResolved.lastSeen) <= GROUP_WINDOW_MS) {
      return { kind: 'attach', incidentId: latestResolved.id };
    }
  }

  // 4. Otherwise a new incident.
  return { kind: 'create' };
}
