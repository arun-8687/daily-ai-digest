// One listbox option. It subscribes to its own store entry, so it re-renders only when that incident changes.
import { memo, useCallback, useSyncExternalStore, type MouseEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { incidentRef, timeOfDay, userName } from '../format';
import { store } from '../store';
import { SeverityBadge, SlaCountdown, StatusBadge } from './Badges';

/** Fixed row height in px. The virtualizer depends on it. Keep in step with .row in styles.css. */
export const ROW_HEIGHT = 76;

export interface IncidentRowProps {
  id: number;
  start: number;
  active: boolean;
  selected: boolean;
  users: readonly UserDTO[];
  onOpen: (id: number) => void;
  onToggle: (id: number) => void;
  onActivate: (id: number) => void;
}

function IncidentRowView({ id, start, active, selected, users, onOpen, onToggle, onActivate }: IncidentRowProps) {
  const getSnapshot = useCallback(() => store.getEntry(id), [id]);
  const entry = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  if (!entry) return null;
  const { inc, pending } = entry;

  const onClick = (ev: MouseEvent<HTMLDivElement>) => {
    onActivate(id);
    if (ev.ctrlKey || ev.metaKey) onToggle(id);
    else onOpen(id);
  };

  const alerts = `${inc.alertCount} alert${inc.alertCount === 1 ? '' : 's'}`;
  const meta = `${userName(users, inc.assigneeId)} · ${alerts} · last seen ${timeOfDay(inc.lastSeen)}`;
  const cls = ['row', active ? 'is-active' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ');

  return (
    <div
      role="option"
      id={`inc-${id}`}
      aria-selected={selected}
      className={cls}
      style={{ transform: `translateY(${start}px)` }}
      onClick={onClick}
    >
      <div className="row-top">
        {selected && (
          <span className="check" aria-hidden="true">
            ✓
          </span>
        )}
        <span className="row-ref">{incidentRef(id)}</span>
        <SeverityBadge severity={inc.severity} />
        <StatusBadge status={inc.status} />
        {pending > 0 && <span className="saving">Saving…</span>}
        <SlaCountdown dueAt={inc.slaDueAt} breachedAt={inc.slaBreachedAt} />
      </div>
      <div className="row-title">{inc.title}</div>
      <div className="row-meta">{meta}</div>
    </div>
  );
}

export const IncidentRow = memo(IncidentRowView);
