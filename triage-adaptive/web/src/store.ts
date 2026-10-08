import { ApiError, api, isAbortError, messageOf } from './api';
import { serverNow } from './clock';
import { matchesFilters, type Filters } from '../../shared/rules';
import type {
  BulkAckItem,
  BulkAckResult,
  IncidentDTO,
  IncidentEventData,
  ListResponse,
  StreamEventType,
} from '../../shared/types';

export const PAGE_SIZE = 100;
const MAX_RESYNC_ROWS = 1000;
const MAX_RESYNC_REQUESTS = 5;
const MAX_LIMIT = 200;
const BULK_CHUNK = 500;
const MAX_Q = 200;

/** One known incident. A new Entry object is created only when its content or pending count changes. */
export interface Entry {
  readonly inc: IncidentDTO;
  /** Number of writes in flight for this incident (drives the "Saving..." label). */
  readonly pending: number;
}

export interface ListState {
  readonly status: 'loading' | 'ready' | 'error';
  /** Set when the last load (first page, resync or loadMore) failed. */
  readonly error: string | null;
  readonly filters: Filters;
  /** Loaded incident ids, newest first. */
  readonly order: readonly number[];
  readonly nextCursor: string | null;
  /** Server total for the current filters. Known after a first page; null otherwise. */
  readonly total: number | null;
  readonly loadingMore: boolean;
}

type Listener = () => void;
type UpdateListener = (id: number | null, type: string) => void;

interface WriteOptions {
  /** Ignore the rev rule (server truth from a 409 or an optimistic patch). */
  force?: boolean;
  /** Explicit pending count; default keeps the stored one. */
  pending?: number;
  /** Store the incident without touching list membership or total (page merges). */
  quiet?: boolean;
  /** This write came from an incident.created event. */
  created?: boolean;
  /**
   * The copy is server truth observed now (a live event or a mutation response). Optimistic patches
   * and reverts are not observed. Observed writes are stamped so a resync can tell them apart.
   */
  observed?: boolean;
}

/** How a mutation ended, used to settle its optimistic copy. */
type Settlement =
  | { kind: 'merge'; inc: IncidentDTO }
  | { kind: 'force'; inc: IncidentDTO }
  | { kind: 'revert' }
  | { kind: 'none' };

/** The list request that failed last. retry() repeats exactly that step. */
type FailedStep = 'first' | 'more' | 'resync';

interface WindowFetch {
  rows: IncidentDTO[];
  nextCursor: string | null;
  total: number | null;
}

const listeners = new Set<Listener>();
const updateListeners = new Set<UpdateListener>();
let entries = new Map<number, Entry>();
let list: ListState = freshList({});
/** A first load has been started since the last clear(). */
let requested = false;
/** Bumped by setFilters, resync and clear. List responses from an older generation are dropped. */
let generation = 0;
let genAbort = new AbortController();
/** Bumped by clear(). Mutation results from an older epoch are not written. */
let epoch = 0;
/** Counter of server-observed writes (see WriteOptions.observed). */
let observedSeq = 0;
/**
 * The stamp of the last server-observed write for each incident. A resync keeps a loaded row that
 * the fetch did not return only when it was observed after that resync's request was issued. Older
 * copies are stale: had they matched on the server, the fetch would have returned them.
 */
const observedAt = new Map<number, number>();
/**
 * The lowest id covered by the loaded pages: the last row of the newest page. Every matching
 * incident with an id at or above this was either loaded or did not match when the page was read.
 * It only moves down on page loads, so an optimistic removal does not shrink the loaded range.
 */
let windowFloor: number | null = null;
/** Generation of the resync in flight, or -1. loadMore waits for it. */
let resyncGen = -1;
/** loadMore was asked for while a resync was in flight. It runs once that resync succeeds. */
let moreWanted = false;
/** The step that failed last. Cleared when a new step starts or a step succeeds. */
let failedStep: FailedStep | null = null;

function freshList(filters: Filters): ListState {
  return { status: 'loading', error: null, filters, order: [], nextCursor: null, total: null, loadingMore: false };
}

function emit(): void {
  for (const l of [...listeners]) l();
}

function setList(patch: Partial<ListState>): void {
  if (patch.order && sameIds(patch.order, list.order)) patch = { ...patch, order: list.order };
  const changed = (Object.keys(patch) as (keyof ListState)[]).some((k) => !Object.is(list[k], patch[k]));
  if (!changed) return;
  list = { ...list, ...patch };
  emit();
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sortDesc(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => b - a);
}

