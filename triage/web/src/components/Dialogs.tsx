import { useEffect, useRef } from 'react';
import type { BulkAckResult, UserDTO } from '../../../shared/types';
import { describeCurrent, incidentRef } from '../format';

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useDialog(open);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="shortcuts-title" onClose={onClose}>
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <dl className="keys">
        <dt>
          <kbd>j</kbd> / <kbd>k</kbd>
        </dt>
        <dd>Move down or up the list</dd>
        <dt>
          <kbd>Enter</kbd>
        </dt>
        <dd>Open details</dd>
        <dt>
          <kbd>a</kbd>
        </dt>
        <dd>Ack the active incident</dd>
        <dt>
          <kbd>r</kbd>
        </dt>
        <dd>Resolve (asks you to confirm)</dd>
        <dt>
          <kbd>x</kbd> or <kbd>Space</kbd>
        </dt>
        <dd>Select or deselect for bulk actions</dd>
        <dt>
          <kbd>Shift</kbd>+<kbd>A</kbd>
        </dt>
        <dd>Ack all selected</dd>
        <dt>
          <kbd>/</kbd>
        </dt>
        <dd>Search titles</dd>
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>Close details, or clear the selection</dd>
        <dt>
          <kbd>?</kbd>
        </dt>
        <dd>Show this list</dd>
      </dl>
      <form method="dialog" className="dialog-actions">
        <button className="primary">Close</button>
      </form>
    </dialog>
  );
}

function reason(r: BulkAckResult, users: readonly UserDTO[]): string {
  if (r.current) return `changed (${describeCurrent(r.current, users)})`;
  if (r.status === 404) return 'not found';
  return r.error?.message ?? 'not acked';
}

export function BulkReportDialog({
  report,
  users,
  onClose,
}: {
  report: { total: number; results: BulkAckResult[] } | null;
  users: readonly UserDTO[];
  onClose: () => void;
}) {
  const ref = useDialog(report !== null);
  const acked = report?.results.filter((r) => r.ok) ?? [];
  const failed = report?.results.filter((r) => !r.ok) ?? [];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="bulk-title" onClose={onClose}>
      {report && (
        <>
          <h2 id="bulk-title">
            Bulk ack: {acked.length} of {report.total} acked
          </h2>
          {failed.length > 0 && (
            <>
              <p>
                {failed.length} did not change. They are still selected, so press <kbd>Shift</kbd>+<kbd>A</kbd> to retry
                them.
              </p>
              <ul className="bulk-list">
                {failed.map((r) => (
                  <li key={r.id}>
                    <strong>{incidentRef(r.id)}</strong>: {reason(r, users)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {acked.length > 0 && (
            <p className="muted small">Acked: {acked.map((r) => incidentRef(r.id)).join(', ')}</p>
          )}
          <form method="dialog" className="dialog-actions">
            <button className="primary">Done</button>
          </form>
        </>
      )}
    </dialog>
  );
}
