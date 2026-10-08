// Native <dialog> wrapper, the shortcuts list and the bulk-ack report.
import { useEffect, useRef, type ReactNode } from 'react';
import type { BulkAckResult, UserDTO } from '../../../shared/types';
import { describeCurrent } from '../format';
import { store } from '../store';

/** Opens and closes a native modal dialog from the open prop. Escape closes it through onClose. */
export function ModalDialog({
  open,
  labelledBy,
  onClose,
  children,
}: {
  open: boolean;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={labelledBy} onClose={onClose}>
      {open ? children : null}
    </dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ['j / k, ↓ / ↑', 'Move the active row'],
  ['Enter', 'Open the active incident (list focused)'],
  ['Space', 'Select or clear the active row (list focused)'],
  ['x', 'Toggle selection of the active row'],
  ['a', 'Acknowledge the active incident'],
  ['r', 'Resolve the active incident (asks first)'],
  ['Shift+A', 'Acknowledge every selected incident'],
  ['/', 'Focus the title search'],
  ['Esc', 'Close the drawer, or clear the selection'],
  ['?', 'Show this list'],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalDialog open={open} labelledBy="shortcuts-title" onClose={onClose}>
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <p className="muted">Letter keys are ignored while you type in a field or while a dialog is open.</p>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="shortcut-row">
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalDialog>
  );
}

export interface BulkReport {
  acked: number;
  total: number;
  failures: BulkAckResult[];
}

/** Why one bulk item was not acked, in words. The server's current state is named when it was sent. */
export function failureReason(result: BulkAckResult, users: readonly UserDTO[]): string {
  const message = result.error?.message ?? 'The change was not applied.';
  return result.current ? `${message} (${describeCurrent(result.current, users)})` : message;
}

export function BulkReportDialog({
  report,
  users,
  onClose,
}: {
  report: BulkReport | null;
  users: readonly UserDTO[];
  onClose: () => void;
}) {
  const open = report !== null;
  return (
    <ModalDialog open={open} labelledBy="bulk-report-title" onClose={onClose}>
      {report && (
        <>
          <h2 id="bulk-report-title">{`Bulk ack: ${report.acked} of ${report.total} acked`}</h2>
          {report.failures.length === 0 ? (
            <p>Every selected incident was acknowledged.</p>
          ) : (
            <>
              <p className="muted">These stayed selected. Review them and try again if they still apply.</p>
              <ul className="report-list">
                {report.failures.map((failure) => {
                  const inc = store.getEntry(failure.id)?.inc;
                  const title = inc ? ` ${inc.title}` : '';
                  return (
                    <li key={failure.id}>
                      <strong>{`INC-${failure.id}`}</strong>
                      {title}
                      <div className="muted">{failureReason(failure, users)}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}
