import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api';
import { store, PAGE_SIZE } from '../src/store';
import { realtime } from '../src/realtime';
import { session } from '../src/session';
import { navigate } from '../src/router';
import { currentToasts, dismiss } from '../src/toasts';
import { matchesFilters, type Filters } from '../../shared/rules';
import type { BulkAckItem, IncidentDTO, IncidentEventData, ListResponse } from '../../shared/types';

type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response> | Response;

const originalFetch = globalThis.fetch;
let handler: Handler | null = null;
/** Every list request the fake server received, in order. */
let listCalls: URL[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function incident(id: number, over: Partial<IncidentDTO> = {}): IncidentDTO {
  return {
    id,
    fingerprint: `fp-${id}`,
    source: 'checkout',
    title: `Incident ${id}`,
    severity: 'warning',
    status: 'open',
    assigneeId: null,
    version: 1,
    rev: 1,
    alertCount: 1,
    firstSeen: 0,
    lastSeen: 0,
    ackedAt: null,
    ackedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    slaDueAt: null,
    slaBreachedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function eventData(inc: IncidentDTO): IncidentEventData {
  return { incident: inc, audit: [] };
}

/** A fake list endpoint over `rows`, with the server's filter, keyset cursor and total rules. */
function fakeServer(rows: IncidentDTO[]): Handler {
  return (url) => {
    const filters: Filters = {};
    const status = url.searchParams.get('status');
    const severity = url.searchParams.get('severity');
    if (status) filters.status = status as Filters['status'];
    if (severity) filters.severity = severity as Filters['severity'];
    const assignee = url.searchParams.get('assignee');
    if (assignee) filters.assignee = assignee;
    const q = url.searchParams.get('q');
    if (q) filters.q = q;
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const cursor = url.searchParams.get('cursor');
    const matching = rows.filter((r) => matchesFilters(r, filters)).sort((a, b) => b.id - a.id);
    const remaining = cursor === null ? matching : matching.filter((r) => r.id < Number(cursor));
    const items = remaining.slice(0, limit);
    const body: ListResponse = {
      items,
      nextCursor: remaining.length > limit ? String(items[items.length - 1].id) : null,
      total: cursor === null ? matching.length : null,
      serverTime: Date.now(),
    };
    return json(body);
  };
}

/** Routes list requests to the fake server and counts them. */
function serve(rows: IncidentDTO[]): void {
  const list = fakeServer(rows);
  handler = (url, init) => {
    if (url.pathname === '/api/incidents') {
      listCalls.push(url);
      return list(url, init);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
}

/** Lets queued microtasks and response bodies finish. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

async function settled(): Promise<void> {
  await vi.waitFor(() => {
    const l = store.getList();
    expect(l.status).not.toBe('loading');
    expect(l.loadingMore).toBe(false);
  });
}

beforeEach(() => {
  listCalls = [];
  handler = null;
  store.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    if (!handler) throw new Error(`no handler for ${url.pathname}`);
    return handler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  store.clear();
  globalThis.fetch = originalFetch;
  handler = null;
});

describe('rev merge', () => {
  it('ignores live updates whose rev is not newer than the stored copy', async () => {
    serve([incident(1, { rev: 5, status: 'open' })]);
    store.setFilters({});
    await settled();

    store.applyEvent('incident.updated', eventData(incident(1, { rev: 4, status: 'acked' })));
    expect(store.getEntry(1)?.inc.status).toBe('open');
    expect(store.getEntry(1)?.inc.rev).toBe(5);

    store.applyEvent('incident.updated', eventData(incident(1, { rev: 5, status: 'acked' })));
    expect(store.getEntry(1)?.inc.status).toBe('open');

    store.applyEvent('incident.updated', eventData(incident(1, { rev: 6, status: 'acked' })));
    expect(store.getEntry(1)?.inc.status).toBe('acked');
  });

  it('does not let a stale page overwrite newer live data', async () => {
    serve([incident(1, { rev: 3, status: 'open' })]);
    store.setFilters({});
    await settled();
    store.applyEvent('incident.updated', eventData(incident(1, { rev: 9, status: 'resolved' })));
    store.resync();
    await settled();
    expect(store.getEntry(1)?.inc.status).toBe('resolved');
  });
});

describe('mutate', () => {
  beforeEach(async () => {
    serve([incident(7, { rev: 3, version: 1 })]);
    store.setFilters({});
    await settled();
  });

  it('applies the patch at once and rolls back to the 409 current copy', async () => {
    const seenIfMatch: (string | null)[] = [];
    handler = (url, init) => {
      if (url.pathname === '/api/incidents/7/ack') {
        seenIfMatch.push(new Headers(init?.headers).get('If-Match'));
        return json(
          {
            error: { code: 'version_conflict', message: 'stale' },
            current: incident(7, { rev: 4, version: 2, status: 'acked', ackedBy: 'u_bob' }),
          },
          409,
        );
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    const pending = store.mutate(7, { status: 'acked' }, (v) =>
      api(`/api/incidents/7/ack`, { method: 'POST', ifMatch: v }),
    );
    expect(store.getEntry(7)?.inc.status).toBe('acked');
    expect(store.getEntry(7)?.pending).toBe(1);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('version_conflict');
    expect(seenIfMatch).toEqual(['"1"']);

    const entry = store.getEntry(7);
    expect(entry?.inc.status).toBe('acked');
    expect(entry?.inc.version).toBe(2);
    expect(entry?.inc.rev).toBe(4);
    expect(entry?.inc.ackedBy).toBe('u_bob');
    expect(entry?.pending).toBe(0);
  });

  it('reverts to the pre-patch copy on a network error', async () => {
    handler = () => {
      throw new TypeError('Failed to fetch');
    };
    const err = await store
      .mutate(7, { status: 'acked' }, (v) => api(`/api/incidents/7/ack`, { method: 'POST', ifMatch: v }))
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('network');
    expect(store.getEntry(7)?.inc.status).toBe('open');
    expect(store.getEntry(7)?.pending).toBe(0);
  });

  it('does not revert when a newer rev arrived while the request was in flight', async () => {
    let fail: (e: Error) => void = () => undefined;
    handler = () =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      });
    const pending = store.mutate(7, { status: 'acked' }, (v) => api(`/api/incidents/7/ack`, { method: 'POST', ifMatch: v }));
    store.applyEvent('incident.updated', eventData(incident(7, { rev: 10, status: 'resolved', version: 2 })));
    fail(new TypeError('Failed to fetch'));
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(store.getEntry(7)?.inc.status).toBe('resolved');
    expect(store.getEntry(7)?.inc.rev).toBe(10);
    expect(store.getEntry(7)?.pending).toBe(0);
  });
});

describe('overlapping mutations on one incident', () => {
  function gated(): { fails: ((e: Error) => void)[]; request: () => Promise<IncidentDTO> } {
    const fails: ((e: Error) => void)[] = [];
    return {
      fails,
      request: () =>
        new Promise<IncidentDTO>((_resolve, reject) => {
          fails.push(reject);
        }),
    };
  }

  it('rolls back each failed write without restoring the other write\'s rolled-back patch', async () => {
    serve([incident(7, { rev: 3 })]);
    store.setFilters({});
    await settled();
    const a = gated();
    const b = gated();
    const pa = store.mutate(7, { status: 'acked', ackedBy: 'u_bob' }, a.request);
    const pb = store.mutate(7, { assigneeId: 'u_carol' }, b.request);
    expect(store.getEntry(7)?.inc.status).toBe('acked');
    expect(store.getEntry(7)?.inc.assigneeId).toBe('u_carol');
    expect(store.getEntry(7)?.pending).toBe(2);

    a.fails[0](new TypeError('Failed to fetch'));
    await expect(pa).rejects.toBeInstanceOf(Error);
    // A is rolled back, B's optimistic assignee stays.
    expect(store.getEntry(7)?.inc.status).toBe('open');
    expect(store.getEntry(7)?.inc.assigneeId).toBe('u_carol');
    expect(store.getEntry(7)?.pending).toBe(1);

    b.fails[0](new TypeError('Failed to fetch'));
    await expect(pb).rejects.toBeInstanceOf(Error);
    expect(store.getEntry(7)?.inc.status).toBe('open');
    expect(store.getEntry(7)?.inc.ackedBy).toBeNull();
    expect(store.getEntry(7)?.inc.assigneeId).toBeNull();
    expect(store.getEntry(7)?.pending).toBe(0);
  });

  it('ends at the original value when two failed writes patched the same field, in either order', async () => {
    serve([incident(7, { rev: 3 })]);
    store.setFilters({});
    await settled();
    const a = gated();
    const b = gated();
    const pa = store.mutate(7, { status: 'acked' }, a.request);
    const pb = store.mutate(7, { status: 'resolved' }, b.request);
    a.fails[0](new TypeError('Failed to fetch'));
    await expect(pa).rejects.toBeInstanceOf(Error);
    expect(store.getEntry(7)?.inc.status).toBe('resolved');
    b.fails[0](new TypeError('Failed to fetch'));
    await expect(pb).rejects.toBeInstanceOf(Error);
    expect(store.getEntry(7)?.inc.status).toBe('open');
  });
});

describe('list generations', () => {
  it('drops a response from a superseded generation after setFilters', async () => {
    const rows = [incident(10, { status: 'open' }), incident(20, { severity: 'critical' })];
    let releaseFirst: (r: Response) => void = () => undefined;
    handler = (url) => {
      if (url.searchParams.get('status') === 'open') {
        // Ignores the abort signal on purpose: the store must drop the late response itself.
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return fakeServer([rows[1]])(url, undefined);
    };
    store.setFilters({ status: 'open' });
    store.setFilters({ severity: 'critical' });
    await settled();
    expect(store.getList().order).toEqual([20]);

    releaseFirst(json({ items: [rows[0]], nextCursor: null, total: 1, serverTime: 0 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getList().order).toEqual([20]);
    expect(store.getList().filters).toEqual({ severity: 'critical' });
    expect(store.getEntry(10)).toBeUndefined();
  });

  it('drops a loadMore response that a resync superseded', async () => {
    const rows = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => incident(PAGE_SIZE + 5 - i));
    serve(rows);
    store.setFilters({});
    await settled();
    expect(store.getList().nextCursor).not.toBeNull();

    let releaseMore: (r: Response) => void = () => undefined;
    handler = (url) => {
      if (url.searchParams.get('cursor') !== null) {
        return new Promise<Response>((resolve) => {
          releaseMore = resolve;
        });
      }
      return fakeServer(rows)(url, undefined);
    };
    store.loadMore();
    store.resync();
    await flush();
    const before = store.getList().order.length;
    releaseMore(json({ items: [incident(1)], nextCursor: null, total: null, serverTime: 0 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getList().order.length).toBe(before);
    expect(store.getList().nextCursor).not.toBeNull();
  });
});

describe('live membership and total', () => {
  it('inserts created matches, removes incidents that stop matching, and keeps total in step', async () => {
    serve([incident(1), incident(2), incident(3)]);
    store.setFilters({ status: 'open' });
    await settled();
    expect(store.getList().order).toEqual([3, 2, 1]);
    expect(store.getList().total).toBe(3);

    store.applyEvent('incident.created', eventData(incident(4)));
    expect(store.getList().order).toEqual([4, 3, 2, 1]);
    expect(store.getList().total).toBe(4);

    store.applyEvent('incident.updated', eventData(incident(2, { rev: 2, status: 'acked' })));
    expect(store.getList().order).toEqual([4, 3, 1]);
    expect(store.getList().total).toBe(3);

    // Acked back to open flips it into the filter again.
    store.applyEvent('incident.updated', eventData(incident(2, { rev: 3, status: 'open' })));
    expect(store.getList().order).toEqual([4, 3, 2, 1]);
    expect(store.getList().total).toBe(4);
  });

  it('counts but does not insert a created match below the loaded window', async () => {
    const server = fakeServer([incident(10), incident(9), incident(8)]);
    handler = (url, init) => {
      // Two rows per page, so the window has a cursor and an unloaded tail.
      const small = new URL(url.href);
      small.searchParams.set('limit', '2');
      return server(small, init);
    };
    store.setFilters({ status: 'open' });
    await settled();
    expect(store.getList().order).toEqual([10, 9]);
    expect(store.getList().nextCursor).toBe('9');
    expect(store.getList().total).toBe(3);

    store.applyEvent('incident.created', eventData(incident(5)));
    expect(store.getList().order).toEqual([10, 9]);
    expect(store.getList().total).toBe(4);

    store.applyEvent('incident.created', eventData(incident(11)));
    expect(store.getList().order).toEqual([11, 10, 9]);
    expect(store.getList().total).toBe(5);
  });
});

describe('resync', () => {
  it('keeps a live-inserted row the server confirms, and drops rows the server no longer returns', async () => {
    serve([incident(1), incident(2), incident(3)]);
    store.setFilters({ status: 'open' });
    await settled();

    store.applyEvent('incident.created', eventData(incident(4)));
    expect(store.getList().order).toEqual([4, 3, 2, 1]);

    // The server has 4 too, so the resync confirms it.
    serve([incident(1), incident(2), incident(3), incident(4)]);
    store.resync();
    await flush();
    expect(store.getList().order).toEqual([4, 3, 2, 1]);
    expect(store.getList().total).toBe(4);

    // The server now lacks incident 2 (resolved while the stream was down).
    serve([incident(1), incident(3), incident(4)]);
    store.resync();
    await vi.waitFor(() => expect(store.getList().order).toEqual([4, 3, 1]));
    expect(store.getList().total).toBe(3);
  });

  it('drops a live-inserted row that was acked on the server during a stream gap', async () => {
    serve([incident(1), incident(2), incident(3)]);
    store.setFilters({ status: 'open' });
    await settled();

    // INC-4 arrives live as open. The stream drops, and another user acks it. The event is missed.
    store.applyEvent('incident.created', eventData(incident(4)));
    expect(store.getList().order).toEqual([4, 3, 2, 1]);
    serve([incident(1), incident(2), incident(3)]);

    store.resync();
    await vi.waitFor(() => expect(store.getList().order).toEqual([3, 2, 1]));
    expect(store.getList().total).toBe(3);
    expect(store.getEntry(4)).toBeDefined();
    expect(store.getEntry(4)?.inc.status).toBe('open');
  });

  it('keeps a row created while the resync request is in flight, and counts it in total', async () => {
    serve([incident(1), incident(2), incident(3)]);
    store.setFilters({ status: 'open' });
    await settled();

    // The server answers from its state at read time (no INC-4), but the response is held back.
    const inner = handler as Handler;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = async (url, init) => {
      const res = inner(url, init);
      await gate;
      return res;
    };
    store.resync();
    store.applyEvent('incident.created', eventData(incident(4)));
    release();

    await flush();
    expect(store.getList().order).toEqual([4, 3, 2, 1]);
    expect(store.getList().total).toBe(4);
  });

  it('ignores a live update for an incident below the page during setFilters', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => incident(300 - i, { rev: 1 }));
    serve(rows);
    store.setFilters({ status: 'open' });
    // The first page is in flight. A live event arrives for an old matching incident.
    store.applyEvent('incident.updated', eventData(incident(5, { rev: 2, severity: 'critical' })));
    await settled();
    const list = store.getList();
    expect(list.order.length).toBe(PAGE_SIZE);
    expect(list.order[0]).toBe(300);
    expect(list.order[list.order.length - 1]).toBe(201);
    expect(list.order).not.toContain(5);
    expect(list.total).toBe(300);
    // It is still known, and loadMore brings it in at its place.
    expect(store.getEntry(5)?.inc.rev).toBe(2);
  });

  it('ignores a live update for an incident below the window during a resync, and does not double count it', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => incident(300 - i, { rev: 1 }));
    serve(rows);
    store.setFilters({ status: 'open' });
    await settled();

    const inner = handler as Handler;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = async (url, init) => {
      const res = inner(url, init);
      await gate;
      return res;
    };
    store.resync();
    store.applyEvent('incident.updated', eventData(incident(5, { rev: 2, severity: 'critical' })));
    // Below the loaded window: not inserted.
    expect(store.getList().order).not.toContain(5);
    release();
    await flush();
    expect(store.getList().order).not.toContain(5);
    expect(store.getList().order.length).toBe(PAGE_SIZE);
    expect(store.getList().total).toBe(300);
  });

  it('subtracts a returned row from total when a newer local copy no longer matches', async () => {
    serve([incident(1), incident(2), incident(3)]);
    store.setFilters({ status: 'open' });
    await settled();

    const inner = handler as Handler;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = async (url, init) => {
      const res = inner(url, init); // read before the ack: INC-2 still open at rev 1
      await gate;
      return res;
    };
    store.resync();
    store.applyEvent('incident.updated', eventData(incident(2, { rev: 2, status: 'acked', version: 2 })));
    release();
    await flush();
    expect(store.getList().order).toEqual([3, 1]);
    expect(store.getList().total).toBe(2);
  });

  it('re-fetches at most 1000 rows in at most 5 requests', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => incident(1200 - i));
    serve(rows);
    store.setFilters({});
    await settled();
    while (store.getList().order.length < 1000 && store.getList().nextCursor !== null) {
      store.loadMore();
      await settled();
    }
    expect(store.getList().order.length).toBe(1000);

    listCalls = [];
    store.resync();
    await vi.waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    await flush();
    expect(listCalls.length).toBeLessThanOrEqual(5);
    expect(store.getList().order.length).toBe(1000);
    expect(store.getList().order[0]).toBe(1200);
  });
});

describe('subscriptions and identity', () => {
  it('keeps getEntry identity while nothing changes and notifies onUpdate for live events', async () => {
    serve([incident(1, { rev: 2 })]);
    store.setFilters({});
    await settled();
    const before = store.getEntry(1);
    const seen: (number | null)[] = [];
    const off = store.onUpdate((id) => seen.push(id));

    store.applyEvent('incident.updated', eventData(incident(1, { rev: 1, status: 'acked' })));
    expect(store.getEntry(1)).toBe(before);
    store.applyEvent('incident.updated', eventData(incident(1, { rev: 3, status: 'acked' })));
    expect(store.getEntry(1)).not.toBe(before);
    expect(seen).toEqual([1, 1]);

    store.resync();
    await vi.waitFor(() => expect(seen).toEqual([1, 1, null]));
    off();
  });

  it('keeps subscribe identity stable', () => {
    expect(store.subscribe).toBe(store.subscribe);
  });
});

describe('resync and loadMore ordering', () => {
  it('holds a loadMore that is requested during a resync until the resync lands, then continues from the fresh cursor', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => incident(250 - i));
    serve(rows);
    store.setFilters({});
    await settled();
    expect(store.getList().order.length).toBe(PAGE_SIZE);

    // Five new incidents appear on the server while the stream was down.
    const all = [...Array.from({ length: 5 }, (_, i) => incident(255 - i)), ...rows];
    const server = fakeServer(all);
    let releaseResync: () => void = () => undefined;
    const cursorRequests: string[] = [];
    handler = (url, init) => {
      const cursor = url.searchParams.get('cursor');
      if (cursor !== null) {
        cursorRequests.push(cursor);
        return server(url, init);
      }
      // The resync's first request is held until the test releases it.
      return new Promise<Response>((resolve) => {
        releaseResync = () => resolve(server(url, init));
      });
    };

    store.resync();
    store.loadMore();
    await flush();
    expect(cursorRequests).toEqual([]);

    releaseResync();
    await vi.waitFor(() => expect(store.getList().order.length).toBe(200));
    await settled();
    expect(cursorRequests.length).toBe(1);
    expect(store.getList().order).toEqual(Array.from({ length: 200 }, (_, i) => 255 - i));
  });

  it('retry repeats a failed resync instead of loading the next page', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => incident(150 - i));
    serve(rows);
    store.setFilters({});
    await settled();

    handler = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    store.resync();
    await vi.waitFor(() => expect(store.getList().error).not.toBeNull());
    expect(store.getList().status).toBe('ready');

    // The server now reports row 150 as acked. The failed resync must be repeated to learn that.
    const changed = rows.map((r) => (r.id === 150 ? incident(150, { status: 'acked', rev: 2, version: 2 }) : r));
    serve(changed);
    listCalls = [];
    store.retry();
    await vi.waitFor(() => expect(store.getEntry(150)?.inc.status).toBe('acked'));
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((u) => u.searchParams.get('cursor') === null)).toBe(true);
    expect(store.getList().error).toBeNull();
  });

  it('does not re-request a failed next page until retry() is called', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => incident(150 - i));
    serve(rows);
    store.setFilters({});
    await settled();

    handler = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    listCalls = [];
    let calls = 0;
    const failing = handler;
    handler = (url, init) => {
      calls += 1;
      return failing(url, init);
    };
    store.loadMore();
    await vi.waitFor(() => expect(store.getList().error).not.toBeNull());
    store.loadMore();
    store.loadMore();
    await flush();
    expect(calls).toBe(1);

    serve(rows);
    store.retry();
    await vi.waitFor(() => expect(store.getList().order.length).toBe(150));
  });

  it('retry repeats a failed next-page load', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => incident(150 - i));
    serve(rows);
    store.setFilters({});
    await settled();

    handler = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    store.loadMore();
    await vi.waitFor(() => expect(store.getList().error).not.toBeNull());
    expect(store.getList().order.length).toBe(PAGE_SIZE);

    serve(rows);
    listCalls = [];
    store.retry();
    await vi.waitFor(() => expect(store.getList().order.length).toBe(150));
    expect(listCalls.some((u) => u.searchParams.get('cursor') === '51')).toBe(true);
  });
});

describe('total and membership for incidents the store has not seen', () => {
  it('counts an unknown incident that flips into the filter when the whole list is loaded', async () => {
    serve([incident(1, { status: 'open' }), incident(2, { status: 'open' }), incident(3, { status: 'resolved' })]);
    store.setFilters({ status: 'open' });
    await settled();
    expect(store.getList().order).toEqual([2, 1]);
    expect(store.getList().total).toBe(2);
    expect(store.getList().nextCursor).toBeNull();

    store.applyEvent('incident.updated', eventData(incident(3, { rev: 3, status: 'open' })));
    expect(store.getList().order).toEqual([3, 2, 1]);
    expect(store.getList().total).toBe(3);
  });

  it('does not count an unknown matching incident below the loaded window', async () => {
    const server = fakeServer([incident(10), incident(9), incident(8)]);
    handler = (url, init) => {
      const small = new URL(url.href);
      small.searchParams.set('limit', '2');
      return server(small, init);
    };
    store.setFilters({ status: 'open' });
    await settled();
    expect(store.getList().nextCursor).toBe('9');
    expect(store.getList().total).toBe(3);

    // Id 5 is below the window. It may already be counted in total (a fold into an open incident), so it is not counted again.
    store.applyEvent('incident.updated', eventData(incident(5, { rev: 2, status: 'open' })));
    expect(store.getList().total).toBe(3);
    expect(store.getList().order).toEqual([10, 9]);
  });

  it('restores a row that an optimistic change removed from the window when the 409 rollback arrives', async () => {
    const page = [incident(5), incident(4), incident(3)];
    handler = (url) => {
      if (url.pathname === '/api/incidents') {
        return json({ items: page, nextCursor: '3', total: 10, serverTime: 0 });
      }
      if (url.pathname === '/api/incidents/3/ack') {
        return json(
          {
            error: { code: 'version_conflict', message: 'stale' },
            current: incident(3, { rev: 2, version: 2, status: 'open' }),
          },
          409,
        );
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    store.setFilters({ status: 'open' });
    await settled();
    expect(store.getList().order).toEqual([5, 4, 3]);

    const pending = store.mutate(3, { status: 'acked' }, (v) =>
      api('/api/incidents/3/ack', { method: 'POST', ifMatch: v }),
    );
    expect(store.getList().order).toEqual([5, 4]);
    expect(store.getList().total).toBe(9);

    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(store.getList().order).toEqual([5, 4, 3]);
    expect(store.getList().total).toBe(10);
    expect(store.getEntry(3)?.inc.status).toBe('open');
    expect(store.getEntry(3)?.inc.version).toBe(2);
  });
});

describe('forced 409 copies', () => {
  it('keeps a newer live copy when a 409 carries an older current', async () => {
    serve([incident(7, { rev: 3, version: 1 })]);
    store.setFilters({});
    await settled();

    let fail: (r: Response) => void = () => undefined;
    handler = () =>
      new Promise<Response>((resolve) => {
        fail = resolve;
      });
    const pending = store.mutate(7, { status: 'acked' }, (v) =>
      api('/api/incidents/7/ack', { method: 'POST', ifMatch: v }),
    );
    store.applyEvent('incident.updated', eventData(incident(7, { rev: 6, version: 3, status: 'resolved' })));
    fail(
      json(
        {
          error: { code: 'version_conflict', message: 'stale' },
          current: incident(7, { rev: 4, version: 2, status: 'acked', ackedBy: 'u_bob' }),
        },
        409,
      ),
    );
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(store.getEntry(7)?.inc.rev).toBe(6);
    expect(store.getEntry(7)?.inc.status).toBe('resolved');
    expect(store.getEntry(7)?.pending).toBe(0);
  });
});

describe('bulkAck results', () => {
  it('reports a failed chunk as failed results for the remaining ids instead of throwing', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => i + 1);
    for (const id of ids) store.seed(incident(id));
    let calls = 0;
    handler = (url, init) => {
      if (url.pathname !== '/api/incidents/bulk-ack') throw new Error(`unexpected ${url.pathname}`);
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { items: BulkAckItem[] };
      if (calls === 1) {
        return json({
          results: body.items.map((it) => ({
            id: it.id,
            ok: true,
            status: 200,
            incident: incident(it.id, { status: 'acked', version: 2, rev: 2, ackedBy: 'u_bob' }),
          })),
        });
      }
      throw new TypeError('Failed to fetch');
    };

    const results = await store.bulkAck(ids, { id: 'u_bob', displayName: 'Bob Okafor' });
    expect(results).toHaveLength(600);
    expect(results.filter((r) => r.ok)).toHaveLength(500);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(100);
    expect(failed.every((r) => r.error?.code === 'network')).toBe(true);
    expect(store.getEntry(1)?.inc.status).toBe('acked');
    expect(store.getEntry(501)?.inc.status).toBe('open');
    expect(store.getEntry(501)?.pending).toBe(0);
  });

  it('reports an id the server did not answer for as a failure and reverts it', async () => {
    store.seed(incident(1));
    store.seed(incident(2));
    handler = (url, init) => {
      if (url.pathname !== '/api/incidents/bulk-ack') throw new Error(`unexpected ${url.pathname}`);
      const body = JSON.parse(String(init?.body)) as { items: BulkAckItem[] };
      return json({
        results: [{ id: body.items[0].id, ok: true, status: 200, incident: incident(1, { status: 'acked', version: 2, rev: 2 }) }],
      });
    };
    const results = await store.bulkAck([1, 2], { id: 'u_bob', displayName: 'Bob Okafor' });
    expect(results).toHaveLength(2);
    const missing = results.find((r) => r.id === 2);
    expect(missing?.ok).toBe(false);
    expect(missing?.error?.code).toBe('no_result');
    expect(store.getEntry(2)?.inc.status).toBe('open');
    expect(store.getEntry(2)?.pending).toBe(0);
  });
});

describe('bad 2xx bodies', () => {
  it('turns a non-JSON 200 into a page error instead of a permanent loading state', async () => {
    handler = () => new Response('<html>captive portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    store.setFilters({});
    await vi.waitFor(() => expect(store.getList().status).toBe('error'));
    expect(store.getList().error).toBeTruthy();
  });

  it('turns a JSON 200 without an items array into a page error', async () => {
    handler = () => json({ ok: true });
    store.setFilters({});
    await vi.waitFor(() => expect(store.getList().status).toBe('error'));
    expect(store.getList().order).toEqual([]);
  });
});

describe('realtime connection', () => {
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    onerror: ((ev: Event) => void) | null = null;
    readonly url: string;
    private readonly handlers = new Map<string, (ev: MessageEvent) => void>();
    constructor(url: string) {
      this.url = url;
      fakeSources.push(this);
    }
    addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
      this.handlers.set(type, fn);
    }
    close(): void {
      this.readyState = FakeEventSource.CLOSED;
    }
    emit(type: string): void {
      this.handlers.get(type)?.({ data: '', lastEventId: '' } as MessageEvent);
    }
  }
  let fakeSources: FakeEventSource[] = [];

  beforeEach(() => {
    fakeSources = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    realtime.stop();
    vi.unstubAllGlobals();
  });

  it('resyncs on the first live transition, so events missed before the first connect are picked up', async () => {
    serve([incident(1), incident(2)]);
    store.setFilters({});
    await settled();

    realtime.start(() => undefined);
    expect(fakeSources.length).toBe(1);
    listCalls = [];
    fakeSources[0].emit('hello');
    expect(realtime.getStatus()).toBe('live');
    await vi.waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
  });

  it('does not resync before the store has loaded anything', async () => {
    serve([incident(1)]);
    realtime.start(() => undefined);
    listCalls = [];
    fakeSources[0].emit('hello');
    expect(realtime.getStatus()).toBe('live');
    await flush();
    expect(listCalls).toEqual([]);
  });

  /** A stream that closed, with the session check held until `release` is called. */
  async function closeWithGatedAuth(): Promise<{ release: () => void }> {
    const me = { user: { id: 'u_alice', username: 'alice', displayName: 'Alice Chen', role: 'admin' }, serverTime: 0 };
    serve([incident(1)]);
    store.setFilters({});
    await settled();
    const list = handler as Handler;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = async (url, init) => {
      if (url.pathname === '/api/incidents') return list(url, init);
      if (url.pathname === '/api/auth/me') {
        await gate;
        return json(me);
      }
      throw new Error(`unexpected request ${url.pathname}`);
    };
    return { release };
  }

  it('does not show Live while the session check after a closed stream is pending', async () => {
    const { release } = await closeWithGatedAuth();
    realtime.start(() => undefined);
    fakeSources[0].emit('hello');
    expect(realtime.getStatus()).toBe('live');

    fakeSources[0].readyState = 2;
    fakeSources[0].onerror?.(new Event('error'));
    expect(realtime.getStatus()).not.toBe('live');
    release();
    await flush();
    expect(realtime.getStatus()).not.toBe('live');
  });

  it('does not tear down a stream that a manual reconnect opened while the session check was pending', async () => {
    const winTarget = new EventTarget();
    vi.stubGlobal('window', winTarget);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const { release } = await closeWithGatedAuth();
    realtime.start(() => undefined);
    fakeSources[0].emit('hello');
    fakeSources[0].readyState = 2;
    fakeSources[0].onerror?.(new Event('error'));

    // The browser comes back online while /api/auth/me is still pending: a manual reconnect.
    winTarget.dispatchEvent(new Event('online'));
    expect(fakeSources.length).toBe(2);
    fakeSources[1].emit('hello');
    expect(realtime.getStatus()).toBe('live');

    release();
    await new Promise((r) => setTimeout(r, 1200));
    expect(fakeSources.length).toBe(2);
    expect(realtime.getStatus()).toBe('live');
  });

  it('ignores a session check from a previous session when the user signed out and back in', async () => {
    const me = { user: { id: 'u_alice', username: 'alice', displayName: 'Alice Chen', role: 'admin' }, serverTime: 0 };
    serve([incident(1)]);
    store.setFilters({});
    await settled();
    const list = handler as Handler;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = async (url, init) => {
      if (url.pathname === '/api/incidents') return list(url, init);
      if (url.pathname === '/api/auth/me') {
        await gate;
        return json({ error: { code: 'unauthenticated', message: 'no' } }, 401);
      }
      void me;
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const lost1 = vi.fn();
    const lost2 = vi.fn();
    realtime.start(lost1);
    fakeSources[0].emit('hello');
    fakeSources[0].readyState = 2;
    fakeSources[0].onerror?.(new Event('error'));
    realtime.stop();
    realtime.start(lost2);
    expect(fakeSources.length).toBe(2);
    fakeSources[1].emit('hello');
    release();
    await flush();
    expect(lost1).not.toHaveBeenCalled();
    expect(lost2).not.toHaveBeenCalled();
    expect(realtime.getStatus()).toBe('live');
  });

  it('reopens the stream after a closed stream when nothing reconnected meanwhile', async () => {
    const { release } = await closeWithGatedAuth();
    realtime.start(() => undefined);
    fakeSources[0].emit('hello');
    fakeSources[0].readyState = 2;
    fakeSources[0].onerror?.(new Event('error'));
    release();
    await new Promise((r) => setTimeout(r, 1200));
    expect(fakeSources.length).toBe(2);
    expect(realtime.getStatus()).toBe('reconnecting');
  });
});

describe('session check', () => {
  // The session module starts in 'loading'. These tests run before the logout tests, which set it to 'anon'.
  const ME = { id: 'u_alice', username: 'alice', displayName: 'Alice Chen', role: 'admin' as const };

  afterEach(() => {
    session.expire();
    for (const t of currentToasts()) dismiss(t.id);
    globalThis.fetch = originalFetch;
    handler = null;
  });

  it('stays loading and retries when the check fails with a server error, instead of signing the user out', async () => {
    let calls = 0;
    handler = (url) => {
      if (url.pathname === '/api/users') return json({ users: [ME] });
      calls += 1;
      if (calls === 1) return json({ error: { code: 'internal', message: 'boom' } }, 500);
      return json({ user: ME, serverTime: Date.now() });
    };
    await session.init();
    expect(session.getState().status).toBe('loading');
    expect(currentToasts().filter((t) => t.kind === 'error').length).toBe(1);
    await vi.waitFor(() => expect(session.getState().status).toBe('authed'), { timeout: 3000 });
    expect(calls).toBe(2);
  });

  it('signs out on a 401', async () => {
    handler = () => json({ error: { code: 'unauthenticated', message: 'no session' } }, 401);
    await session.init();
    expect(session.getState().status).toBe('anon');
    expect(currentToasts().filter((t) => t.kind === 'error')).toEqual([]);
  });
});

describe('router navigate', () => {
  let search = '';
  let pushes: string[] = [];

  beforeEach(() => {
    search = '?q=disk%20full&sel=12';
    pushes = [];
    vi.stubGlobal('window', {
      location: {
        get pathname() {
          return '/';
        },
        get search() {
          return search;
        },
        hash: '',
      },
      history: {
        state: null,
        pushState: (_state: unknown, _title: string, url: string) => {
          pushes.push(url);
          search = url.slice(url.indexOf('?'));
        },
        replaceState: (_state: unknown, _title: string, url: string) => {
          search = url.slice(url.indexOf('?'));
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not push history when a patch changes nothing but the query encoding', () => {
    navigate({ q: 'disk full' }, 'push');
    expect(pushes).toEqual([]);
  });

  it('pushes history when a value really changes', () => {
    navigate({ q: 'other' }, 'push');
    expect(pushes).toEqual(['/?q=other&sel=12']);
  });
});

describe('logout', () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    for (const t of currentToasts()) dismiss(t.id);
    globalThis.fetch = originalFetch;
    handler = null;
  });

  it('warns when the server could not end the session', async () => {
    handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await session.logout();
    expect(session.getState().status).toBe('anon');
    const errors = currentToasts().filter((t) => t.kind === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/could not end your session/);
  });

  it('does not warn when the session had already ended on the server', async () => {
    handler = () => json({ error: { code: 'unauthenticated', message: 'no session' } }, 401);
    await session.logout();
    expect(session.getState().status).toBe('anon');
    expect(currentToasts().filter((t) => t.kind === 'error')).toEqual([]);
  });
});
