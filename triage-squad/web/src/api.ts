// Thin fetch wrapper. Every failure becomes an ApiError so callers handle one shape.
import type { ErrorBody, IncidentDTO } from '../../shared/types';
import { observeServerTime } from './clock';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
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
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong. Please try again.';
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Version to send as If-Match. Sent as a quoted ETag, e.g. "3". */
  ifMatch?: number;
  signal?: AbortSignal;
}

function serverTimeOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as { serverTime?: unknown }).serverTime;
  return typeof value === 'number' ? value : null;
}

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
    throw new ApiError(0, 'network', 'Network error. Check your connection and try again.');
  }
  const receivedAt = Date.now();

  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  const serverTime = serverTimeOf(data);
  if (serverTime !== null) observeServerTime(serverTime, sentAt, receivedAt);

  if (!res.ok) {
    const eb = (data ?? {}) as Partial<ErrorBody>;
    const code = eb.error?.code ?? (res.status === 401 ? 'unauthenticated' : 'http_error');
    const message = eb.error?.message ?? `Request failed (${res.status}).`;
    throw new ApiError(res.status, code, message, eb.current);
  }
  if (res.status === 204 || text === '') return undefined as T;
  if (data === undefined) {
    throw new ApiError(res.status, 'bad_response', 'The server sent a response that could not be read.');
  }
  return data as T;
}
