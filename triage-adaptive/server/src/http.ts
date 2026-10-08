import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { ErrorBody } from '../../shared/types';
import { HttpError } from './errors';

/** Request bodies above this size are rejected with 413 payload_too_large. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Every response carries these headers. */
export function baseHeaders(extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return { 'X-Content-Type-Options': 'nosniff', ...extra };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(
    status,
    baseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...extra,
    }),
  );
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, status: number, extra: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, baseHeaders(extra));
  res.end();
}

/** ETag for an incident: the version, quoted (D5). */
export function etagFor(version: number): string {
  return `"${version}"`;
}

export function notFound(message = 'No such endpoint'): HttpError {
  return new HttpError(404, 'not_found', message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, 'bad_request', message);
}

export function validationFailed(message: string): HttpError {
  return new HttpError(400, 'validation_failed', message);
}

/**
 * Writes the error envelope {error:{code,message}, current?}. HttpError maps to its own status.
 * Anything else is logged and returned as 500 internal. If the response already started (an SSE
 * stream), the response is simply ended.
 */
export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof HttpError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.current) body.current = err.current;
    sendJson(res, err.status, body);
    return;
  }
  console.error('[triage] unhandled error', err);
  sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error' } });
}

/**
 * Reads the request body up to limit bytes. Past the limit the promise rejects with 413, but the
 * remaining bytes are still drained so the client never sees a connection reset mid-upload.
 */
export function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        settle(() => reject(new HttpError(413, 'payload_too_large', `Request body must be at most ${limit} bytes`)));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('error', () => settle(() => reject(badRequest('Request body could not be read'))));
    req.on('close', () => settle(() => reject(badRequest('Request body was not received'))));
  });
}

/** Throws 415 unless the media type is exactly application/json (parameters such as charset are allowed). */
export function requireJsonContentType(req: IncomingMessage): void {
  const raw = req.headers['content-type'];
  const media = raw?.split(';', 1)[0]?.trim().toLowerCase();
  if (media !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
}

/** Reads and parses a JSON body. 415 for the wrong media type, 413 when too large, 400 when not JSON. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  requireJsonContentType(req);
  const buf = await readBody(req);
  if (buf.length === 0) throw badRequest('Request body must be a JSON document');
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The body must be a JSON object. */
export function asObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw validationFailed('body: must be a JSON object');
  return value;
}

/** Joins a repeated header into one string, or returns null when absent. */
export function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

const IF_MATCH_RE = /^(?:W\/)?(?:"(\d+)"|(\d+))$/;

/**
 * Parses If-Match: `3`, `"3"` or `W/"3"` (D5). Missing or blank → 428 precondition_required.
 * Anything else → 400 bad_if_match.
 */
export function parseIfMatch(value: string | string[] | undefined): number {
  const raw = headerValue(value)?.trim() ?? '';
  if (raw === '') {
    throw new HttpError(428, 'precondition_required', 'If-Match is required; send the ETag from the last read');
  }
  const match = IF_MATCH_RE.exec(raw);
  const version = match ? Number(match[1] ?? match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(version)) {
    throw new HttpError(400, 'bad_if_match', 'If-Match must be a version such as "3"');
  }
  return version;
}

/** Reads one cookie value from a Cookie header. Returns null when absent or empty. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      const value = part.slice(idx + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/** Extracts the token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(value: string | string[] | undefined): string | null {
  const raw = headerValue(value);
  if (raw === null) return null;
  const match = /^Bearer\s+(\S.*)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : null;
}

/** Constant-time string equality. Both sides are hashed first so the comparison length is fixed. */
export function sameSecret(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && actual.length === expected.length;
}

/**
 * Cross-origin guard for unsafe methods (D9). An Origin header whose host differs from the Host
 * header is rejected. A request with no Origin (curl, server-to-server) is allowed.
 */
export function isCrossOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === null) return false;
  const host = headerValue(req.headers.host);
  if (host === null) return true;
  try {
    return new URL(origin).host.toLowerCase() !== host.trim().toLowerCase();
  } catch {
    return true;
  }
}
