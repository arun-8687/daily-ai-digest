// Live stream connection (SSE on /api/stream) with reconnect, watchdog and auth check.
// Module scope never touches window or document. Those are read only inside start().
import type { IncidentEventData, StreamEventType } from '../../shared/types';
import { ApiError, api } from './api';
import { observeServerTime } from './clock';
import { store } from './store';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'signed-out';

/** No message for this long while live means the stream is stuck. The server pings every 15s. */
const WATCHDOG_MS = 40_000;
const WATCHDOG_TICK_MS = 5_000;
/** A tab that comes back to the foreground after this much silence reconnects. */
const VISIBLE_STALE_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Resync requests inside this window share one store.resync() call, so a flapping connection does not refetch each time. */
const RESYNC_COALESCE_MS = 500;

const NAMED_EVENTS = [
  'hello',
  'ping',
  'resync',
  'incident.created',
  'incident.updated',
  'incident.sla_breached',
] as const;

type Listener = () => void;

const listeners = new Set<Listener>();
let status: ConnStatus = 'signed-out';
let started = false;
let stream: EventSource | null = null;
let lastEventId: string | null = null;
let lastActivity = 0;
let backoffMs = BACKOFF_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/** Run id of the auth check in flight, or null. A check from an earlier run must not act on a newer session. */
let authCheckRun: number | null = null;
/** Bumped by every start and stop, so late callbacks from an earlier run can tell they are stale. */
let runId = 0;
let onAuthLost: (() => void) | null = null;
/** True once a resync has been requested for the stream that is open now. Reset by each open. */
let resyncedSinceOpen = false;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(next: ConnStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of [...listeners]) listener();
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Queues one store resync. Requests that arrive while it is queued are absorbed by it. */
function scheduleResync(): void {
  if (resyncTimer !== null) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    store.resync();
  }, RESYNC_COALESCE_MS);
}

function clearResync(): void {
  if (resyncTimer !== null) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }
}

/** One resync request per open stream. The server's `resync` event right after an open needs no second one. */
function resyncOnce(): void {
  if (resyncedSinceOpen) return;
  resyncedSinceOpen = true;
  scheduleResync();
}

/**
 * hello and ping carry the server clock. Their arrival time stands in for both ends of the round trip, so the estimate
 * carries the one-way latency as a small bias. That is accepted here; the API samples in api.ts are midpoint-corrected.
 * hello also carries the head seq. With no resume id yet, that head is the resume point: nothing is replayed on such an
 * open, so a later reconnect replays from head. With an id already set, the id stays, because a replay may still be in flight.
 */
function onFrame(type: 'hello' | 'ping', raw: unknown): void {
  let data: { serverTime?: unknown; head?: unknown } | null;
  try {
    data = JSON.parse(String(raw)) as { serverTime?: unknown; head?: unknown } | null;
  } catch {
    return;
  }
  if (typeof data?.serverTime === 'number') {
    const now = Date.now();
    observeServerTime(data.serverTime, now, now);
  }
  if (type === 'hello' && lastEventId === null && typeof data?.head === 'number' && Number.isSafeInteger(data.head) && data.head >= 0) {
    lastEventId = String(data.head);
  }
}

/** Moves to live. Coming back from any other state resyncs the store once. */
function goLive(resyncOnReturn: boolean): void {
  const was = status;
  setStatus('live');
  if (was !== 'live' && resyncOnReturn) resyncOnce();
}

