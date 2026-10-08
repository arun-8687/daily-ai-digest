// Shared test harness for the HTTP API: a real server on port 0 with a manual clock, a fetch wrapper,
// a login helper, alert builders and an SSE reader.
import { createTriageApp, type TriageApp } from '../src/app';
import { manualClock, type ManualClock } from '../src/clock';
import { DEFAULT_INGEST_TOKEN, type AppConfig } from '../src/config';
import { ensureDemoUsers, DEMO_PASSWORD } from '../src/users';

export const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
export const MIN = 60_000;
export const SEC = 1_000;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dbPath: ':memory:',
    ingestToken: DEFAULT_INGEST_TOKEN,
    sessionTtlMs: 12 * 3_600_000,
    webDir: null,
    cookieSecure: false,
    sseHeartbeatMs: 15_000,
    sweepIntervalMs: 1_000,
    ...overrides,
  };
}

export interface TestServer {
  app: TriageApp;
  clock: ManualClock;
  port: number;
  base: string;
  close(): Promise<void>;
}

/** A real HTTP server on a free port with the demo users loaded. Timers are off, so the test drives sweeps itself. */
export async function startTestServer(
  options: { config?: Partial<AppConfig>; start?: number } = {},
): Promise<TestServer> {
  const clock = manualClock(options.start ?? T0);
  const app = createTriageApp(testConfig(options.config), { clock, timers: false });
  await ensureDemoUsers(app.ctx);
  const port = await app.start(0, '127.0.0.1');
  return {
    app,
    clock,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => app.stop(),
  };
}

export interface CallOptions {
  method?: string;
  /** Sent as a JSON body with Content-Type application/json. */
  json?: unknown;
  /** Sent as the raw body. */
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Full Cookie header value, for example "triage_session=abc". */
  cookie?: string;
  /** Raw If-Match header value. */
  ifMatch?: string;
  origin?: string;
  bearer?: string;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json: any;
}

export async function call(base: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;

  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] = 'application/json';
  }
  if (options.body !== undefined) body = options.body;
  if (options.contentType !== undefined) headers['content-type'] = options.contentType;

  const method = options.method ?? (body !== undefined ? 'POST' : 'GET');
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Extracts the "triage_session=..." pair from a Set-Cookie header. */
export function sessionPair(setCookie: string | null): string {
  const pair = setCookie?.split(';')[0];
  if (!pair || !pair.startsWith('triage_session=')) throw new Error(`no session cookie in ${setCookie}`);
  return pair;
}

/** Logs in and returns the cookie pair to send on later requests. */
export async function login(server: TestServer, username: string, password = DEMO_PASSWORD): Promise<string> {
  const reply = await call(server.base, '/api/auth/login', { json: { username, password } });
  if (reply.status !== 200) throw new Error(`login ${username} failed: ${reply.status} ${reply.text}`);
  return sessionPair(reply.headers.get('set-cookie'));
}

/** A valid alert body. ts defaults to the server's current manual time. */
export function alertBody(ts: number | string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'checkout-api',
    fingerprint: 'fp-disk-db1',
    severity: 'warning',
    title: 'Disk full on db-1',
    ts,
    payload: { host: 'db-1' },
    ...overrides,
  };
}

/** POST /ingest with the ingest bearer token (the default unless overridden). */
export function ingest(
  server: TestServer,
  body: unknown,
  options: { bearer?: string; idempotencyKey?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers = { ...(options.headers ?? {}) };
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  return call(server.base, '/ingest', {
    json: body,
    bearer: options.bearer ?? DEFAULT_INGEST_TOKEN,
    headers,
  });
}

/** Ingests one alert whose ts is the current manual time and returns the new incident. */
export async function createIncident(
  server: TestServer,
  overrides: Record<string, unknown> = {},
): Promise<{ id: number; version: number; incident: Record<string, any> }> {
  const reply = await ingest(server, alertBody(server.clock.now(), overrides));
  if (reply.status !== 202) throw new Error(`ingest failed: ${reply.status} ${reply.text}`);
  return { id: reply.json.incidentId, version: reply.json.incident.version, incident: reply.json.incident };
}

export interface SseEvent {
  /** The id: line, or undefined for events without one (hello, ping). */
  id?: number;
  event: string;
  data: string;
  json: any;
}

/** Reads a text/event-stream response in the background and keeps every parsed event. */
export class SseClient {
  readonly events: SseEvent[] = [];
  status = 0;
  contentType = '';
  /** True once the server has closed the stream (or the client aborted). */
  ended = false;

  private readonly controller = new AbortController();
  private buffer = '';

  private constructor() {}

  static async open(base: string, headers: Record<string, string>, query = ''): Promise<SseClient> {
    const client = new SseClient();
    const res = await fetch(`${base}/api/stream${query}`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: client.controller.signal,
    });
    client.status = res.status;
    client.contentType = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || res.body === null) {
      client.ended = true;
      await res.text().catch(() => undefined);
      return client;
    }
    void client.pump(res.body.getReader());
    return client;
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let end = this.buffer.indexOf('\n\n');
        while (end >= 0) {
          this.parseBlock(this.buffer.slice(0, end));
          this.buffer = this.buffer.slice(end + 2);
          end = this.buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted or reset
    } finally {
      this.ended = true;
    }
  }

  private parseBlock(block: string): void {
    let id: number | undefined;
    let event = 'message';
    const data: string[] = [];
    let sawField = false;
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') {
        id = Number(value);
        sawField = true;
      } else if (field === 'event') {
        event = value;
        sawField = true;
      } else if (field === 'data') {
        data.push(value);
        sawField = true;
      }
    }
    if (!sawField) return;
    const text = data.join('\n');
    this.events.push({ id, event, data: text, json: text === '' ? undefined : JSON.parse(text) });
  }

  /** Waits until pred(events) is true. Throws after timeoutMs. */
  async waitFor(pred: (events: SseEvent[]) => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.events)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out; events so far: ${JSON.stringify(this.events.map((e) => [e.id, e.event]))}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  ofType(type: string): SseEvent[] {
    return this.events.filter((e) => e.event === type);
  }

  close(): void {
    this.controller.abort();
    this.ended = true;
  }
}
