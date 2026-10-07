// The incident store. It holds the loaded window of the list plus one entry per incident
// seen this session. Rows subscribe to their own entry, so a live update re-renders only
// the row that changed. Versions are monotonic: an older event or response can never
// overwrite newer state.
import { matchesFilters, type Filters } from '../../shared/rules';
import type {
  BulkAckResult,
  IncidentDTO,
  IncidentEventData,
  ListResponse,
  StreamEventType,
} from '../../shared/types';
import { api, ApiError, isAbortError, messageOf } from './api';

export const PAGE_SIZE = 100;

export interface Entry {
  readonly inc: IncidentDTO;
  /** Local mutations still waiting on the server. */
  readonly pending: number;
}

export interface ListState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly filters: Filters;
  /** Incident ids in display order (newest first). */
  readonly order: readonly number[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly loadingMore: boolean;
}

type UpdateListener = (id: number | null, type: string) => void;

function listUrl(filters: Filters, cursor: string | undefined, limit: number): string {
  const p = new URLSearchParams();
  if (filters.status) p.set('status', filters.status);
  if (filters.severity) p.set('severity', filters.severity);
  if (filters.assignee) p.set('assignee', filters.assignee);
  if (filters.q) p.set('q', filters.q);
  if (cursor) p.set('cursor', cursor);
  p.set('limit', String(limit));
  return `/api/incidents?${p.toString()}`;
}

function filterKey(f: Filters): string {
  return JSON.stringify([f.status ?? '', f.severity ?? '', f.assignee ?? '', (f.q ?? '').trim()]);
}

class IncidentStore {
  private list: ListState = {
    status: 'loading',
    error: null,
    filters: {},
    order: [],
    nextCursor: null,
    total: null,
    loadingMore: false,
  };
  private readonly entries = new Map<number, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly updateListeners = new Set<UpdateListener>();
  private generation = 0;
  private controller: AbortController | null = null;
  private filterKeyValue: string | null = null;

  // ---- subscriptions (used by useSyncExternalStore) -------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getList = (): ListState => this.list;

  getEntry = (id: number): Entry | undefined => this.entries.get(id);

  /** Fires after every applied live update or resync. Used by the drawer to refresh alerts and audit. */
  onUpdate = (listener: UpdateListener): (() => void) => {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private setList(patch: Partial<ListState>): void {
    this.list = { ...this.list, ...patch };
    this.emit();
  }

  // ---- loading -------------------------------------------------------------

  /** Switches the list to new filters and loads the first page. A no-op if the filters did not change. */
  setFilters(filters: Filters): void {
    const key = filterKey(filters);
    if (key === this.filterKeyValue) return;
    this.filterKeyValue = key;
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.list = {
      status: 'loading',
      error: null,
      filters,
      order: [],
      nextCursor: null,
      total: null,
      loadingMore: false,
    };
    this.emit();
    void this.fetchWindow(PAGE_SIZE, 'replace');
  }

  /** Re-fetches the head of the list, keeping the window the user has already scrolled through. */
  resync(): void {
    if (this.filterKeyValue === null) return;
    void this.fetchWindow(Math.max(PAGE_SIZE, this.list.order.length), 'merge');
    for (const l of this.updateListeners) l(null, 'resync');
  }

  retry(): void {
    if (this.filterKeyValue === null) return;
    this.setList({ status: 'loading', error: null });
    void this.fetchWindow(PAGE_SIZE, 'merge');
  }

  loadMore(): void {
    const { nextCursor, loadingMore, status, filters } = this.list;
    if (!nextCursor || loadingMore || status !== 'ready') return;
    const gen = this.generation;
    this.setList({ loadingMore: true });
    api<ListResponse>(listUrl(filters, nextCursor, PAGE_SIZE))
      .then((page) => {
        if (gen !== this.generation) return;
        for (const inc of page.items) this.upsertEntry(inc);
        const known = new Set(this.list.order);
        const appended = page.items.map((i) => i.id).filter((id) => !known.has(id));
        this.list = {
          ...this.list,
          order: [...this.list.order, ...appended],
          nextCursor: page.nextCursor,
          loadingMore: false,
        };
        this.emit();
      })
      .catch((err: unknown) => {
        if (gen !== this.generation || isAbortError(err)) return;
        this.setList({ loadingMore: false, error: messageOf(err) });
      });
  }

  private async fetchWindow(want: number, mode: 'replace' | 'merge'): Promise<void> {
    const gen = this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const filters = this.list.filters;
      const items: IncidentDTO[] = [];
      let cursor: string | undefined;
      let total: number | null = null;
      let nextCursor: string | null = null;
      let first = true;
      do {
        const page: ListResponse = await api<ListResponse>(
          listUrl(filters, cursor, Math.min(200, want - items.length)),
          { signal: controller.signal },
        );
        if (first) total = page.total;
        first = false;
        items.push(...page.items);
        nextCursor = page.nextCursor;
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && items.length < want);
      if (gen !== this.generation) return;
      this.applyWindow(items, nextCursor, total);
    } catch (err) {
      if (gen !== this.generation || isAbortError(err)) return;
      this.setList({ status: 'error', error: messageOf(err) });
    }
  }

