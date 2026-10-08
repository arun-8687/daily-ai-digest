import { dismiss, useToasts } from '../toasts';

export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-text">{t.message}</span>
          <button type="button" className="toast-dismiss" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
