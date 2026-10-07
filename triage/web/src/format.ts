import type { Severity, Status, UserDTO } from '../../shared/types';

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };
export const STATUS_LABEL: Record<Status, string> = { open: 'Open', acked: 'Acked', resolved: 'Resolved' };

export function incidentRef(id: number): string {
  return `INC-${id}`;
}

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** m:ss, or h:mm:ss past an hour. Negative remaining time is clamped to zero. */
export function countdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function userName(users: readonly UserDTO[], id: string | null): string {
  if (!id) return 'Unassigned';
  if (id.startsWith('system:')) return 'System';
  return users.find((u) => u.id === id)?.displayName ?? id;
}

export function describeChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before || !after) return 'created';
  const parts: string[] = [];
  if (before.status !== after.status) parts.push(`${String(before.status)} → ${String(after.status)}`);
  if (before.severity !== after.severity) parts.push(`severity ${String(before.severity)} → ${String(after.severity)}`);
  if (before.assigneeId !== after.assigneeId) parts.push('assignee changed');
  if (before.slaBreachedAt === null && after.slaBreachedAt !== null) parts.push('SLA breached');
  return parts.length > 0 ? parts.join(', ') : `version ${String(after.version)}`;
}

/** What the server holds now, phrased for a person: "now Acked by Bob Okafor (v2)". */
export function describeCurrent(inc: { status: Status; version: number; ackedBy: string | null; resolvedBy: string | null }, users: readonly UserDTO[]): string {
  const who = inc.status === 'resolved' ? inc.resolvedBy : inc.status === 'acked' ? inc.ackedBy : null;
  const by = who ? ` by ${userName(users, who)}` : '';
  return `now ${STATUS_LABEL[inc.status]}${by}, version ${inc.version}`;
}
