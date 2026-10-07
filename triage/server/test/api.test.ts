import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepSla } from '../src/sla';
import { alertBody, api, ingest, MIN, openStream, startHarness, T0, type Harness } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.cleanup();
});

/** Creates an incident via ingest and returns its id and version. */
async function createIncident(over: Record<string, unknown> = {}): Promise<{ id: number; version: number }> {
  const res = await ingest(h, alertBody(over));
  expect(res.status).toBe(202);
  return { id: res.body.incidentId, version: res.body.incident.version };
}

function transition(id: number, action: 'ack' | 'resolve' | 'reopen', version: number, as = 'bob') {
  return api(h, 'POST', `/api/incidents/${id}/${action}`, { as, headers: { 'if-match': `"${version}"` } });
}

describe('auth and roles', () => {
  it('rejects unauthenticated reads with 401', async () => {
    const res = await api(h, 'GET', '/api/incidents');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const bad = await api(h, 'POST', '/api/auth/login', { body: { username: 'bob', password: 'nope' } });
    expect(bad.status).toBe(401);
    const unknown = await api(h, 'POST', '/api/auth/login', { body: { username: 'mallory', password: 'x' } });
    expect(unknown.status).toBe(401);
    const good = await api(h, 'POST', '/api/auth/login', { body: { username: 'bob', password: 'triage-demo' } });
    expect(good.status).toBe(200);
    expect(good.body.user).toMatchObject({ username: 'bob', role: 'responder' });
  });

  it('sets an HttpOnly, SameSite=Lax session cookie, and logout revokes it', async () => {
    const login = await api(h, 'POST', '/api/auth/login', { body: { username: 'alice', password: 'triage-demo' } });
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^triage_session=[A-Za-z0-9_-]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const token = /triage_session=([^;]+)/.exec(setCookie)?.[1] as string;
    const cookie = `triage_session=${token}`;
    const me = await fetch(`${h.base}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const out = await fetch(`${h.base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    const after = await fetch(`${h.base}/api/auth/me`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it('lets viewers read but not act (403), responders act, and admins manage roles', async () => {
    const { id, version } = await createIncident();
    const viewerAck = await transition(id, 'ack', version, 'carol');
    expect(viewerAck.status).toBe(403);
    const responderAck = await transition(id, 'ack', version, 'bob');
    expect(responderAck.status).toBe(200);

    const responderRole = await api(h, 'PATCH', '/api/users/u_carol', { as: 'bob', body: { role: 'admin' } });
    expect(responderRole.status).toBe(403);
    const adminRole = await api(h, 'PATCH', '/api/users/u_bob', { as: 'alice', body: { role: 'viewer' } });
    expect(adminRole.status).toBe(200);
  });

  it('applies a role change on the next request', async () => {
    const { id, version } = await createIncident();
    await api(h, 'PATCH', '/api/users/u_bob', { as: 'alice', body: { role: 'viewer' } });
    const res = await transition(id, 'ack', version, 'bob');
    expect(res.status).toBe(403);
  });

  it('never leaves the system without an admin', async () => {
    const res = await api(h, 'PATCH', '/api/users/u_alice', { as: 'alice', body: { role: 'responder' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('last_admin');
  });
});

describe('ingest and grouping', () => {
  it('creates an incident, then folds a second alert within 10 minutes', async () => {
    const first = await ingest(h, alertBody({ ts: T0 }));
    expect(first.body.action).toBe('created');
    h.clock.set(T0 + 9 * MIN);
    const second = await ingest(h, alertBody({ ts: T0 + 9 * MIN, title: 'p99 still high' }));
    expect(second.body.action).toBe('folded');
    expect(second.body.incidentId).toBe(first.body.incidentId);
    expect(second.body.incident).toMatchObject({ alertCount: 2, title: 'p99 still high', lastSeen: T0 + 9 * MIN });
  });

  it('folds late, out-of-order alerts without moving last_seen backwards', async () => {
    h.clock.set(T0 + 8 * MIN);
    const early = await ingest(h, alertBody({ ts: T0 + 8 * MIN }));
    // Arrives now, but its event time is 7 minutes old: a late, out-of-order alert.
    const late = await ingest(h, alertBody({ ts: T0 + MIN, title: 'older sample' }));
    expect(late.body.action).toBe('folded');
    expect(late.body.incidentId).toBe(early.body.incidentId);
    expect(late.body.incident.lastSeen).toBe(T0 + 8 * MIN);
    expect(late.body.incident.firstSeen).toBe(T0 + MIN);
    // A late alert must not overwrite the title shown for the most recent activity.
    expect(late.body.incident.title).toBe('p99 latency above 2s');
  });

  it('starts a new incident for an alert more than 10 minutes after the last one', async () => {
    const first = await ingest(h, alertBody({ ts: T0 }));
    h.clock.set(T0 + 10 * MIN + 1);
    const second = await ingest(h, alertBody({ ts: T0 + 10 * MIN + 1 }));
    expect(second.body.action).toBe('created');
    expect(second.body.incidentId).not.toBe(first.body.incidentId);
  });

  it('folds any arrival order of alerts inside the window into one incident', async () => {
    const offsets = [0, 2, 5, 7, 9];
    const orders = [
      offsets,
      [...offsets].reverse(),
      [9, 0, 7, 2, 5],
      [5, 9, 2, 0, 7],
    ];
    h.clock.set(T0 + 9 * MIN);
    for (const [i, order] of orders.entries()) {
      const fingerprint = `perm-${i}`;
      const results = [];
      for (const off of order) {
        results.push((await ingest(h, alertBody({ fingerprint, ts: T0 + off * MIN, title: `sample ${off}` }))).body);
      }
      const ids = new Set(results.map((r) => r.incidentId));
      expect(ids.size).toBe(1);
      expect(results[0].action).toBe('created');
      const last = results[results.length - 1].incident;
      expect(last.alertCount).toBe(offsets.length);
      expect(last.firstSeen).toBe(T0);
      expect(last.lastSeen).toBe(T0 + 9 * MIN);
    }
  });

  it('reopens a resolved incident for an alert within 5 minutes of the resolve, and starts a new one after', async () => {
    const { id, version } = await createIncident();
    const acked = await transition(id, 'ack', version);
    await transition(id, 'resolve', acked.body.version);
    const resolvedAt = h.clock.now();

    h.clock.set(resolvedAt + 2 * MIN);
    const flap = await ingest(h, alertBody({ ts: resolvedAt + 2 * MIN, title: 'still flapping' }));
    expect(flap.body.action).toBe('reopened');
    expect(flap.body.incidentId).toBe(id);
    expect(flap.body.incident).toMatchObject({ status: 'open', ackedAt: null, resolvedAt: null });

    const ack2 = await transition(id, 'ack', flap.body.incident.version);
    const resolve2 = await transition(id, 'resolve', ack2.body.version);
    const resolvedAgain = resolve2.body.resolvedAt as number;

    h.clock.set(resolvedAgain + 6 * MIN);
    const later = await ingest(h, alertBody({ ts: resolvedAgain + 6 * MIN }));
    expect(later.body.action).toBe('created');
    expect(later.body.incidentId).not.toBe(id);
  });

  it('attaches a late alert from before a resolved episode without reopening it', async () => {
    const { id, version } = await createIncident({ ts: T0 });
    const acked = await transition(id, 'ack', version);
    h.clock.set(T0 + 30 * MIN);
    await transition(id, 'resolve', acked.body.version);

    const late = await ingest(h, alertBody({ ts: T0 + 5 * MIN, title: 'delayed sample' }));
    expect(late.body.action).toBe('attached');
    expect(late.body.incidentId).toBe(id);
    expect(late.body.incident).toMatchObject({ status: 'resolved', alertCount: 2 });
  });

  it('honours Idempotency-Key: a retry replays the first response, a changed body is 422', async () => {
    const body = alertBody({ fingerprint: 'idem-1' });
    const first = await ingest(h, body, 'key-1');
    expect(first.status).toBe(202);
    const retry = await ingest(h, body, 'key-1');
    expect(retry.status).toBe(202);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.body).toEqual(first.body);

    const changed = await ingest(h, { ...body, title: 'something else' }, 'key-1');
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe('idempotency_key_reused');

    const detail = await api(h, 'GET', `/api/incidents/${first.body.incidentId}`, { as: 'carol' });
    expect(detail.body.incident.alertCount).toBe(1);
  });

  it('treats an identical alert as a duplicate and does not inflate counts', async () => {
    const body = alertBody({ fingerprint: 'dup-1' });
    const first = await ingest(h, body);
    const again = await ingest(h, body);
    expect(again.body.action).toBe('duplicate');
    expect(again.body.incidentId).toBe(first.body.incidentId);
    const detail = await api(h, 'GET', `/api/incidents/${first.body.incidentId}`, { as: 'carol' });
    expect(detail.body.incident.alertCount).toBe(1);
  });

  it('requires the ingest token and validates bodies with every problem listed', async () => {
    const noToken = await api(h, 'POST', '/ingest', { body: alertBody() });
    expect(noToken.status).toBe(401);
    const wrongToken = await api(h, 'POST', '/ingest', {
      body: alertBody(),
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrongToken.status).toBe(401);

    const bad = await ingest(
      h,
      alertBody({ fingerprint: '', severity: 'high', ts: 'not a time', payload: [1, 2] }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.message).toMatch(/fingerprint/);
    expect(bad.body.error.message).toMatch(/severity/);
    expect(bad.body.error.message).toMatch(/ts/);
    expect(bad.body.error.message).toMatch(/payload/);

    const future = await ingest(h, alertBody({ ts: h.clock.now() + 10 * MIN }));
    expect(future.status).toBe(400);
    expect(future.body.error.message).toMatch(/ahead of server time/);

    const wrongType = await api(h, 'POST', '/ingest', {
      raw: 'source=x',
      headers: { authorization: `Bearer ${h.app.ctx.config.ingestToken}`, 'content-type': 'text/plain' },
    });
    expect(wrongType.status).toBe(415);
  });
});

describe('state machine and optimistic concurrency', () => {
  it('requires If-Match on mutations (428) and rejects malformed values (400)', async () => {
    const { id } = await createIncident();
    const none = await api(h, 'POST', `/api/incidents/${id}/ack`, { as: 'bob' });
    expect(none.status).toBe(428);
    const junk = await api(h, 'POST', `/api/incidents/${id}/ack`, { as: 'bob', headers: { 'if-match': 'latest' } });
    expect(junk.status).toBe(400);
  });

  it('returns 409 with the current record when If-Match is stale', async () => {
    const { id, version } = await createIncident();
    const first = await transition(id, 'ack', version, 'bob');
    expect(first.status).toBe(200);
    const stale = await transition(id, 'ack', version, 'alice');
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.current).toMatchObject({ id, status: 'acked', version: 2, ackedBy: 'u_bob' });
  });

  it('bumps version and returns an ETag on success', async () => {
    const { id, version } = await createIncident();
    const res = await transition(id, 'ack', version);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    expect(res.headers.get('etag')).toBe(`"${version + 1}"`);
  });

  it('rejects illegal moves with 409 illegal_transition and the current record', async () => {
    const { id, version } = await createIncident();
    const acked = await transition(id, 'ack', version);
    const twice = await transition(id, 'ack', acked.body.version);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('illegal_transition');
    expect(twice.body.current.status).toBe('acked');

    const reopenOpen = await transition(id, 'reopen', acked.body.version);
    expect(reopenOpen.status).toBe(409);
    expect(reopenOpen.body.error.code).toBe('illegal_transition');
  });

  it('allows the full lifecycle: open, acked, resolved, reopened', async () => {
    const { id, version } = await createIncident();
    const acked = await transition(id, 'ack', version);
    const resolved = await transition(id, 'resolve', acked.body.version);
    expect(resolved.body.status).toBe('resolved');
    const reopened = await transition(id, 'reopen', resolved.body.version);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'open', resolvedAt: null, ackedAt: null });
  });

  it('lets exactly one of two concurrent acks win; the other gets 409 with the current record', async () => {
    const { id, version } = await createIncident();
    const [a, b] = await Promise.all([
      transition(id, 'ack', version, 'bob'),
      transition(id, 'ack', version, 'alice'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('version_conflict');
    expect(loser.body.current).toMatchObject({ status: 'acked', version: 2 });

    const detail = await api(h, 'GET', `/api/incidents/${id}`, { as: 'carol' });
    expect(detail.body.incident.version).toBe(2);
  });

  it('assigns, unassigns, rejects unknown users, and refuses to reassign a resolved incident', async () => {
    const { id, version } = await createIncident();
    const assigned = await api(h, 'PATCH', `/api/incidents/${id}`, {
      as: 'bob',
      body: { assigneeId: 'u_carol' },
      headers: { 'if-match': `"${version}"` },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assigneeId).toBe('u_carol');

    const unknown = await api(h, 'PATCH', `/api/incidents/${id}`, {
      as: 'bob',
      body: { assigneeId: 'u_nobody' },
      headers: { 'if-match': `"${assigned.body.version}"` },
    });
    expect(unknown.status).toBe(400);

    const unassigned = await api(h, 'PATCH', `/api/incidents/${id}`, {
      as: 'bob',
      body: { assigneeId: null },
      headers: { 'if-match': `"${assigned.body.version}"` },
    });
    expect(unassigned.body.assigneeId).toBeNull();

    const acked = await transition(id, 'ack', unassigned.body.version);
    const resolved = await transition(id, 'resolve', acked.body.version);
    const late = await api(h, 'PATCH', `/api/incidents/${id}`, {
      as: 'bob',
      body: { assigneeId: 'u_carol' },
      headers: { 'if-match': `"${resolved.body.version}"` },
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('illegal_transition');
  });
});

describe('list API', () => {
  it('paginates newest-first with an exclusive cursor, and reports total on page one', async () => {
    for (let i = 0; i < 12; i++) await createIncident({ fingerprint: `page-${i}`, title: `Page ${i}` });
    const p1 = await api(h, 'GET', '/api/incidents?limit=5', { as: 'carol' });
    expect(p1.body.items.map((i: { id: number }) => i.id)).toEqual([12, 11, 10, 9, 8]);
    expect(p1.body.total).toBe(12);
    expect(p1.body.nextCursor).toBe('8');
    const p2 = await api(h, 'GET', `/api/incidents?limit=5&cursor=${p1.body.nextCursor}`, { as: 'carol' });
    expect(p2.body.items.map((i: { id: number }) => i.id)).toEqual([7, 6, 5, 4, 3]);
    expect(p2.body.total).toBeNull();
    const p3 = await api(h, 'GET', `/api/incidents?limit=5&cursor=${p2.body.nextCursor}`, { as: 'carol' });
    expect(p3.body.items.map((i: { id: number }) => i.id)).toEqual([2, 1]);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('stays stable when incidents are inserted between page requests', async () => {
    for (let i = 0; i < 12; i++) await createIncident({ fingerprint: `stable-${i}` });
    const seen: number[] = [];
    const p1 = await api(h, 'GET', '/api/incidents?limit=5', { as: 'carol' });
    seen.push(...p1.body.items.map((i: { id: number }) => i.id));
    for (let i = 0; i < 3; i++) await createIncident({ fingerprint: `inserted-${i}` });
    let cursor: string | null = p1.body.nextCursor;
    while (cursor) {
      const page = await api(h, 'GET', `/api/incidents?limit=5&cursor=${cursor}`, { as: 'carol' });
      seen.push(...page.body.items.map((i: { id: number }) => i.id));
      cursor = page.body.nextCursor;
    }
    expect(seen).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters by status, severity, assignee, and title search, with LIKE wildcards escaped', async () => {
    const a = await createIncident({ fingerprint: 'f-a', severity: 'critical', title: 'Checkout 500s' });
    const b = await createIncident({ fingerprint: 'f-b', severity: 'warning', title: '50% of queue_jobs failing' });
    const c = await createIncident({ fingerprint: 'f-c', severity: 'info', title: 'Cache warm-up slow' });
    const acked = await transition(a.id, 'ack', a.version);
    await api(h, 'PATCH', `/api/incidents/${a.id}`, {
      as: 'bob',
      body: { assigneeId: 'u_carol' },
      headers: { 'if-match': `"${acked.body.version}"` },
    });

    const ids = async (qs: string) =>
      (await api(h, 'GET', `/api/incidents?${qs}`, { as: 'carol' })).body.items.map((i: { id: number }) => i.id);

    expect(await ids('status=acked')).toEqual([a.id]);
    expect(await ids('severity=warning')).toEqual([b.id]);
    expect(await ids('assignee=u_carol')).toEqual([a.id]);
    expect(await ids('assignee=none')).toEqual([c.id, b.id]);
    expect(await ids('q=CHECKOUT')).toEqual([a.id]);
    expect(await ids(`q=${encodeURIComponent('%')}`)).toEqual([b.id]);
    expect(await ids(`q=${encodeURIComponent('_')}`)).toEqual([b.id]);
    expect((await api(h, 'GET', '/api/incidents?status=zombie', { as: 'carol' })).status).toBe(400);
  });
});

describe('bulk ack', () => {
  it('reports per-item outcomes and keeps the successful items', async () => {
    const a = await createIncident({ fingerprint: 'bulk-a' });
    const b = await createIncident({ fingerprint: 'bulk-b' });
    const c = await createIncident({ fingerprint: 'bulk-c' });
    const preAcked = await transition(c.id, 'ack', c.version);

    const res = await api(h, 'POST', '/api/incidents/bulk-ack', {
      as: 'bob',
      body: {
        items: [
          { id: a.id, version: a.version },
          { id: c.id, version: preAcked.body.version },
          { id: b.id, version: 99 },
          { id: 424242, version: 1 },
        ],
      },
    });
    expect(res.status).toBe(200);
    const [ra, rc, rb, rmissing] = res.body.results;
    expect(ra).toMatchObject({ id: a.id, ok: true, status: 200 });
    expect(rc).toMatchObject({ id: c.id, ok: false, status: 409, error: { code: 'illegal_transition' } });
    expect(rb).toMatchObject({ id: b.id, ok: false, status: 409, error: { code: 'version_conflict' } });
    expect(rb.current).toMatchObject({ id: b.id, status: 'open' });
    expect(rmissing).toMatchObject({ id: 424242, ok: false, status: 404 });

    const after = await api(h, 'GET', `/api/incidents/${a.id}`, { as: 'carol' });
    expect(after.body.incident.status).toBe('acked');
    const untouched = await api(h, 'GET', `/api/incidents/${b.id}`, { as: 'carol' });
    expect(untouched.body.incident.status).toBe('open');
  });

  it('requires responder role and a bounded batch', async () => {
    const res = await api(h, 'POST', '/api/incidents/bulk-ack', { as: 'carol', body: { items: [{ id: 1, version: 1 }] } });
    expect(res.status).toBe(403);
    const empty = await api(h, 'POST', '/api/incidents/bulk-ack', { as: 'bob', body: { items: [] } });
    expect(empty.status).toBe(400);
  });
});

describe('live stream', () => {
  it('sends hello, then streams created and updated events with SSE ids', async () => {
    const stream = await openStream(h, 'carol');
    expect(stream.status).toBe(200);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'hello'));

    const { id, version } = await createIncident({ fingerprint: 'live-1' });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'incident.created'));
    await transition(id, 'ack', version);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'incident.updated' && e.data.incident.status === 'acked'));

    const created = stream.events.find((e) => e.event === 'incident.created');
    expect(created?.id).toEqual(expect.any(Number));
    expect(created?.data.incident.id).toBe(id);
    stream.close();
  });

  it('resumes from Last-Event-ID with exactly the missed events and no duplicates', async () => {
    const first = await openStream(h, 'carol');
    await first.waitFor((ev) => ev.some((e) => e.event === 'hello'));
    await createIncident({ fingerprint: 'resume-0' });
    await first.waitFor((ev) => ev.some((e) => e.event === 'incident.created'));
    const lastSeen = first.events.filter((e) => e.id !== null).at(-1)?.id as number;
    first.close();

    await createIncident({ fingerprint: 'resume-1' });
    await createIncident({ fingerprint: 'resume-2' });

    const second = await openStream(h, 'carol', lastSeen);
    await second.waitFor((ev) => ev.filter((e) => e.event === 'incident.created').length >= 2);
    const replayed = second.events.filter((e) => e.id !== null).map((e) => e.id);
    expect(replayed).toEqual([lastSeen + 1, lastSeen + 2]);
    expect(second.events.map((e) => e.event)).not.toContain('resync');
    second.close();
  });

  it('sends resync when the client is ahead of the server or the gap has been pruned', async () => {
    const ahead = await openStream(h, 'carol', 999_999);
    await ahead.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    expect(ahead.events.find((e) => e.event === 'resync')?.data).toEqual({ head: 0 });
    ahead.close();

    await createIncident({ fingerprint: 'prune-0' });
    await createIncident({ fingerprint: 'prune-1' });
    h.app.ctx.db.run('DELETE FROM events WHERE seq <= 1');
    const pruned = await openStream(h, 'carol', 0);
    await pruned.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    pruned.close();
  });
});

describe('SLA', () => {
  it('breaches a critical unacked incident after exactly 5 minutes and broadcasts it', async () => {
    const stream = await openStream(h, 'carol');
    await stream.waitFor((ev) => ev.some((e) => e.event === 'hello'));
    const { id } = await createIncident({ fingerprint: 'sla-1', severity: 'critical', ts: T0 });

    h.clock.set(T0 + 5 * MIN - 1);
    expect(sweepSla(h.app.ctx)).toBe(0);

    h.clock.set(T0 + 5 * MIN);
    expect(sweepSla(h.app.ctx)).toBe(1);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'incident.sla_breached'));
    const breach = stream.events.find((e) => e.event === 'incident.sla_breached');
    expect(breach?.data.incident).toMatchObject({ id, slaBreachedAt: T0 + 5 * MIN, slaDueAt: null });
    expect(breach?.data.audit[0]).toMatchObject({ action: 'incident.sla_breached', actorName: 'SLA monitor' });
    stream.close();
  });

  it('does not breach an incident that is acked in time', async () => {
    const { id, version } = await createIncident({ fingerprint: 'sla-2', severity: 'critical', ts: T0 });
    h.clock.set(T0 + 2 * MIN);
    await transition(id, 'ack', version);
    h.clock.set(T0 + 30 * MIN);
    expect(sweepSla(h.app.ctx)).toBe(0);
    const detail = await api(h, 'GET', `/api/incidents/${id}`, { as: 'carol' });
    expect(detail.body.incident).toMatchObject({ status: 'acked', slaBreachedAt: null, slaDueAt: null });
  });

  it('starts the clock when a warning escalates to critical, using receipt time', async () => {
    const first = await createIncident({ fingerprint: 'sla-3', severity: 'warning', ts: T0 });
    h.clock.set(T0 + 3 * MIN);
    const escalated = await ingest(h, alertBody({ fingerprint: 'sla-3', severity: 'critical', ts: T0 + 3 * MIN }));
    expect(escalated.body.incidentId).toBe(first.id);
    expect(escalated.body.incident.slaDueAt).toBe(T0 + 8 * MIN);
    h.clock.set(T0 + 7 * MIN);
    expect(sweepSla(h.app.ctx)).toBe(0);
    h.clock.set(T0 + 8 * MIN);
    expect(sweepSla(h.app.ctx)).toBe(1);
  });

  it('survives a restart: a breach that came due while the server was down is applied on startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-restart-'));
    const dbPath = join(dir, 'restart.db');
    try {
      const first = await startHarness({ dbPath, start: T0 });
      const res = await ingest(first, alertBody({ fingerprint: 'restart-1', severity: 'critical', ts: T0 }));
      const id = res.body.incidentId as number;
      await first.app.stop();

      const second = await startHarness({ dbPath, start: T0 + 6 * MIN });
      expect(sweepSla(second.app.ctx)).toBe(1);
      const detail = await api(second, 'GET', `/api/incidents/${id}`, { as: 'carol' });
      expect(detail.body.incident.slaBreachedAt).toBe(T0 + 5 * MIN);
      await second.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('audit log', () => {
  it('records actor, action, and before/after state for every lifecycle change', async () => {
    const { id, version } = await createIncident({ fingerprint: 'audit-1' });
    await transition(id, 'ack', version, 'bob');
    const detail = await api(h, 'GET', `/api/incidents/${id}`, { as: 'carol' });
    const [acked, created] = detail.body.audit;
    expect(acked).toMatchObject({
      action: 'incident.acked',
      actor: 'u_bob',
      actorName: 'Bob Okafor',
      before: { status: 'open', version: 1 },
      after: { status: 'acked', version: 2 },
    });
    expect(created).toMatchObject({ action: 'incident.created', actor: 'system:ingest', before: null });
  });

  it('refuses UPDATE and DELETE on the audit table at the database level', async () => {
    await createIncident({ fingerprint: 'audit-2' });
    expect(() => h.app.ctx.db.raw.exec("UPDATE audit_log SET action = 'tampered'")).toThrow(/append-only/);
    expect(() => h.app.ctx.db.raw.exec('DELETE FROM audit_log')).toThrow(/append-only/);
  });
});
