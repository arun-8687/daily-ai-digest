// Display helpers. Pure functions, no DOM access.
import type { IncidentDTO, Severity, Status, UserDTO } from '../../shared/types';

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

export const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  acked: 'Acked',
  resolved: 'Resolved',
};

export function incidentRef(id: number): string {
  return `INC-${id}`;
}

/** Local wall-clock time, HH:MM:SS. */
export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Relative time such as "just now", "42s ago", "7m ago", "3h ago", "2d ago". */
export function ago(ms: number, now: number): string {
  const diff = now - ms;
  if (!Number.isFinite(diff) || diff < 5_000) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Remaining time as m:ss, rounded up so it reaches 0:00 only when due.
 * Returns only the clock part. The caller adds the "SLA " prefix, as in "SLA 4:59".
 */
export function countdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function userName(users: readonly UserDTO[], id: string | null): string {
  if (id === null) return 'Unassigned';
  return users.find((u) => u.id === id)?.displayName ?? 'Unknown user';
}

/** Current state in words, e.g. "now Acked by Bob Okafor". */
export function describeCurrent(inc: IncidentDTO, users: readonly UserDTO[]): string {
  switch (inc.status) {
    case 'open':
      return 'now Open';
    case 'acked':
      return inc.ackedBy ? `now Acked by ${userName(users, inc.ackedBy)}` : 'now Acked';
    case 'resolved':
      return inc.resolvedBy ? `now Resolved by ${userName(users, inc.resolvedBy)}` : 'now Resolved';
  }
}
