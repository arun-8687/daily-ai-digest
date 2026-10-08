import http from 'node:http';
import { type ManualClock, manualClock } from '../src/clock';
import { type AppConfig } from '../src/config';
import { type AppContext } from '../src/context';
import { createTriageApp, type TriageApp } from '../src/app';
import { DEMO_PASSWORD, ensureDemoUsers } from '../src/users';
import type { IncidentDTO, IngestResponse } from '../../shared/types';

export const T0 = Date.parse('2026-10-08T12:00:00.000Z');
export const MINUTE = 60_000;
export const TEST_INGEST_TOKEN = 'test-ingest-token';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dbPath: ':memory:',
    ingestToken: TEST_INGEST_TOKEN,
    sessionTtlMs: 12 * 3_600_000,
    webDir: null,
    cookieSecure: false,
    sseHeartbeatMs: 15_000,
    sweepIntervalMs: 1_000,
    ...overrides,
  };
}

export interface Harness {
  app: TriageApp;
  ctx: AppContext;
  clock: ManualClock;
  config: AppConfig;
  port: number;
  base: string;
  readers: Set<SseReader>;
  /** Opens a live SSE stream; it is closed automatically by close(). */
  stream(opts?: { cookie?: string; lastEventId?: string; query?: string }): Promise<SseReader>;
  close(): Promise<void>;
}

/** Starts an app on port 0 with a :memory: database, a manual clock, no timers and demo users. */
export async function startHarness(opts: { config?: Partial<AppConfig>; start?: number } = {}): Promise<Harness> {
  const config = testConfig(opts.config);
  const clock = manualClock(opts.start ?? T0);
  const app = createTriageApp(config, { clock, timers: false });
  await ensureDemoUsers(app.ctx);
  const port = await app.start(0, '127.0.0.1');
  const readers = new Set<SseReader>();
  const harness: Harness = {
    app,
    ctx: app.ctx,
    clock,
    config,
    port,
    base: `http://127.0.0.1:${port}`,
    readers,
    async stream(o = {}) {
      const headers: Record<string, string> = {};
      if (o.cookie) headers.Cookie = o.cookie;
      if (o.lastEventId !== undefined) headers['Last-Event-ID'] = o.lastEventId;
      const query = o.query ? `?${o.query}` : '';
      const reader = await SseReader.open(port, `/api/stream${query}`, headers);
      readers.add(reader);
      return reader;
    },
    async close() {
      for (const r of readers) r.close();
      readers.clear();
      await app.stop();
    },
  };
  return harness;
}

export interface CallOptions {
  cookie?: string;
  body?: unknown;
  /** Sent verbatim instead of JSON-encoding body. */
  rawBody?: string;
  contentType?: string;
  /** A number becomes "N"; a string is sent exactly as given (for W/"N" and malformed cases). */
  ifMatch?: number | string;
  headers?: Record<string, string>;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export async function call(h: Harness, method: string, path: string, opts: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.ifMatch !== undefined) {
    headers['If-Match'] = typeof opts.ifMatch === 'number' ? `"${opts.ifMatch}"` : opts.ifMatch;
  }
  let payload: string | undefined;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
    headers['Content-Type'] = opts.contentType ?? 'application/json';
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['Content-Type'] = opts.contentType ?? 'application/json';
  } else if (opts.contentType !== undefined) {
    headers['Content-Type'] = opts.contentType;
  }
  const res = await fetch(`${h.base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  if (text !== '') {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, headers: res.headers, text, json: json as any };
}

/** Logs in and returns the Cookie header value, e.g. "triage_session=...". */
export async function login(h: Harness, username: string, password: string = DEMO_PASSWORD): Promise<string> {
  const r = await call(h, 'POST', '/api/auth/login', { body: { username, password } });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${r.text}`);
  const setCookie = r.headers.getSetCookie()[0] ?? '';
  const pair = setCookie.split(';')[0];
  if (!pair) throw new Error('login returned no session cookie');
  return pair;
}

