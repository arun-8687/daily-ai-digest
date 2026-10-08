// Write actions shared by the drawer, the list, the keyboard and the dialogs. Each goes through store.mutate
// so the row changes at once and rolls back on failure.
import { api, ApiError } from '../api';
import { serverNow } from '../clock';
import { describeFailure, READ_ONLY } from '../messages';
import { incidentRef } from '../format';
import { navigate } from '../router';
import { session } from '../session';
import { store } from '../store';
import { toast } from '../toasts';
import { hasRole, transition, type Action } from '../../../shared/rules';
import type { BulkAckResult, IncidentDTO, Role, UserDTO } from '../../../shared/types';
import { ui, type BulkFailure } from './ui';

function currentUser(): UserDTO | null {
  return session.getState().user;
}

function currentUsers(): UserDTO[] {
  return session.getState().users;
}

/** Whether the role may run this action on this incident right now. */
export function canAct(inc: IncidentDTO, action: Action, role: Role): boolean {
  return hasRole(role, 'responder') && transition(inc.status, action).ok;
}

function report(err: unknown, action: string): void {
  toast('error', describeFailure(err, action, currentUsers()));
}

export function ackIncident(id: number): Promise<void> {
  const user = currentUser();
  if (!store.getEntry(id) || !user) return Promise.resolve();
  return store
    .mutate(
      id,
      { status: 'acked', ackedBy: user.id, ackedAt: serverNow(), slaDueAt: null },
      (version) => api<IncidentDTO>(`/api/incidents/${id}/ack`, { method: 'POST', ifMatch: version }),
    )
    .then(
      () => undefined,
      (err: unknown) => report(err, `acknowledge ${incidentRef(id)}`),
    );
}

/** Resolves with the version the user pinned when the dialog opened. */
export function resolveIncident(id: number, pinnedVersion: number): Promise<void> {
  const user = currentUser();
  if (!store.getEntry(id) || !user) return Promise.resolve();
  return store
    .mutate(
      id,
      { status: 'resolved', resolvedBy: user.id, resolvedAt: serverNow(), slaDueAt: null },
      () => api<IncidentDTO>(`/api/incidents/${id}/resolve`, { method: 'POST', ifMatch: pinnedVersion }),
    )
    .then(
      () => undefined,
      (err: unknown) => report(err, `resolve ${incidentRef(id)}`),
    );
}

export function reopenIncident(id: number): Promise<void> {
  if (!store.getEntry(id)) return Promise.resolve();
  return store
    .mutate(
      id,
      { status: 'open', resolvedBy: null, resolvedAt: null },
      (version) => api<IncidentDTO>(`/api/incidents/${id}/reopen`, { method: 'POST', ifMatch: version }),
    )
    .then(
      () => undefined,
      (err: unknown) => report(err, `reopen ${incidentRef(id)}`),
    );
}

export function assignIncident(id: number, assigneeId: string | null): Promise<void> {
  if (!store.getEntry(id)) return Promise.resolve();
  return store
    .mutate(
      id,
      { assigneeId },
      (version) =>
        api<IncidentDTO>(`/api/incidents/${id}`, { method: 'PATCH', body: { assigneeId }, ifMatch: version }),
    )
    .then(
      () => undefined,
      (err: unknown) => report(err, `change the assignee of ${incidentRef(id)}`),
    );
}

/** Clears every filter and the search draft together. Used by both Clear filters buttons. */
export function clearFilters(): void {
  ui.resetFilterDraft();
  navigate({ status: null, severity: null, assignee: null, q: null }, 'push');
}

/** Opens the resolve dialog and pins the version the user is looking at. */
export function openResolve(id: number): void {
  const entry = store.getEntry(id);
  if (!entry) return;
  ui.openResolve({ id, version: entry.inc.version });
}

/** The wording for one failed bulk item. */
function bulkFailureMessage(r: BulkAckResult): string {
  const action = `acknowledge ${incidentRef(r.id)}`;
  const code = r.error?.code ?? 'failed';
  const message = r.error?.message ?? 'The request failed.';
  // Client-side failures carry status 0 and no network code, so the generic offline wording does not fit them.
  if (r.status === 0 && code !== 'network') return `Couldn't ${action}: ${message}`;
  return describeFailure(new ApiError(r.status, code, message, r.current), action, currentUsers());
}

/**
 * Acks every selected incident. Failed ones stay selected and are listed in the report.
 * Only one bulk ack runs at a time: a second call while one is in flight is refused, because it would
 * re-send ids the first call is already acking and overwrite its report.
 */
export async function bulkAckSelected(): Promise<void> {
  const user = currentUser();
  if (!user) return;
  if (!hasRole(user.role, 'responder')) {
    toast('info', READ_ONLY);
    return;
  }
  if (ui.get().bulkBusy) {
    toast('info', 'A bulk ack is already running.');
    return;
  }
  const ids = [...ui.get().selected];
  if (ids.length === 0) {
    toast('info', 'Nothing is selected. Press x or Ctrl-click a row to select it.');
    return;
  }
  // Set synchronously, before the first await, so a second call cannot slip in between.
  ui.setBulkBusy(true);
  try {
    const loaded = ids.filter((id) => store.getEntry(id) !== undefined);
    const results = loaded.length > 0 ? await store.bulkAck(loaded, { id: user.id, displayName: user.displayName }) : [];
    const byId = new Map(results.map((r) => [r.id, r] as const));
    const failures: BulkFailure[] = [];
    let ok = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) {
        failures.push({ id, message: `Couldn't acknowledge ${incidentRef(id)}: this incident is not loaded.` });
      } else if (r.ok) {
        ok += 1;
      } else {
        failures.push({ id, message: bulkFailureMessage(r) });
      }
    }
    // Keep failures selected and drop only the acked ids, so rows the user toggled while the request ran survive.
    const acked = new Set(ids.filter((id) => !failures.some((f) => f.id === id)));
    ui.setSelected([...ui.get().selected].filter((id) => !acked.has(id)));
    ui.setBulk({ total: ids.length, ok, failures });
  } finally {
    ui.setBulkBusy(false);
  }
}
