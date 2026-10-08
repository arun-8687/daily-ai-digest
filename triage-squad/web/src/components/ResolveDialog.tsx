// Resolve confirmation. The version is pinned when the dialog opens and that pinned version is what gets sent.
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { UserDTO } from '../../../shared/types';
import { describeCurrent, incidentRef } from '../format';
import { store } from '../store';
import { ModalDialog } from './Dialogs';
import { resolveIncident } from './actions';

export interface ResolveTarget {
  id: number;
  /** Version at the moment the dialog opened. */
  version: number;
}

export function ResolveDialog({
  target,
  user,
  users,
  onClose,
}: {
  target: ResolveTarget | null;
  user: UserDTO;
  users: readonly UserDTO[];
  onClose: () => void;
}) {
  const targetId = target?.id ?? null;
  const getEntry = useCallback(() => (targetId === null ? undefined : store.getEntry(targetId)), [targetId]);
  const entry = useSyncExternalStore(store.subscribe, getEntry, getEntry);
  const [busy, setBusy] = useState(false);

  const live = entry?.inc;
  const moved = target !== null && live !== undefined && live.version !== target.version;

  async function confirm(): Promise<void> {
    if (!target || busy) return;
    setBusy(true);
    try {
      await resolveIncident(target.id, target.version, user, users);
    } finally {
      setBusy(false);
      onClose();
    }
  }

  const ref = target ? incidentRef(target.id) : '';

  return (
    <ModalDialog open={target !== null} labelledBy="resolve-title" onClose={onClose}>
      {target && (
        <>
          <h2 id="resolve-title">{`Resolve ${ref}?`}</h2>
          {live && <p className="drawer-title-inline">{live.title}</p>}
          <p className="muted">{`This resolves the version you saw when the dialog opened (version ${target.version}).`}</p>
          {moved && live && (
            <p className="warn" role="status">
              {`${ref} changed after this dialog opened (${describeCurrent(live, users)}). Confirming sends version ${target.version}, and the server rejects it if the change conflicts.`}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void confirm()} disabled={busy}>
              Resolve incident
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}
