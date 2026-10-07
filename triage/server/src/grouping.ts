// Pure grouping decision. No I/O, so the rules can be unit-tested exhaustively.
import { FLAP_WINDOW_MS, GROUP_WINDOW_MS } from '../../shared/rules';
import type { Status } from '../../shared/types';

export interface GroupCandidate {
  id: number;
  status: Status;
  lastSeen: number;
  resolvedAt: number | null;
}

export type GroupDecision =
  | { kind: 'fold'; incidentId: number }
  | { kind: 'reopen'; incidentId: number }
  | { kind: 'attach'; incidentId: number }
  | { kind: 'create' };

/**
 * Decides where an alert with event time `ts` belongs.
 *
 * 1. Fold into an unresolved incident (open or acked) for the same fingerprint whose
 *    last_seen is within GROUP_WINDOW_MS of `ts`. Distance is symmetric, so late
 *    alerts (ts < last_seen) fold too. If several match, the most recent one wins.
 * 2. Otherwise, if the latest resolved incident was resolved within FLAP_WINDOW_MS of
 *    `ts` (before or after), reopen it.
 * 3. Otherwise, if `ts` is a late alert that belongs to an earlier, already-resolved
 *    episode (more than FLAP_WINDOW_MS before the resolve, within GROUP_WINDOW_MS of
 *    its last_seen), attach it there without changing state.
 * 4. Otherwise create a new incident. A later alert always starts a new one.
 */
export function decideGrouping(
  ts: number,
  unresolved: GroupCandidate[],
  latestResolved: GroupCandidate | null,
): GroupDecision {
  let best: GroupCandidate | null = null;
  for (const c of unresolved) {
    if (Math.abs(ts - c.lastSeen) > GROUP_WINDOW_MS) continue;
    if (best === null || c.lastSeen > best.lastSeen || (c.lastSeen === best.lastSeen && c.id > best.id)) {
      best = c;
    }
  }
  if (best !== null) return { kind: 'fold', incidentId: best.id };

  if (latestResolved !== null && latestResolved.resolvedAt !== null) {
    const resolvedAt = latestResolved.resolvedAt;
    if (Math.abs(ts - resolvedAt) <= FLAP_WINDOW_MS) {
      return { kind: 'reopen', incidentId: latestResolved.id };
    }
    if (ts < resolvedAt - FLAP_WINDOW_MS && Math.abs(ts - latestResolved.lastSeen) <= GROUP_WINDOW_MS) {
      return { kind: 'attach', incidentId: latestResolved.id };
    }
  }
  return { kind: 'create' };
}
