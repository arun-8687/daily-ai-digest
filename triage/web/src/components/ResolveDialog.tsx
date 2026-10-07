import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { IncidentDTO, UserDTO } from '../../../shared/types';
import { api } from '../api';
import { describeCurrent, incidentRef } from '../format';
import { store } from '../store';
import { toast } from '../toasts';
import { describeFailure } from '../messages';

interface Props {
  target: { id: number; version: number } | null;
  me: UserDTO;
  users: UserDTO[];
  onDone: () => void;
}

/**
 * Confirmation step for resolving. It pins the version the reviewer saw. If the incident
 * changes while the dialog is open, the list updates live and the server rejects the
 * stale resolve, so the reviewer must look again before confirming.
 */
export function ResolveDialog({ target, me, users, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const entry = useSyncExternalStore(store.subscribe, () => (target ? store.getEntry(target.id) : undefined));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (target && !d.open) d.showModal();
    if (!target && d.open) d.close();
  }, [target]);

  const changed = Boolean(target && entry && entry.inc.version !== target.version);

  async function confirm() {
    if (!target || busy) return;
    const { id, version } = target;
    setBusy(true);
    try {
      await store.mutate(id, { status: 'resolved', resolvedBy: me.id, resolvedAt: Date.now() }, () =>
        api<IncidentDTO>(`/api/incidents/${id}/resolve`, { method: 'POST', ifMatch: version }),
      );
      toast('success', `${incidentRef(id)} resolved.`);
    } catch (err) {
      toast('error', describeFailure(err, `resolve ${incidentRef(id)}`, users));
    } finally {
      setBusy(false);
      ref.current?.close();
    }
  }

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="resolve-title" onClose={onDone}>
      {target && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <h2 id="resolve-title">Resolve {incidentRef(target.id)}?</h2>
          <p>You are resolving the version you reviewed (version {target.version}).</p>
          {changed && entry && (
            <p className="warn" role="status">
              It changed after you opened this: {describeCurrent(entry.inc, users)}. Confirming sends version{' '}
              {target.version}, so the server will reject it. Cancel and reopen to review the latest.
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Resolving…' : 'Resolve incident'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
