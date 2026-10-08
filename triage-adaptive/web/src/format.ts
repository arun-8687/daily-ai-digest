import type { AuditDTO, IncidentDTO, Severity, Status, UserDTO } from '../../shared/types';

export const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', warning: 'Warning', critical: 'Critical' };
export const STATUS_LABEL: Record<Status, string> = { open: 'Open', acked: 'Acked', resolved: 'Resolved' };

/** Human labels for audit actions. Unknown actions are shown as-is. */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'incident.created': 'Created',
  'incident.acked': 'Acknowledged',
  'incident.resolved': 'Resolved',
  'incident.reopened': 'Reopened',
  'incident.assigned': 'Assigned',
  'incident.escalated': 'Escalated',
  'incident.sla_breached': 'SLA breached',
  'alert.attached': 'Alert attached',
  'user.role_changed': 'Role changed',
  'auth.login': 'Signed in',
};

export function incidentRef(id: number): string {
  return `INC-${id}`;
}

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Relative time: "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 45_000) return 'just now';
  const minutes = Math.floor(d / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "m:ss" for the remaining milliseconds, clamped at "0:00". No "SLA" prefix. */
export function countdown(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** SLA row text: "SLA 4:59", "SLA breached", or null when no SLA applies. */
export function slaLabel(inc: Pick<IncidentDTO, 'slaDueAt' | 'slaBreachedAt'>, now: number): string | null {
  if (inc.slaBreachedAt !== null) return 'SLA breached';
  if (inc.slaDueAt !== null) return `SLA ${countdown(inc.slaDueAt - now)}`;
  return null;
}

export function userName(users: readonly UserDTO[], id: string | null): string {
  if (!id) return 'Unassigned';
  const u = users.find((x) => x.id === id);
  return u ? u.displayName : 'Unknown user';
}

/** Describes the record as it is now, for conflict messages: "now Acked by Bob Okafor". */
export function describeCurrent(inc: IncidentDTO, users: readonly UserDTO[]): string {
  if (inc.status === 'acked') return inc.ackedBy ? `now Acked by ${userName(users, inc.ackedBy)}` : 'now Acked';
  if (inc.status === 'resolved') {
    return inc.resolvedBy ? `now Resolved by ${userName(users, inc.resolvedBy)}` : 'now Resolved';
  }
  return inc.assigneeId ? `now Open, assigned to ${userName(users, inc.assigneeId)}` : 'now Open';
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action;
}

function text(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Summarises what an audit entry changed, for the timeline. Empty string when nothing readable changed. */
export function auditChangeSummary(entry: AuditDTO, users: readonly UserDTO[]): string {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const parts: string[] = [];
  const bs = text(before.status);
  const as = text(after.status);
  if (as && bs !== as) {
    parts.push(`status ${bs ? STATUS_LABEL[bs as Status] ?? bs : 'none'} → ${STATUS_LABEL[as as Status] ?? as}`);
  }
  const bv = text(before.severity);
  const av = text(after.severity);
  if (av && bv !== av) {
    parts.push(`severity ${bv ? SEVERITY_LABEL[bv as Severity] ?? bv : 'none'} → ${SEVERITY_LABEL[av as Severity] ?? av}`);
  }
  if ('assigneeId' in after && (before.assigneeId ?? null) !== (after.assigneeId ?? null)) {
    parts.push(
      `assignee ${userName(users, text(before.assigneeId))} → ${userName(users, text(after.assigneeId))}`,
    );
  }
  const br = text(before.role);
  const ar = text(after.role);
  if (ar && br !== ar) parts.push(`role ${br ?? 'none'} → ${ar}`);
  return parts.join(', ');
}
