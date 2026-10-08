import type { IncidentDTO } from '../../shared/types';
import { observeServerTime } from './clock';

/** An HTTP failure from the API, or a network failure (status 0, code 'network'). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Present on 409 responses: the record as the server holds it now. */
  readonly current?: IncidentDTO;

  constructor(status: number, code: string, message: string, current?: IncidentDTO) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name: unknown }).name === 'AbortError';
}

export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong.';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Sent as If-Match: "<n>". */
  ifMatch?: number;
  signal?: AbortSignal;
}

/**
 * Calls the JSON API. Non-2xx responses throw ApiError with the server's code, message and
 * (on 409) current record. Abort errors pass through unchanged. A JSON body carrying a numeric
 * serverTime feeds the clock offset estimate.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.ifMatch !== undefined) headers['If-Match'] = `"${opts.ifMatch}"`;
  const method = opts.method ?? (body !== undefined ? 'POST' : 'GET');

  const sentAt = Date.now();
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
    text = await res.text();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'network', 'Network connection failed. Check your connection and try again.');
  }
  const receivedAt = Date.now();

  if (res.status === 204) return undefined as T;

  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // A 2xx answer that is not JSON (a proxy or captive portal page) is a failure, not an empty result.
      if (res.ok) throw new ApiError(502, 'bad_response', 'The server sent a response that could not be read. Try again.');
      json = undefined;
    }
  }
  const obj = isRecord(json) ? json : null;
  if (obj && typeof obj.serverTime === 'number') observeServerTime(obj.serverTime, sentAt, receivedAt);

  if (!res.ok) {
    const error = obj && isRecord(obj.error) ? obj.error : null;
    const code = error && typeof error.code === 'string' ? error.code : `http_${res.status}`;
    const message =
      error && typeof error.message === 'string' ? error.message : `The server returned ${res.status}.`;
    const current = obj && isRecord(obj.current) ? (obj.current as unknown as IncidentDTO) : undefined;
    throw new ApiError(res.status, code, message, current);
  }
  return json as T;
}
