import { describeCurrent, incidentRef } from '../format';
import { useSession } from '../session';
import { resolveIncident } from './actions';
import { Modal } from './Modal';
import { ui, useEntry, useUi } from './ui';

/**
 * The Resolve button that opened the dialog unmounts once the optimistic patch lands, so the dialog cannot
 * hand focus back to it. Put focus on the drawer (or the list) instead of letting it fall to the page body.
 */
function keepFocus(): void {
  setTimeout(() => {
    const a = document.activeElement;
    if (a !== null && a !== document.body) return;
    const target = document.querySelector<HTMLElement>('section.drawer') ?? document.getElementById('incidents');
    target?.focus({ preventScroll: true });
  }, 0);
}

/** Confirms a resolve against the version pinned when the dialog opened. */
export function ResolveDialog() {
  const pin = useUi((s) => s.resolve);
  const users = useSession().users;
  const entry = useEntry(pin?.id ?? -1);
  const closeAndRefocus = (): void => {
    ui.closeResolve();
    keepFocus();
  };
  const moved = pin !== null && entry !== undefined && entry.inc.version !== pin.version;

  return (
    <Modal open={pin !== null} onClose={closeAndRefocus} labelledBy="resolve-title" className="resolve-dialog">
      {pin !== null && (
        <>
          <h2 id="resolve-title">{`Resolve ${incidentRef(pin.id)}?`}</h2>
          <p>
            Resolving closes this incident. A new alert with the same fingerprint within 5 minutes reopens it.
          </p>
          {moved && entry !== undefined && (
            <p className="warn" role="status">
              {`This incident changed after you opened this dialog (${describeCurrent(entry.inc, users)}). Confirming will be rejected unless you cancel and check it first.`}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => ui.closeResolve()}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const { id, version } = pin;
                ui.closeResolve();
                void resolveIncident(id, version);
              }}
            >
              Resolve incident
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
