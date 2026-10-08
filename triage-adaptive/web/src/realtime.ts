import { ApiError, api } from './api';
import { store } from './store';
import type { IncidentEventData, StreamEventType } from '../../shared/types';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'signed-out';

const STREAM_PATH = '/api/stream';
const WATCHDOG_MS = 40_000;
const IDLE_CHECK_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const NAMED_EVENTS = [
  'hello',
  'ping',
  'resync',
  'incident.created',
  'incident.updated',
  'incident.sla_breached',
] as const;

type Listener = () => void;

let status: ConnStatus = 'connecting';
let started = false;
let onAuthLost: (() => void) | null = null;
let source: EventSource | null = null;
let lastEventId: string | null = null;
/** The stream has been live at least once since start(). */
let hasBeenLive = false;
let backoffMs = BACKOFF_MIN_MS;
let lastActivity = 0;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let checkingAuth = false;
/** Bumped by start() and stop(). An async step that began in an older session must not act. */
let sessionEpoch = 0;
let windowAttached = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function clearWatchdog(): void {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function armWatchdog(): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (started && status === 'live') reconnectNow();
  }, WATCHDOG_MS);
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function setStatus(next: ConnStatus): void {
  if (next === status) return;
  status = next;
  if (next === 'live') {
    armWatchdog();
  } else {
    clearWatchdog();
  }
  notify();
  if (next === 'live') {
    // Events may have been missed while the stream was not live, including before the first connect
    // (the stream starts at head with no replay, so anything between the first page read and the hello
    // is lost). Resync on every non-live -> live transition, even if that duplicates a first-page load.
    hasBeenLive = true;
    store.resync();
  }
}

function closeSource(): void {
  if (source) {
    const s = source;
    source = null;
    s.close();
  }
}

function markActivity(): void {
  lastActivity = Date.now();
  if (status === 'live') armWatchdog();
}

function openSource(): void {
  closeSource();
  if (!started) return;
  if (isOffline()) {
    setStatus('offline');
    return;
  }
  const url = lastEventId ? `${STREAM_PATH}?lastEventId=${encodeURIComponent(lastEventId)}` : STREAM_PATH;
  const es = new EventSource(url);
  source = es;
  lastActivity = Date.now();
  setStatus(hasBeenLive ? 'reconnecting' : 'connecting');
  es.onerror = () => {
    if (source === es) onStreamError(es);
  };
  for (const type of NAMED_EVENTS) {
    es.addEventListener(type, (ev) => {
      if (source === es) onStreamEvent(type, ev);
    });
  }
}

function onStreamEvent(type: (typeof NAMED_EVENTS)[number], ev: MessageEvent): void {
  markActivity();
  if (ev.lastEventId) lastEventId = ev.lastEventId;
  switch (type) {
    case 'hello':
      backoffMs = BACKOFF_MIN_MS;
      setStatus('live');
      return;
    case 'ping':
      return;
    case 'resync':
      store.resync();
      return;
    default: {
      let data: IncidentEventData;
      try {
        data = JSON.parse(String(ev.data)) as IncidentEventData;
      } catch {
        store.resync();
        return;
      }
      store.applyEvent(type as StreamEventType, data);
    }
  }
}

function onStreamError(es: EventSource): void {
  if (es.readyState === EventSource.CLOSED) {
    closeSource();
    void recoverFromClosed();
    return;
  }
  // The browser is retrying by itself and sends Last-Event-ID.
  setStatus(hasBeenLive ? 'reconnecting' : 'connecting');
}

/** A CLOSED EventSource means the server refused the stream. Check the session before retrying. */
async function recoverFromClosed(): Promise<void> {
  if (!started || checkingAuth) return;
  checkingAuth = true;
  const epoch = sessionEpoch;
  // The stream is not live while the session check is pending, so the badge must not still say Live.
  setStatus(hasBeenLive ? 'reconnecting' : 'connecting');
  let authLost = false;
  try {
    await api('/api/auth/me');
  } catch (err) {
    authLost = err instanceof ApiError && err.status === 401;
  } finally {
    if (epoch === sessionEpoch) checkingAuth = false;
  }
  if (!started || epoch !== sessionEpoch) return;
  if (authLost) {
    expireAuth();
    return;
  }
  // A manual reconnect (online, visible tab, watchdog) may have opened a source meanwhile, or the
  // browser went offline. Retrying now would tear down a healthy stream or repeat a retry already queued.
  if (source !== null || retryTimer !== null || status === 'offline') return;
  scheduleRetry();
}

function scheduleRetry(): void {
  if (!started) return;
  clearRetry();
  if (isOffline()) {
    setStatus('offline');
    return;
  }
  setStatus(hasBeenLive ? 'reconnecting' : 'connecting');
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    openSource();
  }, delay);
}

function reconnectNow(): void {
  clearRetry();
  openSource();
}

function expireAuth(): void {
  const cb = onAuthLost;
  stop();
  cb?.();
}

function onOnline(): void {
  if (!started || status === 'live') return;
  reconnectNow();
}

function onOffline(): void {
  if (!started) return;
  closeSource();
  clearRetry();
  setStatus('offline');
}

function onVisibilityChange(): void {
  if (!started || document.visibilityState !== 'visible') return;
  if (status === 'offline' || status === 'signed-out') return;
  if (Date.now() - lastActivity > IDLE_CHECK_MS) reconnectNow();
}

function attachWindow(): void {
  if (windowAttached || typeof window === 'undefined') return;
  windowAttached = true;
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function detachWindow(): void {
  if (!windowAttached || typeof window === 'undefined') return;
  windowAttached = false;
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getStatus(): ConnStatus {
  return status;
}

/** Opens the live stream. onAuthLost runs after the session is found to have ended (the stream is stopped first). */
function start(onLost: () => void): void {
  onAuthLost = onLost;
  if (started) return;
  started = true;
  sessionEpoch += 1;
  checkingAuth = false;
  lastEventId = null;
  hasBeenLive = false;
  backoffMs = BACKOFF_MIN_MS;
  attachWindow();
  if (isOffline()) {
    setStatus('offline');
    return;
  }
  openSource();
}

/** Closes the stream and stops reconnecting. Status becomes 'signed-out'. */
function stop(): void {
  started = false;
  sessionEpoch += 1;
  checkingAuth = false;
  onAuthLost = null;
  closeSource();
  clearRetry();
  clearWatchdog();
  detachWindow();
  lastEventId = null;
  hasBeenLive = false;
  backoffMs = BACKOFF_MIN_MS;
  setStatus('signed-out');
}

export const realtime = { subscribe, getStatus, start, stop };
