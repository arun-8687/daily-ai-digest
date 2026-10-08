// Client state for the incident list and every incident seen so far.
//
// Rules (SPEC section 4):
// - Merge by rev. An incoming copy with rev <= local rev is ignored. A 409 `current` is forced, but only when its rev is not
//   older than the local rev, so a newer live copy is never overwritten by older server truth.
// - Each incident has a server copy (the last server truth) and a display copy. mutate shows its patch on top of the server
//   copy at once and keeps it in flight. A settled patch is removed, and the display is rebuilt from the server copy plus the
//   patches still in flight, so a failed mutate never undoes another pending change. Rolling back over a newer rev is never needed,
//   because the server copy already holds that rev.
// - Every list request carries a generation. setFilters, resync, retry and clear bump it, so stale responses are dropped.
// - Live membership: a matching incident enters the list only if the list is complete or the id is above the lowest loaded id.
//   A non-matching incident leaves. `total` moves by one when a known incident flips match, and when an unknown incident that
//   matches enters (a created one always; an updated one only when the list is complete or the id is above the loaded tail).
// - getList() identity changes only when list-level state changes. getEntry(id) identity changes only when that entry changes.
import type {
  BulkAckResult,
  IncidentDTO,
  IncidentEventData,
  ListResponse,
  StreamEventType,
} from '../../shared/types';
import { matchesFilters, type Filters } from '../../shared/rules';
import { ApiError, api, isAbortError, messageOf } from './api';
import { serverNow } from './clock';

export const PAGE_SIZE = 100;
/** Server maximum for one list page. */
const MAX_LIMIT = 200;
/** Resync never refetches more than this many rows. */
const MAX_RESYNC_ROWS = 1000;
/** Resync never issues more than this many list requests. */
const MAX_RESYNC_REQUESTS = 5;
/** Server maximum for one bulk-ack request. */
const BULK_CHUNK = 500;

export interface Entry {
  readonly inc: IncidentDTO;
  /** Mutations in flight for this incident. Non-zero means "Saving…". */
  readonly pending: number;
}

export interface ListState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly filters: Filters;
  /** Loaded incident ids, newest (largest id) first. */
  readonly order: readonly number[];
  readonly nextCursor: string | null;
  /** Matching rows on the server. Only known from the first page; null otherwise. */
  readonly total: number | null;
  readonly loadingMore: boolean;
}

type UpdateListener = (id: number | null, type: string) => void;
type Listener = () => void;

/** One optimistic patch in flight. The object itself is the handle used to remove it. */
interface OptimisticPatch {
  readonly patch: Partial<IncidentDTO>;
}

let filters: Filters = {};
/** True once a list load has been requested since start or clear(). */
let started = false;
let generation = 0;
/** Bumped by clear() only. Guards mutations that were in flight when the session ended. */
let epoch = 0;
let controller: AbortController | null = null;

let listStatus: ListState['status'] = 'loading';
let listError: string | null = null;
let order: number[] = [];
let nextCursor: string | null = null;
let total: number | null = null;
let loadingMore = false;

/** Display copy of every incident seen so far. */
const entries = new Map<number, Entry>();
/** Last server copy of every incident in `entries`. Rollback rebuilds the display copy from here. */
const serverCopies = new Map<number, IncidentDTO>();
/** Optimistic patches not yet settled, per incident, oldest first. */
const optimistic = new Map<number, OptimisticPatch[]>();
const listeners = new Set<Listener>();
const updateListeners = new Set<UpdateListener>();

function snapshotList(): ListState {
  return { status: listStatus, error: listError, filters, order, nextCursor, total, loadingMore };
}

let list: ListState = snapshotList();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Call after any change to list-level state. Replaces the cached ListState identity. */
function changed(): void {
  list = snapshotList();
  emit();
}

function notifyUpdate(id: number | null, type: string): void {
  for (const listener of [...updateListeners]) listener(id, type);
}

function normalize(f: Filters): Filters {
  const out: Filters = {};
  if (f.status) out.status = f.status;
  if (f.severity) out.severity = f.severity;
  if (f.assignee) out.assignee = f.assignee;
  const q = f.q?.trim();
  if (q) out.q = q;
  return out;
}

function sameFilters(a: Filters, b: Filters): boolean {
  return a.status === b.status && a.severity === b.severity && a.assignee === b.assignee && a.q === b.q;
}

function matchesId(id: number): boolean {
  const entry = entries.get(id);
  return entry !== undefined && matchesFilters(entry.inc, filters);
}