  /**
   * Replaces the head of the order with a fresh page. Ids above the fetched range that
   * arrived live while the request was in flight are kept, so a new incident is not lost.
   */
  private applyWindow(items: IncidentDTO[], nextCursor: string | null, total: number | null): void {
    for (const inc of items) this.upsertEntry(inc);
    const pageIds = items.map((i) => i.id);
    const pageSet = new Set(pageIds);
    const top = pageIds.length > 0 ? pageIds[0] : Number.POSITIVE_INFINITY;
    const filters = this.list.filters;
    const extra = this.list.order.filter((id) => {
      if (pageSet.has(id)) return false;
      const entry = this.entries.get(id);
      if (!entry || !matchesFilters(entry.inc, filters)) return false;
      return nextCursor === null || id > top;
    });
    const order = [...pageIds, ...extra].sort((a, b) => b - a);
    this.list = { ...this.list, status: 'ready', error: null, order, nextCursor, total: total ?? this.list.total };
    this.emit();
  }

  // ---- live updates --------------------------------------------------------

  /** Applies one event from the live stream. */
  applyEvent(type: StreamEventType, data: IncidentEventData): void {
    const prev = this.entries.get(data.incident.id);
    const before = prev && matchesFilters(prev.inc, this.list.filters);
    this.upsertEntry(data.incident);
    const after = matchesFilters(data.incident, this.list.filters);
    if (this.list.total !== null) {
      // Track the result-set size for changes we can see. Changes outside what we have seen are picked up on resync.
      if (type === 'incident.created' && after) this.list = { ...this.list, total: this.list.total + 1 };
      else if (prev && before !== after) this.list = { ...this.list, total: this.list.total + (after ? 1 : -1) };
    }
    this.syncMembership(data.incident);
    this.emit();
    for (const l of this.updateListeners) l(data.incident.id, type);
  }

  /** Monotonic write: a version that is not newer than what we hold is ignored. */
  private upsertEntry(inc: IncidentDTO, force = false): void {
    const prev = this.entries.get(inc.id);
    if (prev && !force && inc.version <= prev.inc.version) return;
    this.entries.set(inc.id, { inc, pending: prev?.pending ?? 0 });
  }

  /** Keeps `order` consistent with filters: insert matches inside the loaded window, remove non-matches. */
  private syncMembership(inc: IncidentDTO): void {
    const order = this.list.order;
    const idx = order.indexOf(inc.id);
    const matches = matchesFilters(inc, this.list.filters);
    if (matches && idx === -1) {
      const lowest = order.length > 0 ? order[order.length - 1] : Number.NEGATIVE_INFINITY;
      if (this.list.nextCursor !== null && inc.id < lowest) return;
      let pos = 0;
      while (pos < order.length && order[pos] > inc.id) pos++;
      const next = order.slice();
      next.splice(pos, 0, inc.id);
      this.list = { ...this.list, order: next };
    } else if (!matches && idx !== -1) {
      const next = order.slice();
      next.splice(idx, 1);
      this.list = { ...this.list, order: next };
    }
  }

