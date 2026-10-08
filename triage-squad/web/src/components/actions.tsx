// Incident writes. Each one goes through store.mutate, so the change shows at once and rolls back on failure.
// A failure becomes one error toast. Every helper resolves to true only when the server accepted the change.
import type { IncidentDTO, UserDTO } from '../../../shared/types';
import { api } from '../api';
import { serverNow } from '../clock';
import { incidentRef } from '../format';
import { describeFailure } from '../messages';
import { store } from '../store';
import { toast } from '../toasts';

async function run(action: string, work: () => Promise<unknown>, users: readonly UserDTO[]): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (err) {
    toast('error', describeFailure(err, action, users));
    return false;
  }
}

export function ackIncident(id: number, user: UserDTO, users: readonly UserDTO[]): Promise<boolean> {
  return run(
    `acknowledge ${incidentRef(id)}`,
    () =>
      store.mutate(
        id,
        { status: 'acked', ackedBy: user.id, ackedAt: Math.round(serverNow()), slaDueAt: null },
        (version) => api<IncidentDTO>(`/api/incidents/${id}/ack`, { method: 'POST', ifMatch: version }),
      ),
    users,
  );
}

/** The version is pinned when the confirmation dialog opens, so it is sent here instead of the live version. */
export function resolveIncident(
  id: number,
  pinnedVersion: number,
  user: UserDTO,
  users: readonly UserDTO[],
): Promise<boolean> {
  return run(
    `resolve ${incidentRef(id)}`,
    () =>
      store.mutate(
        id,
        { status: 'resolved', resolvedBy: user.id, resolvedAt: Math.round(serverNow()), slaDueAt: null },
        () => api<IncidentDTO>(`/api/incidents/${id}/resolve`, { method: 'POST', ifMatch: pinnedVersion }),
      ),
    users,
  );
}

export function reopenIncident(id: number, users: readonly UserDTO[]): Promise<boolean> {
  return run(
    `reopen ${incidentRef(id)}`,
    () =>
      store.mutate(id, { status: 'open', resolvedAt: null, resolvedBy: null }, (version) =>
        api<IncidentDTO>(`/api/incidents/${id}/reopen`, { method: 'POST', ifMatch: version }),
      ),
    users,
  );
}

export function assignIncident(id: number, assigneeId: string | null, users: readonly UserDTO[]): Promise<boolean> {
  return run(
    `assign ${incidentRef(id)}`,
    () =>
      store.mutate(id, { assigneeId }, (version) =>
        api<IncidentDTO>(`/api/incidents/${id}`, { method: 'PATCH', body: { assigneeId }, ifMatch: version }),
      ),
    users,
  );
}
