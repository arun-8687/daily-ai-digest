// Pure domain rules shared by the server (enforcement) and the client (UI affordances).
import type { IncidentDTO, Role, Severity, Status } from './types';

export const SLA_CRITICAL_MS = 5 * 60_000;
/** An alert folds into an active incident when its ts is within this distance of the incident's last_seen. */
export const GROUP_WINDOW_MS = 10 * 60_000;
/** An alert within this distance of a resolve reopens that incident instead of starting a new one. */
export const FLAP_WINDOW_MS = 5 * 60_000;
/** Alerts claiming a ts further than this into the future are rejected. */
export const FUTURE_SKEW_MS = 60_000;

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const ROLE_RANK: Record<Role, number> = { viewer: 0, responder: 1, admin: 2 };

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/**
 * Lifecycle: open -> acked -> resolved, reopen resolved -> open.
 * Resolve is also allowed straight from open (auto-recovering alerts need no human ack).
 * Assign is metadata: legal on any non-resolved incident and does not change status.
 */
export type Action = 'ack' | 'resolve' | 'reopen' | 'assign';
export type TransitionResult = { ok: true; to: Status } | { ok: false };

export function transition(from: Status, action: Action): TransitionResult {
  switch (action) {
    case 'ack':
      return from === 'open' ? { ok: true, to: 'acked' } : { ok: false };
    case 'resolve':
      return from === 'open' || from === 'acked' ? { ok: true, to: 'resolved' } : { ok: false };
    case 'reopen':
      return from === 'resolved' ? { ok: true, to: 'open' } : { ok: false };
    case 'assign':
      return from !== 'resolved' ? { ok: true, to: from } : { ok: false };
  }
}

export interface Filters {
  status?: Status;
  severity?: Severity;
  /** A user id, or the literal "none" for unassigned. */
  assignee?: string;
  q?: string;
}

/** Client-side mirror of the server's list filter, used to decide whether a live update belongs in the list. */
export function matchesFilters(incident: IncidentDTO, f: Filters): boolean {
  if (f.status && incident.status !== f.status) return false;
  if (f.severity && incident.severity !== f.severity) return false;
  if (f.assignee === 'none' && incident.assigneeId !== null) return false;
  if (f.assignee && f.assignee !== 'none' && incident.assigneeId !== f.assignee) return false;
  const q = f.q?.trim().toLowerCase();
  if (q && !incident.title.toLowerCase().includes(q)) return false;
  return true;
}