function sameIncident(a: IncidentDTO, b: IncidentDTO): boolean {
  const keys = Object.keys(a) as (keyof IncidentDTO)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function normalizeFilters(f: Filters): Filters {
  const out: Filters = {};
  if (f.status) out.status = f.status;
  if (f.severity) out.severity = f.severity;
  const assignee = f.assignee?.trim();
  if (assignee) out.assignee = assignee;
  const q = f.q?.trim().slice(0, MAX_Q);
  if (q) out.q = q;
  return out;
}

function sameFilters(a: Filters, b: Filters): boolean {
  return a.status === b.status && a.severity === b.severity && a.assignee === b.assignee && a.q === b.q;
}

function matches(inc: IncidentDTO): boolean {
  return matchesFilters(inc, list.filters);
}

/** Index of the first id <= id in the newest-first order (the insertion point when absent). */
function insertionPoint(order: readonly number[], id: number): number {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (order[mid] > id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * True when a matching incident with this id belongs inside the loaded range. With the whole list
 * loaded every id qualifies. Otherwise the id must be at or above the window floor, which stays put
 * even when the row that set it is removed from the order.
 */
function inLoadedRange(id: number): boolean {
  if (list.nextCursor === null) return true;
  return windowFloor !== null && id >= windowFloor;
}

function reconcileMembership(id: number, nowMatch: boolean): void {
  const order = list.order;
  const at = insertionPoint(order, id);
  const present = at < order.length && order[at] === id;
  if (nowMatch) {
    // Below the loaded range the row belongs to a page that is not loaded yet; loadMore will add it.
    if (present || !inLoadedRange(id)) return;
    setList({ order: [...order.slice(0, at), id, ...order.slice(at)] });
  } else if (present) {
    setList({ order: [...order.slice(0, at), ...order.slice(at + 1)] });
  }
}

/**
 * Keeps total and list membership in step with a stored change.
 * An incident the store has never seen (prevInc undefined) is counted only when it is a new
 * incident (created) or lies inside the loaded range. Below that range it may already be counted
 * in total, so it is left alone.
 */
function reconcile(prevInc: IncidentDTO | undefined, next: IncidentDTO, created: boolean): void {
  const nowMatch = matches(next);
  const total = list.total;
  if (total !== null) {
    if (prevInc) {
      if (matches(prevInc) !== nowMatch) setList({ total: Math.max(0, total + (nowMatch ? 1 : -1)) });
    } else if (nowMatch && (created || inLoadedRange(next.id))) {
      setList({ total: total + 1 });
    }
  }
  reconcileMembership(next.id, nowMatch);
}

/**
 * Stores an incident. Without force, an incoming copy with rev <= the stored rev is ignored.
 * Returns false when it was ignored as stale.
 */
function writeIncident(incoming: IncidentDTO, opts: WriteOptions = {}): boolean {
  const prev = entries.get(incoming.id);
  if (prev && !opts.force && incoming.rev <= prev.inc.rev) return false;
  if (opts.observed) observedAt.set(incoming.id, ++observedSeq);
  const inc = prev && sameIncident(prev.inc, incoming) ? prev.inc : incoming;
  const pending = opts.pending ?? prev?.pending ?? 0;
  const changed = !prev || inc !== prev.inc || pending !== prev.pending;
  if (!changed) return true;
  entries.set(incoming.id, { inc, pending });
  if (!opts.quiet) reconcile(prev?.inc, inc, opts.created === true);
  emit();
  return true;
}

function setPending(id: number, delta: number): void {
  const e = entries.get(id);
  if (!e) return;
  entries.set(id, { inc: e.inc, pending: Math.max(0, e.pending + delta) });
  emit();
}

/**
 * One optimistic write in flight. `pre` holds the value each patched field had when the write
 * started (which may itself be another in-flight write's optimistic value).
 */
interface Inflight {
  readonly patch: Record<string, unknown>;
  readonly pre: Record<string, unknown>;
}

/** In-flight optimistic writes per incident, oldest first. */
const inflight = new Map<number, Inflight[]>();

function beginInflight(id: number, base: IncidentDTO, patch: Partial<IncidentDTO>): Inflight {
  const p = patch as Record<string, unknown>;
  const pre: Record<string, unknown> = {};
  for (const k of Object.keys(p)) pre[k] = (base as unknown as Record<string, unknown>)[k];
  const m: Inflight = { patch: p, pre };
  const list = inflight.get(id);
  if (list) list.push(m);
  else inflight.set(id, [m]);
  return m;
}

/** Removes a write from the in-flight list and returns the writes that started after it. */
function endInflight(id: number, m: Inflight): Inflight[] {
  const list = inflight.get(id);
  if (!list) return [];
  const at = list.indexOf(m);
  if (at < 0) return [];
  list.splice(at, 1);
  const later = list.slice(at);
  if (list.length === 0) inflight.delete(id);
  return later;
}

/**
 * Rolls back only the fields this write patched, and only those still showing its value. A
 * concurrent write on the same incident keeps its own optimistic fields. When a later write patched
 * the same field, that write now rolls back to this write's pre-value instead.
 */
function revertInflight(id: number, m: Inflight, later: Inflight[], pre: IncidentDTO): void {
  const overridden = new Set<string>();
  for (const k of Object.keys(m.patch)) {
    const next = later.find((l) => k in l.patch);
    if (next) {
      next.pre[k] = m.pre[k];
      overridden.add(k);
    }
  }
  const e = entries.get(id);
  if (!e || e.inc.rev !== pre.rev) return;
  const cur = e.inc as unknown as Record<string, unknown>;
  const reverted: Record<string, unknown> = { ...cur };
  for (const k of Object.keys(m.patch)) {
    if (!overridden.has(k) && Object.is(cur[k], m.patch[k])) reverted[k] = m.pre[k];
  }
  writeIncident(reverted as unknown as IncidentDTO, { force: true });
}

function settle(id: number, s: Settlement, pre: IncidentDTO, m: Inflight): void {
  const later = endInflight(id, m);
  const e = entries.get(id);
  if (s.kind === 'merge') {
    writeIncident(s.inc, { observed: true });
  } else if (s.kind === 'force') {
    // A 409 copy must not roll back a newer live copy. The optimistic copy (still at the rev from
    // before the write) always gives way to it.
    if (!e || e.inc.rev === pre.rev || s.inc.rev >= e.inc.rev) writeIncident(s.inc, { force: true, observed: true });
  } else if (s.kind === 'revert') {
    revertInflight(id, m, later, pre);
  }
  setPending(id, -1);
}

function fetchPage(filters: Filters, cursor: string | null, limit: number, signal: AbortSignal): Promise<ListResponse> {
  const q = new URLSearchParams();
  if (filters.status) q.set('status', filters.status);
  if (filters.severity) q.set('severity', filters.severity);
  if (filters.assignee) q.set('assignee', filters.assignee);
  if (filters.q) q.set('q', filters.q);
  if (cursor !== null) q.set('cursor', cursor);
  q.set('limit', String(limit));
  return api<ListResponse>(`/api/incidents?${q.toString()}`, { signal }).then((res) => {
    const valid =
      typeof res === 'object' &&
      res !== null &&
      Array.isArray(res.items) &&
      res.items.every((r) => typeof r?.id === 'number');
    if (!valid) throw new ApiError(502, 'bad_response', 'The server sent an unexpected response. Try again.');
    return res;
  });
}

/** Starts a new list generation: aborts the old one and drops its responses. */
function bump(): number {
  genAbort.abort();
  genAbort = new AbortController();
  generation += 1;
  failedStep = null;
  setList({ loadingMore: false });
  return generation;
}

/** Records a failed list step and shows its error. */
function failWith(step: FailedStep, err: unknown): void {
  failedStep = step;
  const error = messageOf(err);
  if (step === 'first') setList({ status: 'error', error, loadingMore: false });
  else if (step === 'more') setList({ loadingMore: false, error });
  else setList(list.order.length === 0 ? { status: 'error', error } : { error });
}

/**
 * Replaces the loaded rows with a fetched window. `sinceSeq` is the observed-write counter when the
 * request was issued. A row the fetch did not return is kept only when all of these hold: it still
 * matches, it was observed after that point (created or changed while the request was in flight or
 * later), and it lies above the fetched head (id > the new window floor) or the fetch reached the
 * end of the list. A row at or below the floor that the fetch skipped belongs to a page that is not
 * loaded, and a row observed before the request that the server no longer returns is stale.
 * Kept rows were not counted by the server's total, so they are added to it. A returned row that the
 * rev rule kept as a non-matching local copy was counted by the server and is subtracted.
 */
function replaceRows(rows: IncidentDTO[], nextCursor: string | null, total: number | null, sinceSeq: number): void {
  for (const r of rows) writeIncident(r, { quiet: true });
  const fetched: number[] = [];
  let staleCounted = 0;
  for (const r of rows) {
    const e = entries.get(r.id);
    if (!e) continue;
    if (matches(e.inc)) fetched.push(r.id);
    else staleCounted += 1;
  }
  const floor = rows.length > 0 ? Math.min(...rows.map((r) => r.id)) : null;
  const fetchedSet = new Set(fetched);
  const kept = list.order.filter((id) => {
    if (fetchedSet.has(id)) return false;
    if (nextCursor !== null && (floor === null || id <= floor)) return false;
    if ((observedAt.get(id) ?? -1) <= sinceSeq) return false;
    const e = entries.get(id);
    return !!e && matches(e.inc);
  });
  // Stamps at or before this request can never be kept by a later request, so drop them.
  for (const [id, seq] of observedAt) if (seq <= sinceSeq) observedAt.delete(id);
  windowFloor = floor;
  failedStep = null;
  setList({
    order: sortDesc([...kept, ...fetched]),
    nextCursor,
    total: total === null ? list.total : Math.max(0, total - staleCounted + kept.length),
    status: 'ready',
    error: null,
    loadingMore: false,
  });
}

function appendRows(rows: IncidentDTO[], nextCursor: string | null): void {
  for (const r of rows) writeIncident(r, { quiet: true });
  const ids = rows.map((r) => r.id).filter((id) => {
    const e = entries.get(id);
    return !!e && matches(e.inc);
  });
  if (rows.length > 0) windowFloor = Math.min(...rows.map((r) => r.id));
  failedStep = null;
  setList({
    order: sortDesc([...list.order, ...ids]),
    nextCursor,
    status: 'ready',
    error: null,
    loadingMore: false,
  });
}

function loadFirstPage(filters: Filters): void {
  const g = bump();
  requested = true;
  windowFloor = null;
  moreWanted = false;
  setList({ filters, status: 'loading', error: null, order: [], nextCursor: null, total: null, loadingMore: false });
  const sinceSeq = observedSeq;
  fetchPage(filters, null, PAGE_SIZE, genAbort.signal)
    .then((res) => {
      if (g === generation) replaceRows(res.items, res.nextCursor, res.total, sinceSeq);
    })
    .catch((err: unknown) => {
      if (g === generation && !isAbortError(err)) failWith('first', err);
    });
}

/**
 * Fetches the head window for a resync: at least one page, at most `target` rows, at most
 * MAX_RESYNC_REQUESTS requests. Returns null when the generation was superseded meanwhile.
 */
async function fetchWindow(
  filters: Filters,
  target: number,
  limit: number,
  signal: AbortSignal,
  g: number,
): Promise<WindowFetch | null> {
  const rows: IncidentDTO[] = [];
  let cursor: string | null = null;
  let requests = 0;
  let total: number | null = null;
  for (;;) {
    const res = await fetchPage(filters, cursor, Math.min(limit, target - rows.length), signal);
    if (g !== generation) return null;
    if (requests === 0) total = res.total;
    requests += 1;
    rows.push(...res.items);
    if (!res.nextCursor || res.items.length === 0 || rows.length >= target || requests >= MAX_RESYNC_REQUESTS) {
      return { rows, nextCursor: res.nextCursor, total };
    }
    cursor = res.nextCursor;
  }
}

/**
 * Re-fetches the loaded window (at least one page, at most 1000 rows, at most 5 requests).
 * Rows that changed on the server are replaced. A loaded row the server no longer returns is dropped,
 * unless it was changed by a live event after this request was issued (see replaceRows).
 * Does nothing before the first page has been requested.
 */
async function runResync(): Promise<void> {
  if (!requested) return;
  const g = bump();
  resyncGen = g;
  const filters = list.filters;
  const target = Math.min(MAX_RESYNC_ROWS, Math.max(PAGE_SIZE, list.order.length));
  const limit = Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, Math.ceil(target / MAX_RESYNC_REQUESTS)));
  if (list.order.length === 0) setList({ status: 'loading', error: null });

  const sinceSeq = observedSeq;
  let result: WindowFetch | null;
  try {
    result = await fetchWindow(filters, target, limit, genAbort.signal, g);
  } catch (err) {
    if (resyncGen === g) resyncGen = -1;
    if (g === generation && !isAbortError(err)) {
      moreWanted = false;
      failWith('resync', err);
    }
    return;
  }
  if (resyncGen === g) resyncGen = -1;
  if (g !== generation || result === null) return;
  replaceRows(result.rows, result.nextCursor, result.total, sinceSeq);
  for (const l of [...updateListeners]) l(null, 'resync');
  const more = moreWanted;
  moreWanted = false;
  if (more) store.loadMore();
}

async function runMutation(
  id: number,
  patch: Partial<IncidentDTO>,
  request: (version: number) => Promise<IncidentDTO>,
): Promise<IncidentDTO> {
  const pre = entries.get(id);
  if (!pre) throw new Error('This incident is not loaded.');
  const preInc = pre.inc;
  const e0 = epoch;
  const m = beginInflight(id, preInc, patch);
  writeIncident({ ...preInc, ...patch } as IncidentDTO, { force: true, pending: pre.pending + 1 });

  let result: IncidentDTO;
  try {
    result = await request(preInc.version);
  } catch (err) {
    if (epoch === e0) {
      if (err instanceof ApiError && err.current) settle(id, { kind: 'force', inc: err.current }, preInc, m);
      else settle(id, { kind: 'revert' }, preInc, m);
    }
    throw err;
  }
  if (epoch === e0) settle(id, { kind: 'merge', inc: result }, preInc, m);
  return result;
}

/** Describes a failed bulk request as a failed result for each id it covered. */
function failureOf(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof ApiError) return { status: err.status, code: err.code, message: err.message };
  return { status: 0, code: 'unexpected', message: messageOf(err) };
}