function listPath(f: Filters, cursor: string | null, limit: number): string {
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.severity) params.set('severity', f.severity);
  if (f.assignee) params.set('assignee', f.assignee);
  if (f.q) params.set('q', f.q);
  if (cursor !== null) params.set('cursor', cursor);
  params.set('limit', String(limit));
  return `/api/incidents?${params.toString()}`;
}

function uniqueDesc(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => b - a);
}

function insertDesc(ids: number[], id: number): number[] {
  const out = ids.slice();
  const index = out.findIndex((x) => x < id);
  if (index === -1) out.push(id);
  else out.splice(index, 0, id);
  return out;
}

/**
 * Updates list membership and the total for one incident whose display copy just changed.
 * Returns true when order or total changed.
 */
function reconcile(inc: IncidentDTO, wasKnown: boolean, prevMatch: boolean, created: boolean): boolean {
  const nowMatch = matchesFilters(inc, filters);
  const present = order.includes(inc.id);
  const lowest = order.length > 0 ? order[order.length - 1] : null;
  // The list holds every matching row at or above its lowest loaded id, and every matching row when it is complete.
  const complete = nextCursor === null;
  const aboveTail = lowest !== null && inc.id > lowest;
  const insertable = complete || lowest === null || aboveTail;
  let listChanged = false;

  if (total !== null) {
    if (wasKnown) {
      if (prevMatch !== nowMatch) {
        total = Math.max(0, total + (nowMatch ? 1 : -1));
        listChanged = true;
      }
    } else if (nowMatch && (created || complete || aboveTail)) {
      // An unknown copy that matches was not counted yet. A created one is new. An unknown one that is complete or above
      // the loaded tail was not matching when the head was fetched, so it is new to the total.
      total += 1;
      listChanged = true;
    }
  }

  if (nowMatch && !present) {
    if (insertable) {
      order = insertDesc(order, inc.id);
      listChanged = true;
    }
  } else if (!nowMatch && present) {
    order = order.filter((id) => id !== inc.id);
    listChanged = true;
  }
  return listChanged;
}

/**
 * Shows a server copy with the optimistic patches still in flight, and reconciles membership. Does not touch the server copy.
 * Every display update goes through here or storeQuiet, so a live event or a loaded page cannot undo a pending change.
 */
function show(base: IncidentDTO, created = false): void {
  const inc = withPatches(base);
  const prev = entries.get(base.id);
  const prevMatch = prev !== undefined && matchesFilters(prev.inc, filters);
  entries.set(base.id, { inc, pending: prev?.pending ?? 0 });
  if (reconcile(inc, prev !== undefined, prevMatch, created)) changed();
  else emit();
}

/**
 * Stores a server copy from a list response, only if it is newer. Does not emit.
 * The display copy becomes the server copy plus any patches still in flight.
 */
function storeQuiet(inc: IncidentDTO): void {
  const base = serverCopies.get(inc.id);
  if (base && inc.rev <= base.rev) return;
  serverCopies.set(inc.id, inc);
  entries.set(inc.id, { inc: withPatches(inc), pending: entries.get(inc.id)?.pending ?? 0 });
}

/**
 * Writes a server copy and shows it. Returns false when the rev rule rejects it.
 * guarded (events, results, seeds): accept only rev > local. forced (a 409 `current`): accept rev >= local.
 */
function storeServer(inc: IncidentDTO, forced: boolean, created = false): boolean {
  const base = serverCopies.get(inc.id);
  if (base && (forced ? inc.rev < base.rev : inc.rev <= base.rev)) return false;
  serverCopies.set(inc.id, inc);
  show(inc, created);
  return true;
}

/** The server copy with every optimistic patch still in flight applied, oldest first. */
function withPatches(base: IncidentDTO): IncidentDTO {
  const patches = optimistic.get(base.id);
  if (!patches) return base;
  return patches.reduce<IncidentDTO>((acc, p) => ({ ...acc, ...p.patch }), base);
}

/** Re-shows the server copy with the patches still in flight. Used when a patch settles without a server write. */
function refresh(id: number): void {
  const base = serverCopies.get(id);
  const cur = entries.get(id);
  if (!base || !cur) return;
  if (withPatches(base) !== cur.inc) show(base);
}

function addPatch(id: number, patch: Partial<IncidentDTO>): OptimisticPatch {
  const token: OptimisticPatch = { patch };
  optimistic.set(id, [...(optimistic.get(id) ?? []), token]);
  return token;
}

