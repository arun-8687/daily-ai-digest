import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IncidentRow, ROW_HEIGHT, rowDomId, type RowClick } from './IncidentRow';

export interface IncidentListHandle {
  scrollToIndex(index: number): void;
}

interface Props {
  order: readonly number[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  loadingMore: boolean;
  hasFilters: boolean;
  active: number | null;
  selected: ReadonlySet<number>;
  onRowClick: (id: number, mods: RowClick) => void;
  onNeedMore: () => void;
  onRetry: () => void;
  onClearFilters: () => void;
}

/**
 * Virtualized listbox. Only the rows on screen are in the DOM, so 10,000 incidents scroll
 * as smoothly as 20. The listbox contains options only. Loading, empty, and error states
 * are rendered beside it.
 */
export const IncidentList = forwardRef<IncidentListHandle, Props>(function IncidentList(props, ref) {
  const { order, status, error, loadingMore, hasFilters, active, selected, onRowClick, onNeedMore, onRetry, onClearFilters } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => order[index],
  });

  useImperativeHandle(ref, () => ({ scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'auto' }) }), [virtualizer]);

  const items = virtualizer.getVirtualItems();
  const lastVisible = items.length > 0 ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (lastVisible >= order.length - 20) onNeedMore();
  }, [lastVisible, order.length, onNeedMore]);

  const activeId = active !== null && order.includes(active) ? rowDomId(active) : undefined;
  const showEmpty = status === 'ready' && order.length === 0;
  const showLoading = status === 'loading' && order.length === 0;

  return (
    <>
      <div
        ref={scrollRef}
        id="incidents"
        className="list-scroll"
        role="listbox"
        aria-label="Incidents"
        aria-multiselectable="true"
        aria-busy={status === 'loading'}
        aria-activedescendant={activeId}
        tabIndex={0}
      >
        <div className="list-inner" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((v) => {
            const id = order[v.index];
            return (
              <IncidentRow
                key={id}
                id={id}
                top={v.start}
                active={id === active}
                selected={selected.has(id)}
                onRowClick={onRowClick}
              />
            );
          })}
        </div>
      </div>

      {showLoading && (
        <div className="skeleton" role="status" aria-label="Loading incidents">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton-row" />
          ))}
          <span className="visually-hidden">Loading incidents…</span>
        </div>
      )}
      {status === 'error' && (
        <div className="state state-error" role="alert">
          <p>Couldn't load incidents. {error}</p>
          <button type="button" className="primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {showEmpty && (
        <div className="state" role="status">
          {hasFilters ? (
            <>
              <p>No incidents match these filters.</p>
              <button type="button" className="ghost" onClick={onClearFilters}>
                Clear filters
              </button>
            </>
          ) : (
            <p>No incidents yet. Send an alert to <code>POST /ingest</code> or run <code>npm run simulate</code>.</p>
          )}
        </div>
      )}
      {loadingMore && <p className="loading-more" role="status">Loading more…</p>}
    </>
  );
});
