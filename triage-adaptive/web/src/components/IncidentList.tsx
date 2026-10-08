import { memo, useEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { store } from '../store';
import { useServerNow } from '../clock';
import { ago, incidentRef, slaLabel, userName } from '../format';
import { navigate } from '../router';
import { useSession } from '../session';
import type { IncidentDTO, UserDTO } from '../../../shared/types';
import { SeverityBadge, StatusBadge } from './Badges';
import { clearFilters } from './actions';
import { ui, useEntry, useList, useUi } from './ui';

const ROW_HEIGHT = 76;
/** Load the next page when the last rendered row is this close to the end. */
const LOAD_AHEAD = 20;

function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="skeleton-row" key={i} />
      ))}
    </div>
  );
}

interface RowProps {
  id: number;
  top: number;
  active: boolean;
  selected: boolean;
  now: number;
  users: readonly UserDTO[];
}

const Row = memo(function Row({ id, top, active, selected, now, users }: RowProps) {
  const entry = useEntry(id);
  if (!entry) return null;
  const inc: IncidentDTO = entry.inc;
  const sla = slaLabel(inc, now);

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const pos = store.getList().order.indexOf(id);
    if (e.ctrlKey || e.metaKey) {
      ui.toggleSelected(id);
      ui.activate(id, pos);
      return;
    }
    ui.activate(id, pos);
    navigate({ sel: String(id) }, 'push');
  };

  const alerts = inc.alertCount === 1 ? '1 alert' : `${inc.alertCount} alerts`;
  return (
    <div
      role="option"
      id={`inc-${id}`}
      aria-selected={selected}
      data-active={active}
      className={`row${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
      style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}
      onClick={onClick}
    >
      <div className="row-top">
        <span className="row-ref">{incidentRef(id)}</span>
        <SeverityBadge severity={inc.severity} />
        <StatusBadge status={inc.status} />
        {entry.pending > 0 && <span className="saving">Saving…</span>}
        {sla !== null && <span className={`sla${inc.slaBreachedAt !== null ? ' sla-breached' : ''}`}>{sla}</span>}
      </div>
      <div className="row-title">{inc.title}</div>
      <div className="row-meta">
        {`${userName(users, inc.assigneeId)} · ${alerts} · last seen ${ago(inc.lastSeen, now)}`}
      </div>
    </div>
  );
});

export function IncidentList() {
  const list = useList();
  const users = useSession().users;
  const activeId = useUi((s) => s.active);
  const selected = useUi((s) => s.selected);
  const now = useServerNow();
  const listRef = useRef<HTMLDivElement>(null);
  const order = list.order;

  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    getItemKey: (index) => order[index] ?? index,
  });
  const items = virtualizer.getVirtualItems();

  // The cursor follows the rows: when its row leaves the order, the row that took its place is adopted.
  useEffect(() => {
    ui.syncOrder(order);
  }, [order]);

  // Scroll the active row into view when the cursor moves.
  useEffect(() => {
    if (activeId === null) return;
    const i = store.getList().order.indexOf(activeId);
    if (i >= 0) virtualizer.scrollToIndex(i);
  }, [activeId, virtualizer]);

  const lastIndex = items.length > 0 ? items[items.length - 1].index : -1;
  const nextCursor = list.nextCursor;
  useEffect(() => {
    if (nextCursor !== null && lastIndex >= order.length - LOAD_AHEAD) store.loadMore();
  }, [lastIndex, order.length, nextCursor]);

  // Rows are virtualized: only point at the active row while it is actually in the DOM.
  const activeIndex = activeId === null ? -1 : order.indexOf(activeId);
  const activeRendered = activeIndex >= 0 && items.some((vi) => vi.index === activeIndex);
  const ready = list.status === 'ready';

  return (
    <div className="incident-list">
      <div className="list-state">
        {list.status === 'loading' && order.length === 0 && (
          <>
            <p className="sr-only" role="status">
              Loading incidents
            </p>
            <Skeleton />
          </>
        )}
        {list.error !== null && (
          <div className="notice error" role="alert">
            <span>{list.error}</span>
            <button type="button" onClick={() => store.retry()}>
              Try again
            </button>
          </div>
        )}
        {ready && order.length === 0 && list.error === null && (
          <div className="empty">
            <p>No incidents match these filters.</p>
            <button type="button" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        )}
      </div>

      <div
        role="listbox"
        id="incidents"
        aria-label="Incidents"
        aria-multiselectable="true"
        aria-activedescendant={activeRendered ? `inc-${activeId}` : undefined}
        tabIndex={0}
        ref={listRef}
        className="listbox"
      >
        <div role="presentation" className="listbox-inner" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((vi) => {
            const id = order[vi.index];
            if (id === undefined) return null;
            return (
              <Row
                key={id}
                id={id}
                top={vi.start}
                active={id === activeId}
                selected={selected.has(id)}
                now={now}
                users={users}
              />
            );
          })}
        </div>
      </div>

      {list.loadingMore && <p className="more">Loading more…</p>}
    </div>
  );
}
