import { dismiss, useToasts } from '../toasts';

export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{t.message}</span>
          <button type="button" className="ghost icon" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