function dropPatch(id: number, token: OptimisticPatch): void {
  const rest = (optimistic.get(id) ?? []).filter((p) => p !== token);
  if (rest.length > 0) optimistic.set(id, rest);
  else optimistic.delete(id);
}

function adjustPending(id: number, delta: number): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.set(id, { inc: entry.inc, pending: Math.max(0, entry.pending + delta) });
  emit();
}

/** Applies a page of the first-page (head) request: merges rows, then rebuilds the head of the list. */
function commitHead(rows: IncidentDTO[], headTotal: number | null, next: string | null): void {
  for (const row of rows) storeQuiet(row);
  const headId = rows.length > 0 ? Math.max(...rows.map((row) => row.id)) : -Infinity;
  // Live-inserted ids above the fetched head are newer than the snapshot, so they stay if they still match.
  const kept = order.filter((id) => id > headId && matchesId(id));
  const fresh = rows.map((row) => row.id).filter((id) => matchesId(id));
  order = uniqueDesc([...kept, ...fresh]);
  total = headTotal;
  nextCursor = next;
  listStatus = 'ready';
  listError = null;
  loadingMore = false;
  changed();
}

/**
 * Starts a head request. 'load' resets the list and fetches the first page.
 * 'resync' keeps the current list and refetches max(PAGE_SIZE, loaded) rows, capped at MAX_RESYNC_ROWS.
 */
function runHead(target: number, kind: 'load' | 'resync'): void {
  generation += 1;
  const gen = generation;
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;

  if (kind === 'load') {
    started = true;
    order = [];
    nextCursor = null;
    total = null;
    listError = null;
    listStatus = 'loading';
  }
  loadingMore = false;
  changed();

  const f = filters;
  void (async () => {
    try {
      const rows: IncidentDTO[] = [];
      let headTotal: number | null = null;
      let cursor: string | null = null;
      let next: string | null = null;
      let requests = 0;
      do {
        const limit = Math.min(MAX_LIMIT, target - rows.length);
        const page: ListResponse = await api<ListResponse>(listPath(f, cursor, limit), { signal: ctl.signal });
        if (gen !== generation) return;
        if (requests === 0) headTotal = page.total;
        rows.push(...page.items);
        next = page.nextCursor;
        cursor = next;
        requests += 1;
        // A short page means the server had no more rows for this batch, so stop and keep its cursor.
        if (page.items.length < limit) break;
      } while (cursor !== null && rows.length < target && requests < MAX_RESYNC_REQUESTS);
      if (gen !== generation) return;
      commitHead(rows, headTotal, next);
      if (kind === 'resync') notifyUpdate(null, 'resync');
    } catch (err) {
      if (gen !== generation || isAbortError(err)) return;
      // A failed resync on a ready list keeps the data we have. The next reconnect tries again.
      if (listStatus !== 'ready') {
        listStatus = 'error';
        listError = messageOf(err);
        changed();
      }
    }
  })();
}

function setFilters(f: Filters): void {
  const next = normalize(f);
  if (started && sameFilters(next, filters)) return;
  filters = next;
  runHead(PAGE_SIZE, 'load');
}

function loadMore(): void {
  if (listStatus !== 'ready' || nextCursor === null || loadingMore) return;
  const gen = generation;
  const f = filters;
  const cursor = nextCursor;
  const signal = controller?.signal;
  loadingMore = true;
  listError = null;
  changed();

  api<ListResponse>(listPath(f, cursor, PAGE_SIZE), { signal }).then(
    (page) => {
      if (gen !== generation) return;
      for (const row of page.items) storeQuiet(row);
      const ids = page.items.map((row) => row.id).filter(matchesId);
      order = uniqueDesc([...order, ...ids]);
      nextCursor = page.nextCursor;
      loadingMore = false;
      changed();
    },
    (err) => {
      if (gen !== generation || isAbortError(err)) return;
      loadingMore = false;
      listError = messageOf(err);
      changed();
    },
  );
}

function retry(): void {
  if (listStatus === 'error') runHead(PAGE_SIZE, 'load');
  else loadMore();
}

function resync(): void {
  if (!started) return;
  if (listStatus === 'error') {
    runHead(PAGE_SIZE, 'load');
    return;
  }
  runHead(Math.min(MAX_RESYNC_ROWS, Math.max(PAGE_SIZE, order.length)), 'resync');
}

