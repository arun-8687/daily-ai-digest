import { memo, useSyncExternalStore, type MouseEvent } from 'react';
import { ago, userName } from '../format';
import { useServerNow } from '../clock';
import { session } from '../session';
import { store } from '../store';
import { SeverityBadge, SlaCountdown, StatusBadge } from './Badges';

export const ROW_HEIGHT = 76;

export function rowDomId(id: number): string {
  return `inc-${id}`;
}

export interface RowClick {
  toggle: boolean;
  range: boolean;
}

interface RowProps {
  id: number;
  top: number;
  active: boolean;
  selected: boolean;
  onRowClick: (id: number, mods: RowClick) => void;
}

/** One row. It subscribes to its own entry, so a live update re-renders only this row. */
export const IncidentRow = memo(function IncidentRow({ id, top, active, selected, onRowClick }: RowProps) {
  const entry = useSyncExternalStore(store.subscribe, () => store.getEntry(id));
  const users = useSyncExternalStore(session.subscribe, () => session.getState().users);
  const now = useServerNow();
  if (!entry) return null;
  const inc = entry.inc;

  const handleClick = (e: MouseEvent<HTMLDivElement>) => onRowClick(id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });

  return (
    <div
      role="option"
      id={rowDomId(id)}
      aria-selected={selected}
      className={`row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}
      onClick={handleClick}
    >
      <div className="row-top">
        <span className="ref">INC-{id}</span>
        <SeverityBadge severity={inc.severity} />
        <StatusBadge status={inc.status} />
        {entry.pending > 0 && <span className="saving">Saving…</span>}
        <span className="spacer" />
        <SlaCountdown inc={inc} />
      </div>
      <div className="row-title">{inc.title}</div>
      <div className="row-meta">
        {userName(users, inc.assigneeId)} · {inc.alertCount} alert{inc.alertCount === 1 ? '' : 's'} · last seen{' '}
        {ago(inc.lastSeen, now)}
      </div>
    </div>
  );
});
