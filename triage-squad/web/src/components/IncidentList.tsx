// Virtualized listbox. Loading, empty and error states sit outside the listbox element.
import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { UserDTO } from '../../../shared/types';
import { store, type ListState } from '../store';
import { IncidentRow, ROW_HEIGHT } from './IncidentRow';

/** Start loading the next page once the last visible row is this close to the end of the loaded rows. */
const LOAD_MORE_THRESHOLD = 20;

export interface IncidentListProps {
  order: readonly number[];
  status: ListState['status'];
  error: string | null;
  loadingMore: boolean;
  nextCursor: string | null;
  hasFilters: boolean;
  activeId: number | null;
  selected: ReadonlySet<number>;
  users: readonly UserDTO[];
  onOpen: (id: number) => void;
  onToggle: (id: number) => void;
  onActivate: (id: number) => void;
  onClearFilters: () => void;
}

export function IncidentList({
  order,
  status,
  error,
  loadingMore,
  nextCursor,
  hasFilters,
  activeId,
  selected,
  users,
  onOpen,
  onToggle,
  onActivate,
  onClearFilters,
}: IncidentListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    getItemKey: (index) => order[index],
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? items[items.length - 1].index : -1;

  useEffect(() => {
    // error is checked so a failed page does not retry in a loop. The retry button calls store.retry().
    if (status !== 'ready' || nextCursor === null || loadingMore || error !== null) return;
    if (lastIndex >= order.length - LOAD_MORE_THRESHOLD) store.loadMore();
  }, [status, nextCursor, loadingMore, error, lastIndex, order.length]);

  useEffect(() => {
    if (activeId === null) return;
    const index = order.indexOf(activeId);
    if (index !== -1) virtualizer.scrollToIndex(index, { align: 'auto' });
    // Only keyboard or click moves of the active row should scroll the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const showSkeleton = status === 'loading' && order.length === 0;
  const showEmpty = status === 'ready' && order.length === 0;
  const showError = status === 'error';
  const showMoreError = status === 'ready' && order.length > 0 && error !== null;
  const activeDescendant = activeId !== null && order.includes(activeId) ? `inc-${activeId}` : undefined;

  return (
    <div className="list">
      {showSkeleton && (
        <div className="skeleton-wrap">
          <p className="sr-only" role="status">
            Loading incidents…
          </p>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton" aria-hidden="true" />
          ))}
        </div>
      )}

      {showError && (
        <div className="state" role="alert">
          <p>{error ?? 'Incidents could not be loaded.'}</p>
          <button type="button" onClick={() => store.retry()}>
            Try again
          </button>
        </div>
      )}

      {showEmpty && (
        <div className="state" role="status">
          <p>No incidents match these filters.</p>
          {/* Always present, as the empty state promises. Disabled when there is no filter to clear. */}
          <button type="button" onClick={onClearFilters} disabled={!hasFilters}>
            Clear filters
          </button>
        </div>
      )}

      <div
        id="incidents"
        ref={scrollRef}
        role="listbox"
        aria-label="Incidents"
        aria-multiselectable="true"
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        className="listbox"
        hidden={order.length === 0}
      >
        <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const id = order[item.index];
            return (
              <IncidentRow
                key={id}
                id={id}
                start={item.start}
                active={id === activeId}
                selected={selected.has(id)}
                users={users}
                onOpen={onOpen}
                onToggle={onToggle}
                onActivate={onActivate}
              />
            );
          })}
        </div>
      </div>

      {loadingMore && <p className="loading-more" role="status">Loading more…</p>}
      {showMoreError && (
        <div className="state-inline" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => store.retry()}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