async function runBulkAck(ids: number[], actor: { id: string; displayName: string }): Promise<BulkAckResult[]> {
  const e0 = epoch;
  const pre = new Map<number, IncidentDTO>();
  const muts = new Map<number, Inflight>();
  const items: BulkAckItem[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    const e = entries.get(id);
    if (!e || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, version: e.inc.version });
    pre.set(id, e.inc);
    const patch: Partial<IncidentDTO> =
      e.inc.status === 'open' ? { status: 'acked' as const, ackedBy: actor.id, ackedAt: serverNow() } : {};
    muts.set(id, beginInflight(id, e.inc, patch));
    writeIncident({ ...e.inc, ...patch }, { force: true, pending: e.pending + 1 });
  }
  if (items.length === 0) return [];

  const unsettled = new Set(items.map((i) => i.id));
  const results: BulkAckResult[] = [];
  /** Settles the listed ids that are still unsettled as failures and rolls their optimistic copies back. */
  const failIds = (targets: readonly number[], status: number, code: string, message: string): void => {
    for (const id of targets) {
      if (!unsettled.delete(id)) continue;
      results.push({ id, ok: false, status, error: { code, message } });
      if (epoch === e0) settle(id, { kind: 'revert' }, pre.get(id) as IncidentDTO, muts.get(id) as Inflight);
    }
  };

  for (let i = 0; i < items.length; i += BULK_CHUNK) {
    const chunk = items.slice(i, i + BULK_CHUNK);
    let got: BulkAckResult[];
    try {
      const res = await api<{ results: BulkAckResult[] }>('/api/incidents/bulk-ack', {
        method: 'POST',
        body: { items: chunk },
      });
      got = Array.isArray(res?.results) ? res.results : [];
    } catch (err) {
      // Later chunks are not sent. Their ids settle as failures together with this one.
      const failure = failureOf(err);
      failIds(
        items.slice(i).map((x) => x.id),
        failure.status,
        failure.code,
        failure.message,
      );
      break;
    }
    for (const r of got) {
      if (!r || typeof r !== 'object' || !unsettled.has(r.id)) continue;
      unsettled.delete(r.id);
      results.push(r);
      if (epoch !== e0) continue;
      const p = pre.get(r.id) as IncidentDTO;
      const m = muts.get(r.id) as Inflight;
      if (r.ok && r.incident) settle(r.id, { kind: 'merge', inc: r.incident }, p, m);
      else if (!r.ok && r.current) settle(r.id, { kind: 'force', inc: r.current }, p, m);
      else if (r.ok) settle(r.id, { kind: 'none' }, p, m);
      else settle(r.id, { kind: 'revert' }, p, m);
    }
    // An id the server did not report on is a failure, not a silent revert.
    failIds(
      chunk.map((x) => x.id),
      0,
      'no_result',
      'The server did not report a result for this incident.',
    );
  }
  return results;
}

