// HTTP plumbing: a tiny router with :param segments (405 when only the method is wrong), JSON body reading
// (415 for a non-JSON type, 413 over 64 KB, 400 for invalid JSON), JSON replies, cookies and If-Match parsing (D5).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorBody } from '../../shared/types';
import { HttpError } from './errors';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Params = Readonly<Record<string, string>>;

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Params;
}

export type Handler = (rc: RouteContext) => void | Promise<void>;

/** Largest JSON body accepted (D13). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Bodies over the limit are drained up to this size so the 413 reply can still be read; anything larger is abandoned. */
const DRAIN_LIMIT_BYTES = 1024 * 1024;

interface Route {
  method: Method;
  segments: string[];
  handler: Handler;
}

export type RouteMatch =
  | { kind: 'found'; handler: Handler; params: Params }
  | { kind: 'method-not-allowed'; allow: string[] }
  | { kind: 'not-found' };

function matchSegments(pattern: string[], path: string[]): Params | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i] ?? '';
    const got = path[i] ?? '';
    if (want.startsWith(':')) {
      if (got === '') return null;
      try {
        params[want.slice(1)] = decodeURIComponent(got);
      } catch {
        return null;
      }
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

/** Matches "/api/incidents/:id/ack"-style patterns. HEAD is served by the GET routes. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split('/'), handler });
  }

  match(method: string, pathname: string): RouteMatch {
    const wanted = method === 'HEAD' ? 'GET' : method;
    const parts = pathname.split('/');
    const allow = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (params === null) continue;
      if (route.method === wanted) return { kind: 'found', handler: route.handler, params };
      allow.add(route.method);
    }
    if (allow.size > 0) return { kind: 'method-not-allowed', allow: [...allow].sort() };
    return { kind: 'not-found' };
  }
}

export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function tooLarge(limit: number): HttpError {
  return new HttpError(413, 'payload_too_large', `Request body must be at most ${limit} bytes`);
}

async function readBodyText(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > DRAIN_LIMIT_BYTES) throw tooLarge(limit);

  const chunks: Buffer[] = [];
  let size = 0;
  let oversize = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > DRAIN_LIMIT_BYTES) throw tooLarge(limit);
    if (size <= limit) {
      chunks.push(buf);
    } else {
      oversize = true;
    }
  }
  if (oversize) throw tooLarge(limit);
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads a JSON request body. The Content-Type is checked before anything is read. */
export async function readJsonBody(req: IncomingMessage, limit: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'unsupported_media_type', 'Request body must be sent with Content-Type: application/json');
  }
  const text = await readBodyText(req, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, headers);
  res.end();
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Maps an HttpError onto the `{error:{code,message}, current?}` body. */
export function sendError(res: ServerResponse, err: HttpError): void {
  const body: ErrorBody = { error: { code: err.code, message: err.message } };
  if (err.current !== undefined) body.current = err.current;
  // A 413 may leave unread request data behind, so the connection is not reused.
  sendJson(res, err.status, body, err.status === 413 ? { Connection: 'close' } : {});
}

/** Reads one cookie value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/** ETag for an incident version. */
export function etagOf(version: number): string {
  return `"${version}"`;
}

const IF_MATCH_FORMS = /^(?:W\/)?"(\d+)"$|^(\d+)$/;

/**
 * Parses If-Match per D5: `"3"`, `3` or `W/"3"`.
 * Missing is 428 precondition_required. Anything else that is not a version is 400 bad_if_match.
 */
export function requireIfMatch(req: IncomingMessage): number {
  const raw = req.headers['if-match'];
  if (raw === undefined) {
    throw new HttpError(
      428,
      'precondition_required',
      'If-Match is required. Send the incident version as If-Match: "<version>"',
    );
  }
  const match = IF_MATCH_FORMS.exec(raw.trim());
  const digits = match ? (match[1] ?? match[2]) : undefined;
  const version = digits === undefined ? Number.NaN : Number(digits);
  if (!Number.isSafeInteger(version)) {
    throw new HttpError(400, 'bad_if_match', 'If-Match must be "<version>", <version> or W/"<version>"');
  }
  return version;
}
