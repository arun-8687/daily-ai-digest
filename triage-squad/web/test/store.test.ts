// The client store against a stubbed global fetch (SPEC section 6, web/test/store.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentDTO, ListResponse } from '../../shared/types';
import type { Filters } from '../../shared/rules';
import { ApiError, api } from '../src/api';
import { store } from '../src/store';

function inc(id: number, over: Partial<IncidentDTO> = {}): IncidentDTO {
  return {
    id,
    fingerprint: `fp-${id}`,
    source: 'api',
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

/** Rows with descending ids from `hi`, `count` long. */
function rows(hi: number, count: number, over: Partial<IncidentDTO> = {}): IncidentDTO[] {
  return Array.from({ length: count }, (_, i) => inc(hi - i, over));
}

function page(items: IncidentDTO[], opts: { nextCursor?: string | null; total?: number | null } = {}): ListResponse {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    total: opts.total === undefined ? items.length : opts.total,
    serverTime: Date.now(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const originalFetch = globalThis.fetch;

function urlAt(i: number): string {
  return String(fetchMock.mock.calls[i][0]);
}

function initAt(i: number): RequestInit | undefined {
  return fetchMock.mock.calls[i][1];
}

/** Loads the first page for the given filters with the given server response. */
async function loadList(items: IncidentDTO[], filters: Filters = {}, opts: { nextCursor?: string | null; total?: number | null } = {}) {
  fetchMock.mockResolvedValueOnce(json(page(items, opts)));
  store.setFilters(filters);
  await vi.waitFor(() => expect(store.getList().status).toBe('ready'));
}

function ids(): number[] {
  return [...store.getList().order];
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  store.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('rev merge', () => {
  it('ignores an incoming copy with rev <= local rev and applies a newer one', async () => {
    await loadList([inc(2, { status: 'acked', rev: 3, version: 2 }), inc(1)]);

    store.applyEvent('incident.updated', { incident: inc(2, { status: 'open', rev: 2 }), audit: [] });
    expect(store.getEntry(2)?.inc.status).toBe('acked');
    expect(store.getEntry(2)?.inc.rev).toBe(3);

    store.applyEvent('incident.updated', { incident: inc(2, { status: 'resolved', rev: 4 }), audit: [] });
    expect(store.getEntry(2)?.inc.status).toBe('resolved');
    expect(store.getEntry(2)?.inc.rev).toBe(4);
  });

  it('changes getEntry identity only for the entry that changed, and keeps getList identity for a non-membership change', async () => {
    await loadList([inc(2), inc(1)]);
    const entry1 = store.getEntry(1);
    const entry2 = store.getEntry(2);
    const list = store.getList();

    store.applyEvent('incident.updated', { incident: inc(2, { severity: 'critical', rev: 2 }), audit: [] });

    expect(store.getEntry(1)).toBe(entry1);
    expect(store.getEntry(2)).not.toBe(entry2);
    expect(store.getList()).toBe(list);
  });
});

describe('mutate', () => {
  it('sends the pre-patch version, shows the patch while pending, and force-sets current on a 409', async () => {
    store.seed(inc(5, { version: 1, rev: 1 }));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    const outcome = store
      .mutate(5, { status: 'resolved' }, (version) =>
        api<IncidentDTO>('/api/incidents/5/resolve', { method: 'POST', ifMatch: version }),
      )
      .then(
        () => 'ok',
        (err: unknown) => err,
      );

    expect(store.getEntry(5)?.inc.status).toBe('resolved');
    expect(store.getEntry(5)?.pending).toBe(1);
    expect(new Headers(initAt(0)?.headers).get('If-Match')).toBe('"1"');

    response.resolve(
      json(
        {
          error: { code: 'version_conflict', message: 'changed' },
          current: inc(5, { status: 'acked', version: 2, rev: 2, ackedBy: 'u_bob' }),
        },
        409,
      ),
    );
    const err = await outcome;

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('version_conflict');
    expect(store.getEntry(5)?.inc.status).toBe('acked');
    expect(store.getEntry(5)?.inc.version).toBe(2);
    expect(store.getEntry(5)?.pending).toBe(0);
  });

  it('keeps an ack in flight on the row when a live event for the same incident arrives first', async () => {
    store.seed(inc(5, { version: 1, rev: 1 }));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    const outcome = store
      .mutate(5, { status: 'acked', ackedBy: 'u_bob' }, (version) =>
        api<IncidentDTO>('/api/incidents/5/ack', { method: 'POST', ifMatch: version }),
      )
      .catch((err: unknown) => err);

    // A fold lands while the ack is pending. The server copy is still open, but the row must keep showing the ack.
    store.applyEvent('incident.updated', { incident: inc(5, { alertCount: 2, rev: 2 }), audit: [] });
    expect(store.getEntry(5)?.inc.status).toBe('acked');
    expect(store.getEntry(5)?.inc.alertCount).toBe(2);
    expect(store.getEntry(5)?.pending).toBe(1);

    response.resolve(json(inc(5, { status: 'acked', ackedBy: 'u_bob', version: 2, rev: 3, alertCount: 2 })));
    await outcome;
    expect(store.getEntry(5)?.inc).toMatchObject({ status: 'acked', version: 2, rev: 3, alertCount: 2 });
    expect(store.getEntry(5)?.pending).toBe(0);
  });

  it('reverts to the pre-patch copy on a network error and rethrows', async () => {
    store.seed(inc(6));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = await store
      .mutate(6, { status: 'acked' }, (version) => api<IncidentDTO>('/api/incidents/6/ack', { method: 'POST', ifMatch: version }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect(store.getEntry(6)?.inc.status).toBe('open');
    expect(store.getEntry(6)?.pending).toBe(0);
  });

  it('does not roll back over a newer rev that arrived while the request was in flight', async () => {
    store.seed(inc(7, { rev: 1 }));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    const outcome = store
      .mutate(7, { status: 'acked' }, (version) => api<IncidentDTO>('/api/incidents/7/ack', { method: 'POST', ifMatch: version }))
      .catch((e: unknown) => e);

    store.applyEvent('incident.updated', { incident: inc(7, { status: 'resolved', rev: 3 }), audit: [] });
    response.reject(new TypeError('Failed to fetch'));
    await outcome;

    expect(store.getEntry(7)?.inc.status).toBe('resolved');
    expect(store.getEntry(7)?.inc.rev).toBe(3);
  });

  it('merges the server result on success', async () => {
    store.seed(inc(8));
    fetchMock.mockResolvedValueOnce(json(inc(8, { status: 'acked', version: 2, rev: 2, ackedBy: 'u_bob' })));

    const result = await store.mutate(8, { status: 'acked' }, (version) =>
      api<IncidentDTO>('/api/incidents/8/ack', { method: 'POST', ifMatch: version }),
    );

    expect(result.version).toBe(2);
    expect(store.getEntry(8)?.inc.status).toBe('acked');
    expect(store.getEntry(8)?.pending).toBe(0);
  });

  it('keeps a newer live copy when a 409 carries older server truth', async () => {
    store.seed(inc(5, { version: 1, rev: 1 }));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    const outcome = store
      .mutate(5, { status: 'acked' }, (version) => api<IncidentDTO>('/api/incidents/5/ack', { method: 'POST', ifMatch: version }))
      .catch((e: unknown) => e);

    store.applyEvent('incident.updated', {
      incident: inc(5, { status: 'resolved', version: 2, rev: 9, resolvedBy: 'u_alice' }),
      audit: [],
    });
    response.resolve(
      json(
        {
          error: { code: 'version_conflict', message: 'changed' },
          current: inc(5, { status: 'acked', version: 2, rev: 3, ackedBy: 'u_bob' }),
        },
        409,
      ),
    );
    await outcome;

    expect(store.getEntry(5)?.inc.status).toBe('resolved');
    expect(store.getEntry(5)?.inc.rev).toBe(9);
    expect(store.getEntry(5)?.pending).toBe(0);
  });

  it('a failed mutate keeps another patch still in flight, and rolls both back when both fail', async () => {
    store.seed(inc(5, { status: 'open', assigneeId: null }));
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const ack = store
      .mutate(5, { status: 'acked' }, (version) => api<IncidentDTO>('/api/incidents/5/ack', { method: 'POST', ifMatch: version }))
      .catch((e: unknown) => e);
    const assign = store
      .mutate(5, { assigneeId: 'u_bob' }, (version) =>
        api<IncidentDTO>('/api/incidents/5/assign', { method: 'POST', ifMatch: version, body: { assigneeId: 'u_bob' } }),
      )
      .catch((e: unknown) => e);

    first.reject(new TypeError('Failed to fetch'));
    await ack;
    expect(store.getEntry(5)?.inc.status).toBe('open');
    expect(store.getEntry(5)?.inc.assigneeId).toBe('u_bob');
    expect(store.getEntry(5)?.pending).toBe(1);

    second.reject(new TypeError('Failed to fetch'));
    await assign;
    expect(store.getEntry(5)?.inc.status).toBe('open');
    expect(store.getEntry(5)?.inc.assigneeId).toBeNull();
    expect(store.getEntry(5)?.pending).toBe(0);
  });

  it('applies the optimistic ack under an Open filter by removing the row, and restores it on failure', async () => {
    await loadList([inc(2), inc(1)], { status: 'open' }, { total: 2 });
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    const outcome = store
      .mutate(2, { status: 'acked' }, (version) => api<IncidentDTO>('/api/incidents/2/ack', { method: 'POST', ifMatch: version }))
      .catch((e: unknown) => e);

    expect(ids()).toEqual([1]);
    expect(store.getList().total).toBe(1);

    response.reject(new TypeError('Failed to fetch'));
    await outcome;

    expect(ids()).toEqual([2, 1]);
    expect(store.getList().total).toBe(2);
  });
});

describe('list requests and generations', () => {
  it('does nothing when setFilters gets equal filters, and reloads when they change', async () => {
    await loadList([inc(1)], { status: 'open' });
    store.setFilters({ status: 'open' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json(page([inc(2, { status: 'acked' })])));
    store.setFilters({ status: 'acked' });
    await vi.waitFor(() => expect(ids()).toEqual([2]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlAt(1)).toContain('status=acked');
  });

  it('drops a stale first page after setFilters', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    store.setFilters({ status: 'open' });
    store.setFilters({ status: 'acked' });

    second.resolve(json(page([inc(2, { status: 'acked' })])));
    await vi.waitFor(() => expect(store.getList().status).toBe('ready'));
    expect(ids()).toEqual([2]);

    first.resolve(json(page([inc(1)])));
    await flush();
    await flush();

    expect(ids()).toEqual([2]);
    expect(store.getEntry(1)).toBeUndefined();
    expect(store.getList().filters.status).toBe('acked');
  });

  it('drops a loadMore page that was in flight when resync started', async () => {
    await loadList([inc(5), inc(4), inc(3)], {}, { nextCursor: 'c1', total: 10 });

    const more = deferred<Response>();
    fetchMock.mockReturnValueOnce(more.promise);
    store.loadMore();
    expect(store.getList().loadingMore).toBe(true);

    fetchMock.mockResolvedValueOnce(json(page([inc(5), inc(4), inc(3), inc(2)], { total: 4 })));
    store.resync();
    await vi.waitFor(() => expect(ids()).toEqual([5, 4, 3, 2]));

    more.resolve(json(page([inc(1)])));
    await flush();
    await flush();

    expect(ids()).toEqual([5, 4, 3, 2]);
    expect(store.getEntry(1)).toBeUndefined();
    expect(store.getList().loadingMore).toBe(false);
  });

  it('appends the next page with its cursor and marks the list complete when there is no cursor left', async () => {
    await loadList(rows(200, 100), {}, { nextCursor: 'c1', total: 150 });
    fetchMock.mockResolvedValueOnce(json(page(rows(100, 50), { nextCursor: null })));

    store.loadMore();
    await vi.waitFor(() => expect(store.getList().loadingMore).toBe(false));

    expect(urlAt(1)).toContain('cursor=c1');
    expect(ids()).toHaveLength(150);
    expect(ids()[149]).toBe(51);
    expect(store.getList().nextCursor).toBeNull();
  });

  it('resync refetches max(PAGE_SIZE, loaded) rows', async () => {
    await loadList(rows(200, 100), {}, { nextCursor: 'c1', total: 150 });
    fetchMock.mockResolvedValueOnce(json(page(rows(100, 50), { nextCursor: null })));
    store.loadMore();
    await vi.waitFor(() => expect(store.getList().loadingMore).toBe(false));
    expect(ids()).toHaveLength(150);

    fetchMock.mockResolvedValueOnce(json(page(rows(200, 150), { total: 150 })));
    store.resync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(urlAt(2)).toContain('limit=150');
    expect(urlAt(2)).not.toContain('cursor=');
  });

  it('resync is capped at 1000 rows and 5 requests', async () => {
    await loadList(rows(1200, 100), {}, { nextCursor: 'c1', total: 1200 });
    for (let k = 1; k <= 11; k++) {
      const hi = 1200 - 100 * k;
      const last = k === 11;
      fetchMock.mockResolvedValueOnce(json(page(rows(hi, 100), { nextCursor: last ? null : `c${k + 1}` })));
      store.loadMore();
      await vi.waitFor(() => expect(store.getList().loadingMore).toBe(false));
    }
    expect(ids()).toHaveLength(1200);
    expect(fetchMock).toHaveBeenCalledTimes(12);

    for (let k = 0; k < 5; k++) {
      const hi = 1200 - 200 * k;
      fetchMock.mockResolvedValueOnce(json(page(rows(hi, 200), { nextCursor: `r${k + 1}`, total: 1200 })));
    }
    store.resync();
    await vi.waitFor(() => expect(store.getList().nextCursor).toBe('r5'));

    expect(fetchMock).toHaveBeenCalledTimes(17);
    for (let i = 12; i < 17; i++) expect(urlAt(i)).toContain('limit=200');
    expect(ids()).toHaveLength(1000);
    expect(ids()[0]).toBe(1200);
    expect(ids()[999]).toBe(201);
  });

  it('resync keeps live-inserted ids above the fetched head', async () => {
    await loadList([inc(3), inc(2), inc(1)], {}, { total: 3 });
    store.applyEvent('incident.created', { incident: inc(9), audit: [] });
    expect(ids()).toEqual([9, 3, 2, 1]);

    fetchMock.mockResolvedValueOnce(json(page([inc(3), inc(2), inc(1)], { total: 3 })));
    store.resync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flush();
    await flush();

    expect(ids()).toEqual([9, 3, 2, 1]);
  });

  it('retry reloads the first page after a failed load', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    store.setFilters({});
    await vi.waitFor(() => expect(store.getList().status).toBe('error'));

    fetchMock.mockResolvedValueOnce(json(page([inc(1)])));
    store.retry();
    await vi.waitFor(() => expect(store.getList().status).toBe('ready'));
    expect(ids()).toEqual([1]);
  });
});

describe('live membership', () => {
  it('inserts a created matching incident, removes one that stops matching, and moves total with them', async () => {
    await loadList([inc(3), inc(2), inc(1)], { status: 'open' }, { total: 3 });

    store.applyEvent('incident.created', { incident: inc(4), audit: [] });
    expect(ids()).toEqual([4, 3, 2, 1]);
    expect(store.getList().total).toBe(4);

    store.applyEvent('incident.updated', { incident: inc(3, { status: 'acked', rev: 2, version: 2 }), audit: [] });
    expect(ids()).toEqual([4, 2, 1]);
    expect(store.getList().total).toBe(3);

    store.applyEvent('incident.created', { incident: inc(5, { status: 'acked' }), audit: [] });
    expect(ids()).toEqual([4, 2, 1]);
    expect(store.getList().total).toBe(3);
  });

  it('does not insert an id below the lowest loaded id while more pages exist', async () => {
    await loadList([inc(50), inc(49)], {}, { nextCursor: 'c', total: 100 });

    store.applyEvent('incident.updated', { incident: inc(10, { rev: 2 }), audit: [] });
    expect(ids()).toEqual([50, 49]);

    store.applyEvent('incident.created', { incident: inc(51), audit: [] });
    expect(ids()).toEqual([51, 50, 49]);
    expect(store.getList().total).toBe(101);
  });

  it('counts an unknown incident that flips into the filter through incident.updated', async () => {
    await loadList([inc(5), inc(4)], { status: 'open' }, { total: 2 });

    store.applyEvent('incident.updated', { incident: inc(3, { status: 'open', rev: 5 }), audit: [] });

    expect(ids()).toEqual([5, 4, 3]);
    expect(store.getList().total).toBe(3);
  });

  it('does not count an unknown incident below the loaded tail of a partial list', async () => {
    await loadList([inc(50), inc(49)], {}, { nextCursor: 'c', total: 100 });

    store.applyEvent('incident.updated', { incident: inc(10, { rev: 2 }), audit: [] });

    expect(ids()).toEqual([50, 49]);
    expect(store.getList().total).toBe(100);
  });

  it('applies a SLA breach event to the entry without touching membership', async () => {
    await loadList([inc(2), inc(1)]);
    const list = store.getList();
    const updates: Array<[number | null, string]> = [];
    const unsubscribe = store.onUpdate((id, type) => updates.push([id, type]));

    store.applyEvent('incident.sla_breached', {
      incident: inc(2, { slaBreachedAt: 1000, slaDueAt: null, rev: 2, version: 1 }),
      audit: [],
    });
    unsubscribe();

    expect(store.getEntry(2)?.inc.slaBreachedAt).toBe(1000);
    expect(store.getList()).toBe(list);
    expect(updates).toEqual([[2, 'incident.sla_breached']]);
  });
});

describe('bulkAck', () => {
  it('sends every selected loaded id with its version, acks open ones optimistically, and settles each result', async () => {
    store.seed(inc(1, { status: 'open', version: 1 }));
    store.seed(inc(2, { status: 'acked', version: 1 }));
    store.seed(inc(3, { status: 'open', version: 1 }));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    const pending = store.bulkAck([1, 2, 3, 999], { id: 'u_bob', displayName: 'Bob Okafor' });

    expect(store.getEntry(1)?.inc.status).toBe('acked');
    expect(store.getEntry(1)?.pending).toBe(1);
    expect(store.getEntry(3)?.inc.status).toBe('acked');

    response.resolve(
      json({
        results: [
          {
            id: 1,
            ok: true,
            status: 200,
            incident: inc(1, { status: 'acked', version: 2, rev: 2, ackedBy: 'u_bob' }),
          },
          {
            id: 2,
            ok: false,
            status: 409,
            error: { code: 'illegal_transition', message: 'already acked' },
            current: inc(2, { status: 'acked', version: 1, rev: 1 }),
          },
          {
            id: 3,
            ok: false,
            status: 409,
            error: { code: 'version_conflict', message: 'changed' },
            current: inc(3, { status: 'resolved', version: 2, rev: 3, resolvedBy: 'u_alice' }),
          },
        ],
      }),
    );
    const results = await pending;

    const sent = JSON.parse(String(initAt(0)?.body)) as { items: Array<{ id: number; version: number }> };
    expect(sent.items).toEqual([
      { id: 1, version: 1 },
      { id: 2, version: 1 },
      { id: 3, version: 1 },
    ]);
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(store.getEntry(1)?.inc.version).toBe(2);
    expect(store.getEntry(3)?.inc.status).toBe('resolved');
    expect([1, 2, 3].map((id) => store.getEntry(id)?.pending)).toEqual([0, 0, 0]);
  });

  it('reverts every optimistic change and reports each id when the request fails', async () => {
    store.seed(inc(1, { status: 'open' }));
    store.seed(inc(2, { status: 'open' }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const results = await store.bulkAck([1, 2], { id: 'u_bob', displayName: 'Bob Okafor' });

    expect(results.map((r) => [r.id, r.ok, r.status])).toEqual([
      [1, false, 0],
      [2, false, 0],
    ]);
    expect(store.getEntry(1)?.inc.status).toBe('open');
    expect(store.getEntry(2)?.inc.status).toBe('open');
    expect(store.getEntry(1)?.pending).toBe(0);
  });
});

describe('clear', () => {
  it('drops entries, makes later resync a no-op, and lets the next setFilters reload even with the same filters', async () => {
    await loadList([inc(1)]);
    store.clear();

    expect(store.getEntry(1)).toBeUndefined();
    expect(store.getList().status).toBe('loading');

    store.resync();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json(page([inc(2)])));
    store.setFilters({});
    await vi.waitFor(() => expect(ids()).toEqual([2]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