export const store = {
  /** Stable identity: safe as a useSyncExternalStore subscribe function. */
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },

  getList(): ListState {
    return list;
  },

  getEntry(id: number): Entry | undefined {
    return entries.get(id);
  },

  /** Fires after each live event (with its id) and after a resync (with null). */
  onUpdate(l: UpdateListener): () => void {
    updateListeners.add(l);
    return () => {
      updateListeners.delete(l);
    };
  },

  setFilters(next: Filters): void {
    const filters = normalizeFilters(next);
    if (requested && sameFilters(filters, list.filters)) return;
    loadFirstPage(filters);
  },

  loadMore(): void {
    if (!requested || list.loadingMore || list.status !== 'ready' || list.nextCursor === null) return;
    // A failed page stays failed until retry() asks again, so a scroll effect cannot loop on a failing server.
    if (failedStep === 'more') return;
    // The loaded window is being replaced. Take the next page once the new cursor is known.
    if (resyncGen === generation) {
      moreWanted = true;
      return;
    }
    const g = generation;
    const cursor = list.nextCursor;
    const filters = list.filters;
    failedStep = null;
    setList({ loadingMore: true, error: null });
    fetchPage(filters, cursor, PAGE_SIZE, genAbort.signal)
      .then((res) => {
        if (g === generation) appendRows(res.items, res.nextCursor);
      })
      .catch((err: unknown) => {
        if (g === generation && !isAbortError(err)) failWith('more', err);
      });
  },

  /** Repeats the step that failed: the first page, the next page, or the resync. */
  retry(): void {
    if (!requested) {
      loadFirstPage(list.filters);
      return;
    }
    if (failedStep === 'resync') {
      store.resync();
      return;
    }
    if (failedStep === 'more') {
      failedStep = null;
      store.loadMore();
      return;
    }
    if (list.status === 'error' || failedStep === 'first') loadFirstPage(list.filters);
  },

  resync(): void {
    void runResync();
  },

  applyEvent(type: StreamEventType, data: IncidentEventData): void {
    if (type !== 'incident.created' && type !== 'incident.updated' && type !== 'incident.sla_breached') return;
    const incoming = data?.incident;
    if (!incoming || typeof incoming.id !== 'number') return;
    writeIncident(incoming, { created: type === 'incident.created', observed: true });
    for (const l of [...updateListeners]) l(incoming.id, type);
  },

  /** Stores a deep-linked incident that is not part of the list. It does not join the list or change total. */
  seed(inc: IncidentDTO): void {
    writeIncident(inc, { quiet: true });
  },

  /**
   * Optimistic write. Applies the patch at once (pending + 1) and calls request(version).
   * On success the server copy is merged. On a 409 with `current` the server copy is forced in.
   * On any other failure the pre-patch copy is restored, unless a newer rev arrived meanwhile.
   * The error is rethrown.
   */
  mutate(
    id: number,
    patch: Partial<IncidentDTO>,
    request: (version: number) => Promise<IncidentDTO>,
  ): Promise<IncidentDTO> {
    return runMutation(id, patch, request);
  },

  /**
   * Acks every selected loaded id with its version. Open ones are acked optimistically.
   * Never rejects: every id gets a result, and ids the request did not settle are reported as failures.
   */
  bulkAck(ids: number[], actor: { id: string; displayName: string }): Promise<BulkAckResult[]> {
    return runBulkAck(ids, actor);
  },

  /** Drops everything (sign-out or session end) and invalidates in-flight work. */
  clear(): void {
    bump();
    epoch += 1;
    requested = false;
    entries = new Map();
    observedAt.clear();
    inflight.clear();
    windowFloor = null;
    moreWanted = false;
    resyncGen = -1;
    list = freshList({});
    emit();
  },
};
