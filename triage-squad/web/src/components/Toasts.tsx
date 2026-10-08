// Transient messages, bottom-right. Errors are alerts. Everything else is a polite status.
import { dismiss, useToasts } from '../toasts';

export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          <button type="button" className="ghost" onClick={() => dismiss(t.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