function closeStream(): void {
  const source = stream;
  stream = null;
  if (source) {
    source.onopen = null;
    source.onerror = null;
    source.close();
  }
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function onMessage(type: string, ev: MessageEvent): void {
  lastActivity = Date.now();
  if (ev.lastEventId) lastEventId = ev.lastEventId;
  if (type === 'resync') {
    goLive(false);
    resyncOnce();
    return;
  }
  goLive(true);
  if (type === 'hello' || type === 'ping') {
    onFrame(type, ev.data);
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  store.applyEvent(type as StreamEventType, data as IncidentEventData);
}

function connect(): void {
  closeStream();
  if (typeof EventSource === 'undefined') {
    setStatus('offline');
    return;
  }
  const url = lastEventId === null ? '/api/stream' : `/api/stream?lastEventId=${encodeURIComponent(lastEventId)}`;
  const source = new EventSource(url);
  stream = source;
  lastActivity = Date.now();
  source.onopen = () => {
    if (stream !== source) return;
    backoffMs = BACKOFF_MIN_MS;
    resyncedSinceOpen = false;
    // With a Last-Event-ID the server replays every missed event (D12), or sends a `resync` event when it cannot. So an
    // id-bearing open needs no resync of its own. An open without one starts at head, and only a resync covers the gap.
    goLive(lastEventId === null);
  };
  source.onerror = () => {
    if (stream !== source) return;
    onStreamError(source);
  };
  for (const type of NAMED_EVENTS) {
    source.addEventListener(type, (ev) => {
      if (stream === source) onMessage(type, ev);
    });
  }
}

function onStreamError(source: EventSource): void {
  // CLOSED means the browser gave up, so the session may be gone. Check it first.
  if (source.readyState === EventSource.CLOSED) {
    void verifySession();
    return;
  }
  // Retry from here rather than letting the browser do it. The browser would send its own Last-Event-ID, which may not
  // match ours, and the no-resync rule on open depends on the id this module sends.
  closeStream();
  if (isOffline()) {
    setStatus('offline');
    return;
  }
  scheduleReconnect();
}

function lose(): void {
  const callback = onAuthLost;
  stopRealtime();
  callback?.();
}

async function verifySession(): Promise<void> {
  if (authCheckRun !== null) return;
  const run = runId;
  authCheckRun = run;
  closeStream();
  setStatus('reconnecting');
  let authLost = false;
  try {
    await api('/api/auth/me');
  } catch (err) {
    authLost = err instanceof ApiError && err.status === 401;
  }
  if (authCheckRun === run) authCheckRun = null;
  // The session was stopped or restarted while the check was in flight. Its answer is about the old session.
  if (run !== runId || !started) return;
  if (authLost) {
    lose();
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (!started || retryTimer !== null || stream !== null) return;
  setStatus('reconnecting');
  const delay = backoffMs;
  backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (started) connect();
  }, delay);
}

function reconnectNow(): void {
  if (!started || authCheckRun !== null) return;
  clearRetry();
  setStatus('reconnecting');
  connect();
}

function checkWatchdog(): void {
  if (status === 'live' && Date.now() - lastActivity > WATCHDOG_MS) reconnectNow();
}

function onOnline(): void {
  if (status !== 'live') reconnectNow();
}

function onOffline(): void {
  clearRetry();
  closeStream();
  setStatus('offline');
}

function onVisibility(): void {
  if (!started || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  if (stream !== null && Date.now() - lastActivity > VISIBLE_STALE_MS) reconnectNow();
}

function attachWindowListeners(): void {
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
}

function detachWindowListeners(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  }
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
}

function startRealtime(callback: () => void): void {
  onAuthLost = callback;
  if (started) return;
  started = true;
  runId += 1;
  authCheckRun = null;
  lastEventId = null;
  backoffMs = BACKOFF_MIN_MS;
  attachWindowListeners();
  watchdogTimer = setInterval(checkWatchdog, WATCHDOG_TICK_MS);
  if (isOffline()) {
    setStatus('offline');
    return;
  }
  setStatus('connecting');
  connect();
}

function stopRealtime(): void {
  started = false;
  runId += 1;
  authCheckRun = null;
  closeStream();
  clearRetry();
  clearResync();
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  detachWindowListeners();
  setStatus('signed-out');
}

export const realtime = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getStatus(): ConnStatus {
    return status;
  },
  /** Starts the stream. onAuthLost runs when the session is gone (401 on the auth check). */
  start(onLost: () => void): void {
    startRealtime(onLost);
  },
  stop(): void {
    stopRealtime();
  },
};