  // ---- local mutations (optimistic) ----------------------------------------

  private settle(id: number, fn: (e: Entry) => Entry): void {
    const e = this.entries.get(id);
    if (!e) return;
    const next = fn(e);
    this.entries.set(id, next);
    this.syncMembership(next.inc);
    this.emit();
  }

  /**
   * Applies `patch` immediately, sends the request with the version the change was based on,
   * and reconciles when the response arrives. On 409 the server's copy replaces the local one.
   * On other failures the local change is undone, unless newer server state has arrived.
   */
  async mutate(id: number, patch: Partial<IncidentDTO>, request: (version: number) => Promise<IncidentDTO>): Promise<IncidentDTO> {
    const entry = this.entries.get(id);
    if (!entry) throw new ApiError(0, 'not_loaded', 'That incident is not loaded yet');
    const before = entry.inc;
    const optimistic = { ...before, ...patch };
    this.entries.set(id, { inc: optimistic, pending: entry.pending + 1 });
    this.syncMembership(optimistic);
    this.emit();
    try {
      const server = await request(before.version);
      this.settle(id, (e) => ({ inc: server.version > e.inc.version ? server : e.inc, pending: e.pending - 1 }));
      return server;
    } catch (err) {
      if (err instanceof ApiError && err.current) {
        const current = err.current;
        this.settle(id, (e) => ({ inc: current, pending: e.pending - 1 }));
      } else {
        this.settle(id, (e) => ({ inc: e.inc.version === before.version ? before : e.inc, pending: e.pending - 1 }));
      }
      throw err;
    }
  }

  /**
   * Acks many incidents in one request. Every selected item is sent, so the server decides
   * each one and the report can explain every failure (already acked, changed, not found).
   * Open items get an optimistic ack. The others stay as they are until the server answers.
   */
  async bulkAck(ids: number[], actor: { id: string; displayName: string }): Promise<BulkAckResult[]> {
    const now = Date.now();
    const items: { id: number; before: IncidentDTO }[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      items.push({ id, before: entry.inc });
      const inc =
        entry.inc.status === 'open'
          ? { ...entry.inc, status: 'acked' as const, ackedBy: actor.id, ackedAt: now }
          : entry.inc;
      this.entries.set(id, { inc, pending: entry.pending + 1 });
      this.syncMembership(inc);
    }
    this.emit();

    const revert = (id: number, before: IncidentDTO) =>
      this.settle(id, (e) => ({ inc: e.inc.version === before.version ? before : e.inc, pending: e.pending - 1 }));

    let results: BulkAckResult[];
    try {
      const res = await api<{ results: BulkAckResult[] }>('/api/incidents/bulk-ack', {
        method: 'POST',
        body: { items: items.map((i) => ({ id: i.id, version: i.before.version })) },
      });
      results = res.results;
    } catch (err) {
      for (const i of items) revert(i.id, i.before);
      throw err;
    }

    for (const r of results) {
      const item = items.find((i) => i.id === r.id);
      if (r.ok && r.incident) {
        const server = r.incident;
        this.settle(r.id, (e) => ({ inc: server.version > e.inc.version ? server : e.inc, pending: e.pending - 1 }));
      } else if (r.current) {
        const current = r.current;
        this.settle(r.id, (e) => ({ inc: current, pending: e.pending - 1 }));
      } else if (item) {
        revert(item.id, item.before);
      }
    }
    return results;
  }

  /** Makes an incident fetched outside the list (a deep link) available to mutations and rows. */
  seed(inc: IncidentDTO): void {
    this.upsertEntry(inc);
    this.emit();
  }

  /** Drops everything, for sign-out. */
  clear(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.entries.clear();
    this.filterKeyValue = null;
    this.list = { status: 'loading', error: null, filters: {}, order: [], nextCursor: null, total: null, loadingMore: false };
    this.emit();
  }
}

export const store = new IncidentStore();
