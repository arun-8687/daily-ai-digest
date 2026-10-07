// Live connection to /api/stream. EventSource reconnects on its own and resends
// Last-Event-ID, so the server replays exactly what was missed. This module adds the
// things EventSource does not do: a watchdog for silent stalls, backoff when the browser
// gives up, a session check when the stream is refused, and a resync when we come back.
import { api, ApiError } from './api';
import { store } from './store';
import { toast } from './toasts';
import type { IncidentEventData, StreamEventType } from '../../shared/types';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'signed-out';

const EVENT_TYPES: StreamEventType[] = ['incident.created', 'incident.updated', 'incident.sla_breached'];
const STALL_MS = 40_000;

class Realtime {
  private es: EventSource | null = null;
  private lastEventId: string | null = null;
  private status: ConnStatus = 'signed-out';
  private readonly listeners = new Set<() => void>();
  private running = false;
  private everLive = false;
  private lastActivity = 0;
  private backoffMs = 1000;
  private retryTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private onAuthLost: (() => void) | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getStatus = (): ConnStatus => this.status;

  start(onAuthLost: () => void): void {
    if (this.running) return;
    this.running = true;
    this.onAuthLost = onAuthLost;
    this.everLive = false;
    this.lastEventId = null;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.watchdogTimer = window.setInterval(this.checkStall, 5_000);
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.es?.close();
    this.es = null;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.watchdogTimer);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.setStatus('signed-out');
  }

  private setStatus(next: ConnStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const l of this.listeners) l();
  }

  private connect(): void {
    if (!this.running) return;
    this.es?.close();
    window.clearTimeout(this.retryTimer);
    const url = this.lastEventId ? `/api/stream?lastEventId=${encodeURIComponent(this.lastEventId)}` : '/api/stream';
    const es = new EventSource(url);
    this.es = es;
    this.lastActivity = Date.now();
    this.setStatus(this.everLive ? 'reconnecting' : 'connecting');

    es.onopen = () => {
      this.lastActivity = Date.now();
      this.backoffMs = 1000;
      const wasDown = this.everLive && this.status !== 'live';
      this.everLive = true;
      this.setStatus('live');
      if (wasDown) store.resync();
    };
    es.addEventListener('hello', this.touch);
    es.addEventListener('ping', this.touch);
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => this.onIncidentEvent(type, e as MessageEvent));
    }
    es.addEventListener('resync', (e) => {
      this.touch(e as MessageEvent);
      store.resync();
    });
    es.onerror = () => {
      if (es !== this.es) return;
      if (es.readyState === EventSource.CLOSED) {
        void this.fatal();
      } else {
        this.setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      }
    };
  }

  private touch = (e?: Event): void => {
    this.lastActivity = Date.now();
    const id = (e as MessageEvent | undefined)?.lastEventId;
    if (id) this.lastEventId = id;
  };

  private onIncidentEvent(type: StreamEventType, e: MessageEvent): void {
    this.touch(e);
    const data = JSON.parse(e.data) as IncidentEventData;
    store.applyEvent(type, data);
    if (type === 'incident.sla_breached') {
      toast('error', `SLA breached: INC-${data.incident.id} is critical and was not acked within 5 minutes.`);
    }
  }

  /** EventSource gave up. Usually the session has expired, so check before retrying. */
  private async fatal(): Promise<void> {
    this.es = null;
    try {
      await api('/api/auth/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.stop();
        this.onAuthLost?.();
        return;
      }
    }
    if (!this.running) return;
    this.setStatus('reconnecting');
    this.retryTimer = window.setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  /** Catches a connection that looks open but has stopped delivering (for example, after a laptop sleep). */
  private checkStall = (): void => {
    if (this.status === 'live' && Date.now() - this.lastActivity > STALL_MS) {
      this.setStatus('reconnecting');
      this.connect();
    }
  };

  private onOnline = (): void => {
    if (this.status !== 'live') this.connect();
  };

  private onOffline = (): void => {
    if (this.running) this.setStatus('offline');
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.running) {
      if (Date.now() - this.lastActivity > 20_000) this.connect();
      store.resync();
    }
  };
}

export const realtime = new Realtime();
