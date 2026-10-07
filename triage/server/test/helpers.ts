import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriageApp, type TriageApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { manualClock, type ManualClock } from '../src/clock';
import { ensureDemoUsers } from '../src/users';

export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
export const MIN = 60_000;
export const TOKEN = 'test-ingest-token';

export function testConfig(dbPath: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dbPath,
    ingestToken: TOKEN,
    sessionTtlMs: 12 * 3_600_000,
    webDir: null,
    cookieSecure: false,
    sseHeartbeatMs: 60_000,
    sweepIntervalMs: 1_000,
    ...overrides,
  };
}

export interface Harness {
  app: TriageApp;
  clock: ManualClock;
  base: string;
  dbPath: string;
  cookies: Map<string, string>;
  cleanup(): Promise<void>;
}

/** Starts a real HTTP server on an ephemeral port with a file-backed database and a manual clock. */
export async function startHarness(opts: { dbPath?: string; start?: number; config?: Partial<AppConfig> } = {}): Promise<Harness> {
  const dir = opts.dbPath ? null : mkdtempSync(join(tmpdir(), 'triage-test-'));
  const dbPath = opts.dbPath ?? join(dir as string, 'test.db');
  const clock = manualClock(opts.start ?? T0);
  const app = createTriageApp(testConfig(dbPath, opts.config), { clock, timers: false });
  await ensureDemoUsers(app.ctx);
  const port = await app.start(0, '127.0.0.1');
  return {
    app,
    clock,
    base: `http://127.0.0.1:${port}`,
    dbPath,
    cookies: new Map(),
    async cleanup() {
      await app.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ApiResult<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export async function cookieFor(h: Harness, username: string): Promise<string> {
  const cached = h.cookies.get(username);
  if (cached) return cached;
  const res = await fetch(`${h.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'triage-demo' }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /triage_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error(`login failed for ${username}: ${res.status}`);
  const cookie = `triage_session=${m[1]}`;
  h.cookies.set(username, cookie);
  return cookie;
}

export async function api<T = any>(
  h: Harness,
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.as) headers.cookie = await cookieFor(h, opts.as);
  let payload: string | undefined;
  if (opts.raw !== undefined) {
    payload = opts.raw;
    headers['content-type'] ??= 'application/json';
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(h.base + path, { method, headers, body: payload });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, headers: res.headers, body };
}

export function alertBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'checkout',
    fingerprint: 'checkout-latency',
    severity: 'warning',
    title: 'p99 latency above 2s',
    payload: { region: 'eu-1' },
    ts: T0,
    ...over,
  };
}

export function ingest(h: Harness, body: Record<string, unknown>, key?: string): Promise<ApiResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (key !== undefined) headers['idempotency-key'] = key;
  return api(h, 'POST', '/ingest', { body, headers });
}

export interface SseEvent {
  id: number | null;
  event: string;
  data: any;
}

export interface SseClient {
  events: SseEvent[];
  status: number;
  waitFor(pred: (events: SseEvent[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Minimal SSE reader over fetch: enough to assert on ids, event names, and payloads. */
export async function openStream(h: Harness, as: string, lastEventId?: string | number): Promise<SseClient> {
  const controller = new AbortController();
  const headers: Record<string, string> = { cookie: await cookieFor(h, as), accept: 'text/event-stream' };
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const res = await fetch(`${h.base}/api/stream`, { headers, signal: controller.signal });
  const client: SseClient = {
    events: [],
    status: res.status,
    async waitFor(pred, timeoutMs = 3000) {
      const started = Date.now();
      while (!pred(client.events)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`timed out waiting on stream; events so far: ${JSON.stringify(client.events)}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      controller.abort();
    },
  };
  if (!res.body) return client;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let id: number | null = null;
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith(':') || line.startsWith('retry:')) continue;
            if (line.startsWith('id: ')) id = Number(line.slice(4));
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data !== '') client.events.push({ id, event, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted by close() */
    }
  })();
  return client;
}