function applyEvent(type: StreamEventType, data: IncidentEventData): void {
  if (type !== 'incident.created' && type !== 'incident.updated' && type !== 'incident.sla_breached') return;
  const inc = data?.incident;
  if (!inc) return;
  storeServer(inc, false, type === 'incident.created');
  notifyUpdate(inc.id, type);
}

function seed(inc: IncidentDTO): void {
  storeServer(inc, false);
}

async function mutate(
  id: number,
  patch: Partial<IncidentDTO>,
  request: (version: number) => Promise<IncidentDTO>,
): Promise<IncidentDTO> {
  const base = serverCopies.get(id);
  if (!base || !entries.has(id)) throw new ApiError(0, 'not_loaded', 'That incident is not loaded.');
  const ep = epoch;
  // Optimistic: the patch is shown at once and does not change rev or version. Server truth replaces it when the request settles.
  const token = addPatch(id, patch);
  show(base);
  adjustPending(id, 1);

  let result: IncidentDTO;
  try {
    result = await request(base.version);
  } catch (err) {
    if (ep === epoch) {
      dropPatch(id, token);
      // Server truth from a 409 wins unless a newer live copy already arrived. Otherwise rebuild from the server copy.
      const current = err instanceof ApiError ? err.current : undefined;
      if (!current || !storeServer(current, true)) refresh(id);
      adjustPending(id, -1);
    }
    throw err;
  }
  if (ep === epoch) {
    dropPatch(id, token);
    if (!storeServer(result, false)) refresh(id);
    adjustPending(id, -1);
  }
  return result;
}

async function bulkAck(ids: number[], actor: { id: string; displayName: string }): Promise<BulkAckResult[]> {
  const ep = epoch;
  const items: { id: number; version: number; token: OptimisticPatch | null }[] = [];
  const ackedAt = Math.round(serverNow());
  for (const id of new Set(ids)) {
    const entry = entries.get(id);
    const base = serverCopies.get(id);
    if (!entry || !base) continue;
    let token: OptimisticPatch | null = null;
    if (entry.inc.status === 'open') {
      token = addPatch(id, { status: 'acked', ackedBy: actor.id, ackedAt, slaDueAt: null });
      show(base);
    }
    items.push({ id, version: base.version, token });
    adjustPending(id, 1);
  }

  const results: BulkAckResult[] = [];
  for (let i = 0; i < items.length; i += BULK_CHUNK) {
    if (ep !== epoch) break;
    const chunk = items.slice(i, i + BULK_CHUNK);
    let outcome: Map<number, BulkAckResult>;
    try {
      const body = await api<{ results: BulkAckResult[] }>('/api/incidents/bulk-ack', {
        method: 'POST',
        body: { items: chunk.map((item) => ({ id: item.id, version: item.version })) },
      });
      outcome = new Map(body.results.map((r) => [r.id, r] as const));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const code = err instanceof ApiError ? err.code : 'network';
      const message = messageOf(err);
      outcome = new Map(
        chunk.map((item) => [item.id, { id: item.id, ok: false, status, error: { code, message } }] as const),
      );
    }

    for (const item of chunk) {
      const result: BulkAckResult = outcome.get(item.id) ?? {
        id: item.id,
        ok: false,
        status: 0,
        error: { code: 'no_result', message: 'The server returned no result for this incident.' },
      };
      if (ep === epoch) {
        if (item.token) dropPatch(item.id, item.token);
        let landed = false;
        if (result.ok && result.incident) landed = storeServer(result.incident, false);
        else if (result.current) landed = storeServer(result.current, true);
        if (!landed) refresh(item.id);
        adjustPending(item.id, -1);
      }
      results.push(result);
    }
  }
  return results;
}

function clear(): void {
  generation += 1;
  epoch += 1;
  controller?.abort();
  controller = null;
  started = false;
  filters = {};
  order = [];
  nextCursor = null;
  total = null;
  listStatus = 'loading';
  listError = null;
  loadingMore = false;
  entries.clear();
  serverCopies.clear();
  optimistic.clear();
  changed();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getList(): ListState {
  return list;
}

function getEntry(id: number): Entry | undefined {
  return entries.get(id);
}

function onUpdate(listener: UpdateListener): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

/** The one store instance. Every method is a stable function, so useSyncExternalStore can take them directly. */
export const store = {
  subscribe,
  getList,
  getEntry,
  onUpdate,
  setFilters,
  loadMore,
  retry,
  resync,
  applyEvent,
  seed,
  mutate,
  bulkAck,
  clear,
};
