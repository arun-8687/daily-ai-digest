import { FLAP_WINDOW_MS, GROUP_WINDOW_MS } from '../../shared/rules';
import { type Status } from '../../shared/types';

/** The fields of an incident that grouping needs. */
export interface GroupCandidate {
  id: number;
  status: Status;
  lastSeen: number;
  resolvedAt: number | null;
}

export type GroupDecision =
  | { kind: 'fold' | 'reopen' | 'attach'; incidentId: number }
  | { kind: 'create' };

/**
 * D1 grouping, a pure function of the alert's event time and the candidate incidents.
 *
 * 1. Fold into the unresolved (open or acked) incident with the same fingerprint where
 *    |ts - last_seen| <= GROUP_WINDOW_MS. Ties on last_seen go to the larger id.
 * 2. Else, if the most recently resolved incident has |ts - resolved_at| <= FLAP_WINDOW_MS, reopen it.
 * 3. Else, if ts < resolved_at - FLAP_WINDOW_MS and |ts - last_seen| <= GROUP_WINDOW_MS, attach to it
 *    (status unchanged).
 * 4. Else create.
 *
 * Both window boundaries are inclusive. The caller must pass unresolved candidates
 * (any resolved entries are ignored) and the single most recently resolved incident with this fingerprint.
 */
export function decideGrouping(
  ts: number,
  unresolved: GroupCandidate[],
  latestResolved: GroupCandidate | null,
): GroupDecision {
  let best: GroupCandidate | null = null;
  for (const c of unresolved) {
    if (c.status === 'resolved') continue;
    if (Math.abs(ts - c.lastSeen) > GROUP_WINDOW_MS) continue;
    if (best === null || c.lastSeen > best.lastSeen || (c.lastSeen === best.lastSeen && c.id > best.id)) {
      best = c;
    }
  }
  if (best !== null) return { kind: 'fold', incidentId: best.id };

  if (latestResolved === null || latestResolved.resolvedAt === null) return { kind: 'create' };
  const resolvedAt = latestResolved.resolvedAt;

  if (Math.abs(ts - resolvedAt) <= FLAP_WINDOW_MS) {
    return { kind: 'reopen', incidentId: latestResolved.id };
  }
  if (ts < resolvedAt - FLAP_WINDOW_MS && Math.abs(ts - latestResolved.lastSeen) <= GROUP_WINDOW_MS) {
    return { kind: 'attach', incidentId: latestResolved.id };
  }
  return { kind: 'create' };
}
