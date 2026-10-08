import { ui, useUi } from './ui';
import { Modal } from './Modal';

/** Result of the last bulk ack. Failures are listed with their reasons and stay selected. */
export function BulkReport() {
  const bulk = useUi((s) => s.bulk);
  const close = (): void => ui.setBulk(null);
  return (
    <Modal open={bulk !== null} onClose={close} labelledBy="bulk-title" className="bulk-report">
      {bulk !== null && (
        <>
          <h2 id="bulk-title">{`Bulk ack: ${bulk.ok} of ${bulk.total} acked`}</h2>
          {bulk.failures.length > 0 ? (
            <>
              <p>These were not acked. They are still selected.</p>
              <ul className="failure-list">
                {bulk.failures.map((f) => (
                  <li key={f.id}>{f.message}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>Every selected incident was acked.</p>
          )}
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