let alertCounter = 0;

export interface AlertFields {
  source?: string;
  fingerprint?: string;
  severity?: 'info' | 'warning' | 'critical';
  title?: string;
  ts?: number | string;
  payload?: Record<string, unknown>;
}

/** A valid alert body. Default fingerprint and title are unique, so each default alert is its own incident. */
export function alertBody(h: Harness, fields: AlertFields = {}): Record<string, unknown> {
  alertCounter += 1;
  return {
    source: 'payments-api',
    fingerprint: `fp-${alertCounter}`,
    severity: 'warning',
    title: `Alert number ${alertCounter}`,
    ts: h.clock.now(),
    ...fields,
  };
}

export async function ingest(
  h: Harness,
  body: Record<string, unknown>,
  opts: { key?: string; token?: string | null; contentType?: string; rawBody?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TEST_INGEST_TOKEN}`;
  if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
  return call(h, 'POST', '/ingest', {
    headers,
    body: opts.rawBody === undefined ? body : undefined,
    rawBody: opts.rawBody,
    contentType: opts.contentType,
  });
}

/** Ingests an alert and insists on 202. Returns the IngestResponse. */
export async function ingestOk(h: Harness, fields: AlertFields = {}): Promise<IngestResponse> {
  const r = await ingest(h, alertBody(h, fields));
  if (r.status !== 202) throw new Error(`ingest failed: ${r.status} ${r.text}`);
  return r.json as IngestResponse;
}

/** Creates an incident through ingest and returns its DTO. */
export async function createIncident(h: Harness, fields: AlertFields = {}): Promise<IncidentDTO> {
  return (await ingestOk(h, fields)).incident;
}

export interface SseEvent {
  /** null for frames without an id (hello, ping). */
  id: number | null;
  event: string;
  data: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

/** A minimal SSE client on node:http. It parses frames and keeps the raw bytes for header checks. */
export class SseReader {
  readonly events: SseEvent[] = [];
  /** Every byte received, so a test can check the exact start of the stream. */
  raw = '';
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  ended = false;
  private buffer = '';
  private req: http.ClientRequest | null = null;
  private res: http.IncomingMessage | null = null;

  static open(port: number, path: string, headers: Record<string, string>): Promise<SseReader> {
    const reader = new SseReader();
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          agent: false,
          headers: { Accept: 'text/event-stream', ...headers },
        },
        (res) => {
          reader.status = res.statusCode ?? 0;
          reader.headers = res.headers;
          reader.res = res;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => reader.feed(chunk));
          res.on('end', () => reader.markEnded());
          res.on('close', () => reader.markEnded());
          res.on('error', () => reader.markEnded());
          resolve(reader);
        },
      );
      reader.req = req;
      req.on('error', (err) => {
        reader.markEnded();
        if (reader.res === null) reject(err);
      });
      req.end();
    });
  }

  private feed(chunk: string): void {
    this.raw += chunk;
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.parseBlock(block);
      idx = this.buffer.indexOf('\n\n');
    }
  }

  private parseBlock(block: string): void {
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return; // retry-only blocks
    const text = data.join('\n');
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    this.events.push({ id: id === null ? null : Number(id), event, data: text, json });
  }

  private markEnded(): void {
    this.ended = true;
  }

  /** The events with a given type, in arrival order. */
  of(type: string): SseEvent[] {
    return this.events.filter((e) => e.event === type);
  }

  /** Waits (polling) until pred() is true, or throws after timeoutMs. */
  async waitUntil(pred: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) {
        const seen = this.events.map((e) => `${e.event}#${e.id ?? '-'}`).join(', ');
        throw new Error(`timed out waiting for ${label}; events so far: [${seen}]`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitEnd(timeoutMs = 3000): Promise<void> {
    await this.waitUntil(() => this.ended, timeoutMs, 'stream end');
  }

  close(): void {
    this.ended = true;
    this.req?.destroy();
    this.res?.destroy();
  }
}
