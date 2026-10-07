import type { ErrorBody, IncidentDTO } from '../../shared/types';
import { observeServerTime } from './clock';

/** An error from the API. `current` is the server's copy of the incident on a 409. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: IncidentDTO,
  ) {
    super(message);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Sent as If-Match. Required by every incident mutation. */
  ifMatch?: number;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;

  const sentAt = Date.now();
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'network', 'Network error. Check your connection and try again.');
  }
  const receivedAt = Date.now();

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const serverTime = (data as { serverTime?: unknown } | null)?.serverTime;
  if (typeof serverTime === 'number') observeServerTime(serverTime, sentAt, receivedAt);

  if (!res.ok) {
    const body = data as ErrorBody | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'error',
      body?.error?.message ?? `Request failed with status ${res.status}`,
      body?.current,
    );
  }
  return data as T;
}
