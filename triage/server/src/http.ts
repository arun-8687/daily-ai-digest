import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorBody } from '../../shared/types';
import type { AppContext } from './context';
import { HttpError } from './errors';
import { isPlainObject } from './util';
import type { AuthSession } from './auth';

export interface RequestContext {
  ctx: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Resolved lazily by the router-level auth helpers in routes.ts. */
  session: AuthSession | null;
  json(limit?: number): Promise<Record<string, unknown>>;
}

export type Handler = (c: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

export type Resolved = { handler: Handler; params: Record<string, string> } | 'method-not-allowed' | null;

/** Minimal router: `:name` segments, exact method match, 405 when only the method differs. */
export class Router {
  private readonly routes: Route[] = [];

  on(method: string, path: string, handler: Handler): void {
    const names: string[] = [];
    const source = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), names, handler });
  }

  resolve(method: string, pathname: string): Resolved {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.names.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? 'method-not-allowed' : null;
  }
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(new HttpError(413, 'payload_too_large', `Request body is larger than ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export async function readJsonObject(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const raw = await readBody(req, limit);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  return parsed;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.current) body.current = err.current;
    sendJson(res, err.status, body, err.status === 401 ? { 'WWW-Authenticate': 'Cookie' } : {});
    return;
  }
  console.error('[triage] unhandled error', err);
  sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server' } });
}
