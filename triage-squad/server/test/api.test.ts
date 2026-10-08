import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLA_CRITICAL_MS } from '../../shared/rules';
import { DEFAULT_INGEST_TOKEN } from '../src/config';
import { openStream, MAX_BUFFERED_BYTES } from '../src/sse';
import { sweepSla } from '../src/sla';
import {
  alertBody,
  call,
  createIncident,
  ingest,
  login,
  MIN,
  SEC,
  SseClient,
  startTestServer,
  T0,
  type Reply,
  type TestServer,
} from './helpers';

const servers: TestServer[] = [];

async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(options);
  servers.push(s);
  return s;
}

interface World {
  s: TestServer;
  alice: string;
  bob: string;
  carol: string;
}

/** A fresh server with alice (admin), bob (responder) and carol (viewer) signed in. */
async function world(options: Parameters<typeof startTestServer>[0] = {}): Promise<World> {
  const s = await server(options);
  return {
    s,
    alice: await login(s, 'alice'),
    bob: await login(s, 'bob'),
    carol: await login(s, 'carol'),
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function idsOf(reply: Reply): number[] {
  return (reply.json.items as Array<{ id: number }>).map((i) => i.id);
}

/** Polls until pred is true. Throws after timeoutMs. */
async function eventually(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('auth, sessions and roles', () => {
  it('rejects requests without a session with 401 unauthenticated', async () => {
    const { s } = await world();
    for (const path of ['/api/auth/me', '/api/incidents', '/api/users', '/api/audit', '/api/stream']) {
      const reply = await call(s.base, path);
      expect(reply.status, path).toBe(401);
      expect(reply.json.error.code, path).toBe('unauthenticated');
    }
  });

  it('returns 401 invalid_credentials for a wrong password and for an unknown user', async () => {
    const { s } = await world();
    const wrong = await call(s.base, '/api/auth/login', { json: { username: 'bob', password: 'nope' } });
    const unknown = await call(s.base, '/api/auth/login', { json: { username: 'mallory', password: 'triage-demo' } });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('invalid_credentials');
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.code).toBe('invalid_credentials');
  });

  it('sets HttpOnly, SameSite=Lax and Path=/ on the session cookie, and Secure only when configured', async () => {
    const plain = await world();
    const reply = await call(plain.s.base, '/api/auth/login', { json: { username: 'bob', password: 'triage-demo' } });
    expect(reply.status).toBe(200);
    expect(reply.json.user).toMatchObject({ id: 'u_bob', role: 'responder' });
    const cookie = reply.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^triage_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');

    const secure = await world({ config: { cookieSecure: true } });
    const secureReply = await call(secure.s.base, '/api/auth/login', {
      json: { username: 'bob', password: 'triage-demo' },
    });
    expect(secureReply.headers.get('set-cookie')).toContain('Secure');
  });

  it('logout clears the cookie and deletes the session on the server', async () => {
    const { s, bob } = await world();
    expect((await call(s.base, '/api/auth/me', { cookie: bob })).status).toBe(200);

    const out = await call(s.base, '/api/auth/logout', { method: 'POST', cookie: bob });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^triage_session=;.*Max-Age=0/);

    const after = await call(s.base, '/api/auth/me', { cookie: bob });
    expect(after.status).toBe(401);
  });

  it('viewers can read but get 403 forbidden on every mutation', async () => {
    const { s, carol } = await world();
    const { id } = await createIncident(s);
    expect((await call(s.base, '/api/incidents', { cookie: carol })).status).toBe(200);

    const ack = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: carol, ifMatch: '1' });
    expect(ack.status).toBe(403);
    expect(ack.json.error.code).toBe('forbidden');

    const assign = await call(s.base, `/api/incidents/${id}`, {
      method: 'PATCH',
      cookie: carol,
      ifMatch: '1',
      json: { assigneeId: 'u_carol' },
    });
    expect(assign.status).toBe(403);

    const bulk = await call(s.base, '/api/incidents/bulk-ack', {
      cookie: carol,
      json: { items: [{ id, version: 1 }] },
    });
    expect(bulk.status).toBe(403);
  });

  it('a role change applies on the next request, with no re-login', async () => {
    const { s, alice, bob } = await world();
    const { id } = await createIncident(s);

    const demote = await call(s.base, '/api/users/u_bob', { method: 'PATCH', cookie: alice, json: { role: 'viewer' } });
    expect(demote.status).toBe(200);
    expect(demote.json.user).toMatchObject({ id: 'u_bob', role: 'viewer' });

    const denied = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });
    expect(denied.status).toBe(403);

    await call(s.base, '/api/users/u_bob', { method: 'PATCH', cookie: alice, json: { role: 'responder' } });
    const allowed = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });
    expect(allowed.status).toBe(200);
  });

  it('the last admin cannot be demoted (409 last_admin)', async () => {
    const { s, alice, bob } = await world();
    const self = await call(s.base, '/api/users/u_alice', { method: 'PATCH', cookie: alice, json: { role: 'viewer' } });
    expect(self.status).toBe(409);
    expect(self.json.error.code).toBe('last_admin');

    await call(s.base, '/api/users/u_bob', { method: 'PATCH', cookie: alice, json: { role: 'admin' } });
    const aliceDemoted = await call(s.base, '/api/users/u_alice', {
      method: 'PATCH',
      cookie: alice,
      json: { role: 'responder' },
    });
    expect(aliceDemoted.status).toBe(200);

    const lastOne = await call(s.base, '/api/users/u_bob', { method: 'PATCH', cookie: bob, json: { role: 'viewer' } });
    expect(lastOne.status).toBe(409);
    expect(lastOne.json.error.code).toBe('last_admin');
  });

  it('PATCH /api/users needs admin and a valid role, and GET /api/users lists the demo users', async () => {
    const { s, alice, bob, carol } = await world();
    const byBob = await call(s.base, '/api/users/u_carol', { method: 'PATCH', cookie: bob, json: { role: 'admin' } });
    expect(byBob.status).toBe(403);

    const bad = await call(s.base, '/api/users/u_carol', { method: 'PATCH', cookie: alice, json: { role: 'god' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation_failed');

    const list = await call(s.base, '/api/users', { cookie: carol });
    expect(list.status).toBe(200);
    expect(list.json.users.map((u: { id: string }) => u.id).sort()).toEqual(['u_alice', 'u_bob', 'u_carol']);
  });

  it('rejects cross-origin unsafe requests with 403 cross_origin and allows same-origin ones', async () => {
    const { s } = await world();
    const host = `http://127.0.0.1:${s.port}`;
    const blocked = await call(s.base, '/api/auth/login', {
      json: { username: 'bob', password: 'triage-demo' },
      origin: 'http://evil.example',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('cross_origin');

    const allowed = await call(s.base, '/api/auth/login', {
      json: { username: 'bob', password: 'triage-demo' },
      origin: host,
    });
    expect(allowed.status).toBe(200);

    const readOnly = await call(s.base, '/healthz', { origin: 'http://evil.example' });
    expect(readOnly.status).toBe(200);
  });

  it('login needs a JSON body with username and password', async () => {
    const { s } = await world();
    const wrongType = await call(s.base, '/api/auth/login', {
      body: 'username=bob',
      contentType: 'text/plain',
    });
    expect(wrongType.status).toBe(415);
    expect(wrongType.json.error.code).toBe('unsupported_media_type');

    const missing = await call(s.base, '/api/auth/login', { json: { username: 'bob' } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe('validation_failed');

    const broken = await call(s.base, '/api/auth/login', { body: '{not json', contentType: 'application/json' });
    expect(broken.status).toBe(400);
    expect(broken.json.error.code).toBe('invalid_json');
  });
});

describe('optimistic concurrency (D4, D5)', () => {
  it('mutations need If-Match (428), reject malformed values (400), and accept 3, "3" and W/"3"', async () => {
    const { s, bob } = await world();
    const { id } = await createIncident(s);

    const none = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob });
    expect(none.status).toBe(428);
    expect(none.json.error.code).toBe('precondition_required');

    for (const bad of ['abc', '*', 'W/abc', '"1', '']) {
      const reply = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob, ifMatch: bad });
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(reply.json.error.code).toBe('bad_if_match');
    }

    // Each assignment bumps version, so the three If-Match forms can be checked in turn.
    const forms: Array<[string, string, number]> = [
      ['1', 'u_bob', 2],
      ['"2"', 'u_alice', 3],
      ['W/"3"', 'u_bob', 4],
    ];
    for (const [ifMatch, assigneeId, nextVersion] of forms) {
      const reply = await call(s.base, `/api/incidents/${id}`, {
        method: 'PATCH',
        cookie: bob,
        ifMatch,
        json: { assigneeId },
      });
      expect(reply.status, ifMatch).toBe(200);
      expect(reply.json.version).toBe(nextVersion);
      expect(reply.headers.get('etag')).toBe(`"${nextVersion}"`);
    }
  });

  it('a stale If-Match gets 409 version_conflict with the current incident', async () => {
    const { s, bob } = await world();
    const { id } = await createIncident(s);
    const stale = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob, ifMatch: '"7"' });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('version_conflict');
    expect(stale.json.current).toMatchObject({ id, version: 1, status: 'open' });
  });

  it('an illegal transition gets 409 illegal_transition with the current incident', async () => {
    const { s, bob } = await world();
    const { id } = await createIncident(s);
    const reopen = await call(s.base, `/api/incidents/${id}/reopen`, { method: 'POST', cookie: bob, ifMatch: '1' });
    expect(reopen.status).toBe(409);
    expect(reopen.json.error.code).toBe('illegal_transition');
    expect(reopen.json.current).toMatchObject({ id, version: 1, status: 'open' });
  });

  it('two concurrent acks: exactly one 200, the other is 409 with the current incident', async () => {
    const { s, bob, alice } = await world();
    const { id } = await createIncident(s);
    const [a, b] = await Promise.all([
      call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' }),
      call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: alice, ifMatch: '1' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.json.error.code).toBe('version_conflict');
    expect(loser.json.current).toMatchObject({ id, status: 'acked', version: 2 });
    expect(winner.json).toMatchObject({ id, status: 'acked', version: 2 });
  });

  it('GET detail carries the version as an ETag, and a no-op assign does not bump the version', async () => {
    const { s, bob } = await world();
    const { id } = await createIncident(s);
    const detail = await call(s.base, `/api/incidents/${id}`, { cookie: bob });
    expect(detail.status).toBe(200);
    expect(detail.headers.get('etag')).toBe('"1"');
    expect(detail.json.alerts).toHaveLength(1);
    expect(detail.json.audit[0].action).toBe('incident.created');

    const assign = await call(s.base, `/api/incidents/${id}`, {
      method: 'PATCH',
      cookie: bob,
      ifMatch: '1',
      json: { assigneeId: 'u_bob' },
    });
    expect(assign.json.version).toBe(2);
    const same = await call(s.base, `/api/incidents/${id}`, {
      method: 'PATCH',
      cookie: bob,
      ifMatch: '2',
      json: { assigneeId: 'u_bob' },
    });
    expect(same.status).toBe(200);
    expect(same.json.version).toBe(2);
  });

  it('assigning an unknown user is 400 unknown_assignee, and assigning a resolved incident is 409', async () => {
    const { s, bob } = await world();
    const { id } = await createIncident(s);
    const unknown = await call(s.base, `/api/incidents/${id}`, {
      method: 'PATCH',
      cookie: bob,
      ifMatch: '1',
      json: { assigneeId: 'u_nobody' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.code).toBe('unknown_assignee');

    await call(s.base, `/api/incidents/${id}/resolve`, { method: 'POST', cookie: bob, ifMatch: '1' });
    const onResolved = await call(s.base, `/api/incidents/${id}`, {
      method: 'PATCH',
      cookie: bob,
      ifMatch: '2',
      json: { assigneeId: 'u_bob' },
    });
    expect(onResolved.status).toBe(409);
    expect(onResolved.json.error.code).toBe('illegal_transition');
  });

  it('check order is auth, then exists, then If-Match, then version, then legality (D5)', async () => {
    const { s, bob, carol } = await world();
    const { id } = await createIncident(s);

    // Anonymous mutations are 401 whatever else is sent.
    const anon = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', ifMatch: '1' });
    expect(anon.status).toBe(401);
    expect((await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST' })).status).toBe(401);

    // Viewers are 403 before any If-Match check, on every mutation route.
    for (const path of ['ack', 'resolve', 'reopen']) {
      const viewer = await call(s.base, `/api/incidents/${id}/${path}`, { method: 'POST', cookie: carol });
      expect(viewer.status, path).toBe(403);
      expect(viewer.json.error.code).toBe('forbidden');
    }
    const viewerPatch = await call(s.base, `/api/incidents/${id}`, {
      method: 'PATCH',
      cookie: carol,
      json: { assigneeId: 'u_carol' },
    });
    expect(viewerPatch.status).toBe(403);

    // A missing incident is 404, with or without If-Match.
    const missingNoMatch = await call(s.base, '/api/incidents/999/ack', { method: 'POST', cookie: bob });
    expect(missingNoMatch.status).toBe(404);
    expect(missingNoMatch.json.error.code).toBe('not_found');
    const missing = await call(s.base, '/api/incidents/999/ack', { method: 'POST', cookie: bob, ifMatch: '1' });
    expect(missing.status).toBe(404);
    const missingPatch = await call(s.base, '/api/incidents/999', {
      method: 'PATCH',
      cookie: bob,
      json: { assigneeId: 'u_bob' },
    });
    expect(missingPatch.status).toBe(404);

    // An existing incident without If-Match is 428 on every responder route.
    expect((await call(s.base, `/api/incidents/${id}/resolve`, { method: 'POST', cookie: bob })).status).toBe(428);

    // A stale version on an illegal transition is version_conflict, not illegal_transition.
    const acked = await call(s.base, `/api/incidents/${id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });
    expect(acked.status).toBe(200);
    const staleIllegal = await call(s.base, `/api/incidents/${id}/reopen`, { method: 'POST', cookie: bob, ifMatch: '1' });
    expect(staleIllegal.status).toBe(409);
    expect(staleIllegal.json.error.code).toBe('version_conflict');
    expect(staleIllegal.json.current).toMatchObject({ id, status: 'acked', version: 2 });
    // The same illegal request with the current version is illegal_transition.
    const currentIllegal = await call(s.base, `/api/incidents/${id}/reopen`, { method: 'POST', cookie: bob, ifMatch: '2' });
    expect(currentIllegal.status).toBe(409);
    expect(currentIllegal.json.error.code).toBe('illegal_transition');
  });
});

describe('incident list', () => {
  it('pagination is stable under inserts between pages (keyset on id, newest first)', async () => {
    const { s, carol } = await world();
    for (let i = 1; i <= 5; i++) await createIncident(s, { fingerprint: `fp-page-${i}`, title: `Page ${i}` });

    const first = await call(s.base, '/api/incidents?limit=2', { cookie: carol });
    expect(idsOf(first)).toEqual([5, 4]);
    expect(first.json.nextCursor).toBe('4');
    expect(first.json.total).toBe(5);

    // An insert between pages goes to the top and must not shift or duplicate the next page.
    await createIncident(s, { fingerprint: 'fp-page-6', title: 'Page 6' });

    const second = await call(s.base, `/api/incidents?limit=2&cursor=${first.json.nextCursor}`, { cookie: carol });
    expect(idsOf(second)).toEqual([3, 2]);
    expect(second.json.total).toBeNull();

    const third = await call(s.base, `/api/incidents?limit=2&cursor=${second.json.nextCursor}`, { cookie: carol });
    expect(idsOf(third)).toEqual([1]);
    expect(third.json.nextCursor).toBeNull();
  });

  it('filters by status, severity and assignee', async () => {
    const { s, bob, carol } = await world();
    const a = await createIncident(s, { fingerprint: 'fp-f-a', title: 'Alpha' });
    const b = await createIncident(s, { fingerprint: 'fp-f-b', title: 'Beta', severity: 'critical' });
    await call(s.base, `/api/incidents/${a.id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });
    await call(s.base, `/api/incidents/${b.id}`, { method: 'PATCH', cookie: bob, ifMatch: '1', json: { assigneeId: 'u_bob' } });

    const acked = await call(s.base, '/api/incidents?status=acked', { cookie: carol });
    expect(idsOf(acked)).toEqual([a.id]);
    const critical = await call(s.base, '/api/incidents?severity=critical', { cookie: carol });
    expect(idsOf(critical)).toEqual([b.id]);
    const mine = await call(s.base, '/api/incidents?assignee=u_bob', { cookie: carol });
    expect(idsOf(mine)).toEqual([b.id]);
    const unassigned = await call(s.base, '/api/incidents?assignee=none', { cookie: carol });
    expect(idsOf(unassigned)).toEqual([a.id]);
  });

  it('title search escapes LIKE wildcards: % and _ are literal characters', async () => {
    const { s, carol } = await world();
    const pct = await createIncident(s, { fingerprint: 'fp-pct-1', title: 'Latency 100% over budget' });
    const plain = await createIncident(s, { fingerprint: 'fp-pct-2', title: 'Latency 100 over budget' });
    const under = await createIncident(s, { fingerprint: 'fp-us-1', title: 'queue_depth high' });
    const x = await createIncident(s, { fingerprint: 'fp-us-2', title: 'queueXdepth high' });

    const percent = await call(s.base, `/api/incidents?q=${encodeURIComponent('%')}`, { cookie: carol });
    expect(idsOf(percent)).toEqual([pct.id]);

    const underscore = await call(s.base, `/api/incidents?q=${encodeURIComponent('_')}`, { cookie: carol });
    expect(idsOf(underscore)).toEqual([under.id]);

    const exact = await call(s.base, `/api/incidents?q=${encodeURIComponent('queue_depth')}`, { cookie: carol });
    expect(idsOf(exact)).toEqual([under.id]);

    const substring = await call(s.base, `/api/incidents?q=${encodeURIComponent('DEPTH')}`, { cookie: carol });
    expect(idsOf(substring)).toEqual([x.id, under.id]);
    expect(substring.json.total).toBe(2);
    expect(plain.id).not.toBe(pct.id);
  });

  it('rejects bad list parameters with 400', async () => {
    const { s, carol } = await world();
    await createIncident(s);
    const cases: Array<[string, string]> = [
      ['status=bogus', 'validation_failed'],
      ['severity=loud', 'validation_failed'],
      ['cursor=abc', 'bad_cursor'],
      ['limit=0', 'bad_limit'],
      ['limit=201', 'bad_limit'],
      [`q=${'a'.repeat(201)}`, 'bad_query'],
    ];
    for (const [query, code] of cases) {
      const reply = await call(s.base, `/api/incidents?${query}`, { cookie: carol });
      expect(reply.status, query).toBe(400);
      expect(reply.json.error.code, query).toBe(code);
    }
  });
});

describe('bulk ack', () => {
  it('reports each item on its own: ok, stale version, and not found', async () => {
    const { s, bob } = await world();
    const a = await createIncident(s, { fingerprint: 'fp-bulk-a' });
    const b = await createIncident(s, { fingerprint: 'fp-bulk-b' });
    const c = await createIncident(s, { fingerprint: 'fp-bulk-c' });
    await call(s.base, `/api/incidents/${b.id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });

    const reply = await call(s.base, '/api/incidents/bulk-ack', {
      cookie: bob,
      json: {
        items: [
          { id: a.id, version: 1 },
          { id: b.id, version: 1 },
          { id: c.id, version: 1 },
          { id: 999, version: 1 },
        ],
      },
    });
    expect(reply.status).toBe(200);
    const [ra, rb, rc, rd] = reply.json.results;
    expect(ra).toMatchObject({ id: a.id, ok: true, status: 200 });
    expect(ra.incident.status).toBe('acked');
    expect(rb).toMatchObject({ id: b.id, ok: false, status: 409 });
    expect(rb.error.code).toBe('version_conflict');
    expect(rb.current).toMatchObject({ id: b.id, status: 'acked', version: 2 });
    expect(rc).toMatchObject({ id: c.id, ok: true, status: 200 });
    expect(rd).toMatchObject({ id: 999, ok: false, status: 404 });
    expect(rd.error.code).toBe('not_found');

    // Each item is its own transaction, so a and c are acked even though b and 999 failed.
    const list = await call(s.base, '/api/incidents?status=acked', { cookie: bob });
    expect(idsOf(list).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('validates the item list (1 to 500 entries, integer fields)', async () => {
    const { s, bob } = await world();
    const empty = await call(s.base, '/api/incidents/bulk-ack', { cookie: bob, json: { items: [] } });
    expect(empty.status).toBe(400);
    expect(empty.json.error.code).toBe('validation_failed');

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, version: 1 }));
    const big = await call(s.base, '/api/incidents/bulk-ack', { cookie: bob, json: { items: tooMany } });
    expect(big.status).toBe(400);

    const badFields = await call(s.base, '/api/incidents/bulk-ack', {
      cookie: bob,
      json: { items: [{ id: 'x', version: 1 }, { id: 1 }] },
    });
    expect(badFields.status).toBe(400);
    expect(badFields.json.error.message).toContain('items[0].id');
    expect(badFields.json.error.message).toContain('items[1].version');
  });
});

describe('audit feed', () => {
  it('is newest first, pages with before, and needs a session', async () => {
    const { s, bob, carol } = await world();
    const a = await createIncident(s, { fingerprint: 'fp-audit-a' });
    await createIncident(s, { fingerprint: 'fp-audit-b' });
    await call(s.base, `/api/incidents/${a.id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });

    const page1 = await call(s.base, '/api/audit?limit=3', { cookie: carol });
    expect(page1.status).toBe(200);
    const ids1 = (page1.json.entries as Array<{ id: number }>).map((e) => e.id);
    expect(ids1).toHaveLength(3);
    expect([...ids1].sort((x, y) => y - x)).toEqual(ids1);
    expect(page1.json.serverTime).toBe(s.clock.now());

    const page2 = await call(s.base, `/api/audit?limit=3&before=${ids1[2]}`, { cookie: carol });
    const ids2 = (page2.json.entries as Array<{ id: number }>).map((e) => e.id);
    expect(ids2.every((id) => id < ids1[2]!)).toBe(true);

    const everything = await call(s.base, '/api/audit?limit=200', { cookie: carol });
    const actions = (everything.json.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login', 'incident.created', 'incident.acked']));
    const acked = (everything.json.entries as Array<{ action: string; actorName: string; before: unknown; after: unknown }>)
      .find((e) => e.action === 'incident.acked');
    expect(acked).toMatchObject({ actorName: 'Bob Okafor' });
    expect(acked?.before).toMatchObject({ status: 'open', version: 1 });
    expect(acked?.after).toMatchObject({ status: 'acked', version: 2 });

    expect((await call(s.base, '/api/audit?limit=0', { cookie: carol })).status).toBe(400);
    expect((await call(s.base, '/api/audit')).status).toBe(401);
  });
});

describe('live stream (D12)', () => {
  it('sends hello first, then live events with ids equal to their event seq', async () => {
    const { s, bob, carol } = await world();
    const stream = await SseClient.open(s.base, { cookie: carol });
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');
    await stream.waitFor((ev) => ev.some((e) => e.event === 'hello'));
    const hello = stream.ofType('hello')[0]!;
    expect(hello.id).toBeUndefined();
    expect(hello.json).toEqual({ serverTime: s.clock.now(), head: 0 });

    const created = await createIncident(s, { fingerprint: 'fp-live' });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'incident.created'));
    const createdEvent = stream.ofType('incident.created')[0]!;
    expect(createdEvent.id).toBe(1);
    expect(createdEvent.json.incident).toMatchObject({ id: created.id, status: 'open' });
    expect(createdEvent.json.audit[0].action).toBe('incident.created');

    await call(s.base, `/api/incidents/${created.id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'incident.updated'));
    expect(stream.ofType('incident.updated')[0]!.id).toBe(2);
    stream.close();
  });

  it('resume via Last-Event-ID (or ?lastEventId=) gives exactly the missed events, no duplicates', async () => {
    const { s, bob, carol } = await world();
    const first = await createIncident(s, { fingerprint: 'fp-r-0', title: 'Resume zero' });
    const client = await SseClient.open(s.base, { cookie: carol });
    await client.waitFor((ev) => ev.some((e) => e.event === 'hello'));
    await call(s.base, `/api/incidents/${first.id}/ack`, { method: 'POST', cookie: bob, ifMatch: '1' });
    await client.waitFor((ev) => ev.some((e) => e.event === 'incident.updated'));
    const lastSeen = client.events.filter((e) => e.id !== undefined).at(-1)!.id!;
    client.close();

    // Three events happen while the client is away.
    const missed = [];
    for (const n of [1, 2, 3]) missed.push(await createIncident(s, { fingerprint: `fp-r-${n}`, title: `Missed ${n}` }));

    const header = await SseClient.open(s.base, { cookie: carol, 'last-event-id': String(lastSeen) });
    await header.waitFor((ev) => ev.filter((e) => e.id !== undefined).length >= 3);
    await new Promise((r) => setTimeout(r, 50));
    const withIds = header.events.filter((e) => e.id !== undefined);
    expect(withIds.map((e) => e.id)).toEqual([lastSeen + 1, lastSeen + 2, lastSeen + 3]);
    expect(withIds.map((e) => e.json.incident.id)).toEqual(missed.map((m) => m.id));
    expect(header.ofType('hello')).toHaveLength(1);
    header.close();

    // The same resume with the query-string form. Two more events are missed.
    const after = lastSeen + 3;
    await createIncident(s, { fingerprint: 'fp-r-4', title: 'Missed 4' });
    await createIncident(s, { fingerprint: 'fp-r-5', title: 'Missed 5' });
    const query = await SseClient.open(s.base, { cookie: carol }, `?lastEventId=${after}`);
    await query.waitFor((ev) => ev.filter((e) => e.id !== undefined).length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(query.events.filter((e) => e.id !== undefined).map((e) => e.id)).toEqual([after + 1, after + 2]);
    query.close();
  });

  it('without Last-Event-ID the stream starts at head and replays nothing', async () => {
    const { s, carol } = await world();
    await createIncident(s, { fingerprint: 'fp-head-1' });
    await createIncident(s, { fingerprint: 'fp-head-2' });
    const stream = await SseClient.open(s.base, { cookie: carol });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'hello'));
    await new Promise((r) => setTimeout(r, 50));
    expect(stream.ofType('hello')[0]!.json.head).toBe(2);
    expect(stream.events.filter((e) => e.id !== undefined)).toHaveLength(0);
    stream.close();
  });

  it('resyncs when the id is ahead of head, invalid, or its events were pruned', async () => {
    const { s, carol } = await world();
    for (let i = 1; i <= 4; i++) await createIncident(s, { fingerprint: `fp-rs-${i}` });

    const ahead = await SseClient.open(s.base, { cookie: carol, 'last-event-id': '104' });
    await ahead.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    expect(ahead.ofType('resync')[0]).toMatchObject({ id: 4, json: { head: 4 } });
    expect(ahead.ofType('incident.created')).toHaveLength(0);
    ahead.close();

    const invalid = await SseClient.open(s.base, { cookie: carol, 'last-event-id': 'abc' });
    await invalid.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    expect(invalid.ofType('resync')[0]!.json).toEqual({ head: 4 });
    invalid.close();

    // Prune events 1 and 2. Resuming after 1 has a gap (2 is gone), resuming after 2 has none.
    s.app.ctx.db.run('DELETE FROM events WHERE seq <= ?', 2);
    const gap = await SseClient.open(s.base, { cookie: carol, 'last-event-id': '1' });
    await gap.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    expect(gap.ofType('incident.created')).toHaveLength(0);
    gap.close();

    const exact = await SseClient.open(s.base, { cookie: carol, 'last-event-id': '2' });
    await exact.waitFor((ev) => ev.filter((e) => e.id !== undefined).length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(exact.ofType('resync')).toHaveLength(0);
    expect(exact.events.filter((e) => e.id !== undefined).map((e) => e.id)).toEqual([3, 4]);
    exact.close();
  });

  it('resyncs when more than 5000 events would be replayed, and replays exactly 5000', async () => {
    const { s, carol } = await world();
    const db = s.app.ctx.db;
    db.tx(() => {
      for (let i = 0; i < 5001; i++) {
        db.run('INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)', 'incident.updated', '{}', T0);
      }
    });

    const tooMany = await SseClient.open(s.base, { cookie: carol, 'last-event-id': '0' });
    await tooMany.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    expect(tooMany.ofType('resync')[0]!.json).toEqual({ head: 5001 });
    expect(tooMany.ofType('incident.updated')).toHaveLength(0);
    tooMany.close();

    const limit = await SseClient.open(s.base, { cookie: carol, 'last-event-id': '1' });
    await limit.waitFor((ev) => ev.filter((e) => e.id !== undefined).length >= 5000, 5_000);
    expect(limit.ofType('resync')).toHaveLength(0);
    const ids = limit.events.filter((e) => e.id !== undefined).map((e) => e.id);
    expect(ids[0]).toBe(2);
    expect(ids.at(-1)).toBe(5001);
    limit.close();
  });

  it('broadcasts an SLA breach on the stream with the audit entry', async () => {
    const { s, carol } = await world();
    const incident = await createIncident(s, { fingerprint: 'fp-sla', severity: 'critical', title: 'Payments down' });
    const stream = await SseClient.open(s.base, { cookie: carol });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'hello'));

    s.clock.set(T0 + SLA_CRITICAL_MS - 1);
    expect(sweepSla(s.app.ctx)).toBe(0);
    s.clock.set(T0 + SLA_CRITICAL_MS);
    expect(sweepSla(s.app.ctx)).toBe(1);

    await stream.waitFor((ev) => ev.some((e) => e.event === 'incident.sla_breached'));
    const breach = stream.ofType('incident.sla_breached')[0]!;
    expect(breach.json.incident).toMatchObject({ id: incident.id, slaBreachedAt: T0 + SLA_CRITICAL_MS });
    expect(breach.json.audit[0]).toMatchObject({ action: 'incident.sla_breached', actor: 'system:sla' });
    stream.close();
  });

  it('sends pings while the session is valid and closes the stream once it expires', async () => {
    const s = await server({ config: { sseHeartbeatMs: 20 } });
    const cookie = await login(s, 'carol');
    const stream = await SseClient.open(s.base, { cookie });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'ping'));
    expect(stream.ofType('ping')[0]!.json).toEqual({ serverTime: s.clock.now() });
    expect(stream.ofType('ping')[0]!.id).toBeUndefined();

    s.clock.advance(12 * 3_600_000 + 1);
    await stream.waitFor(() => stream.ended, 2_000);
  });

  it('a stream opened while alerts arrive gets each event once, in order, with no gaps', async () => {
    const { s, carol } = await world();
    await createIncident(s, { fingerprint: 'fp-race-0' }); // seq 1, replayed from Last-Event-ID 1 onwards
    const burst = Array.from({ length: 6 }, (_, i) => createIncident(s, { fingerprint: `fp-race-${i + 1}` }));
    const opening = SseClient.open(s.base, { cookie: carol, 'last-event-id': '1' });
    await Promise.all(burst);
    const stream = await opening;

    await stream.waitFor((ev) => ev.filter((e) => e.id !== undefined).length >= 6);
    await new Promise((r) => setTimeout(r, 50));
    const ids = stream.events.filter((e) => e.id !== undefined).map((e) => e.id);
    expect(ids).toEqual([2, 3, 4, 5, 6, 7]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(stream.ofType('resync')).toHaveLength(0);
    stream.close();
  });

  it('Last-Event-ID wins over ?lastEventId= when both are sent, even when the query is valid and the header is not', async () => {
    const { s, carol } = await world();
    for (let i = 1; i <= 3; i++) await createIncident(s, { fingerprint: `fp-prec-${i}` });

    // Header 1, query 0: the header wins, so only 2 and 3 are replayed.
    const headerWins = await SseClient.open(s.base, { cookie: carol, 'last-event-id': '1' }, '?lastEventId=0');
    await headerWins.waitFor((ev) => ev.filter((e) => e.id !== undefined).length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(headerWins.events.filter((e) => e.id !== undefined).map((e) => e.id)).toEqual([2, 3]);
    expect(headerWins.ofType('resync')).toHaveLength(0);
    headerWins.close();

    // Header invalid, query valid: the header is what counts, so the answer is resync.
    const invalidHeader = await SseClient.open(s.base, { cookie: carol, 'last-event-id': 'abc' }, '?lastEventId=2');
    await invalidHeader.waitFor((ev) => ev.some((e) => e.event === 'resync'));
    expect(invalidHeader.ofType('resync')[0]!.json).toEqual({ head: 3 });
    expect(invalidHeader.ofType('incident.created')).toHaveLength(0);
    invalidHeader.close();
  });

  it('a client that disconnects leaves the hub and its heartbeat timer stops', async () => {
    const s = await server({ config: { sseHeartbeatMs: 20 } });
    const cookie = await login(s, 'carol');
    const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timeouts();

    const stream = await SseClient.open(s.base, { cookie });
    await stream.waitFor((ev) => ev.some((e) => e.event === 'ping'));
    expect(s.app.ctx.hub.size).toBe(1);
    expect(timeouts()).toBeGreaterThan(before);

    stream.close();
    await eventually(() => s.app.ctx.hub.size === 0);
    await eventually(() => timeouts() <= before);
    expect(timeouts()).toBeLessThanOrEqual(before);
  });
});

/** A response stand-in for openStream: records writes and lets the test set the buffered byte count. */
class FakeResponse extends EventEmitter {
  writableLength = 0;
  readonly writes: string[] = [];
  destroyed = false;
  ended = false;
  writeHead(): this {
    return this;
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
    this.emit('close');
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

describe('stream backpressure (D12)', () => {
  it('closes a subscriber whose unsent backlog exceeds 1 MB, and it leaves the hub', async () => {
    const s = await server();
    const cookie = await login(s, 'carol');
    const token = cookie.slice('triage_session='.length);
    const res = new FakeResponse();
    const req = { headers: {} } as unknown as IncomingMessage;
    openStream(s.app.ctx, req, res as unknown as ServerResponse, new URL('http://localhost/api/stream'), token);
    expect(s.app.ctx.hub.size).toBe(1);

    res.writableLength = MAX_BUFFERED_BYTES;
    await createIncident(s, { fingerprint: 'fp-slow-at-limit' });
    expect(res.destroyed).toBe(false);
    expect(s.app.ctx.hub.size).toBe(1);

    res.writableLength = MAX_BUFFERED_BYTES + 1;
    await createIncident(s, { fingerprint: 'fp-slow-over-limit' });
    expect(res.destroyed).toBe(true);
    expect(s.app.ctx.hub.size).toBe(0);
  });
});

describe('ingest (D2, D10, D13)', () => {
  it('requires the bearer ingest token (401 bad_ingest_token)', async () => {
    const { s } = await world();
    const body = alertBody(s.clock.now());
    const none = await call(s.base, '/ingest', { json: body });
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe('bad_ingest_token');

    const wrong = await ingest(s, body, { bearer: 'not-the-token' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('bad_ingest_token');

    const ok = await ingest(s, body, { bearer: DEFAULT_INGEST_TOKEN });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ action: 'created', incidentId: 1 });
    expect(ok.json.incident).toMatchObject({ status: 'open', version: 1 });
  });

  it('lists every validation problem in one 400 validation_failed', async () => {
    const { s } = await world();
    const reply = await ingest(s, {
      source: '',
      fingerprint: '',
      title: '   ',
      severity: 'loud',
      ts: 'not a date',
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('validation_failed');
    for (const word of ['source', 'fingerprint', 'title', 'severity', 'ts']) {
      expect(reply.json.error.message).toContain(word);
    }
  });

  it('rejects non-JSON with 415 and bodies over 64 KB with 413', async () => {
    const { s } = await world();
    const text = await call(s.base, '/ingest', {
      body: 'source=x',
      contentType: 'text/plain',
      bearer: DEFAULT_INGEST_TOKEN,
    });
    expect(text.status).toBe(415);

    const huge = await ingest(s, alertBody(s.clock.now(), { payload: { blob: 'x'.repeat(70_000) } }));
    expect(huge.status).toBe(413);
    expect(huge.json.error.code).toBe('payload_too_large');
  });

  it('rejects ts more than 60 s in the future, accepts exactly 60 s, and accepts ISO strings', async () => {
    const { s } = await world();
    const tooFar = await ingest(s, alertBody(T0 + 61 * SEC, { fingerprint: 'fp-future' }));
    expect(tooFar.status).toBe(400);
    expect(tooFar.json.error.message).toContain('60 seconds in the future');

    const edge = await ingest(s, alertBody(T0 + 60 * SEC, { fingerprint: 'fp-future-edge' }));
    expect(edge.status).toBe(202);

    // Advance the clock first, then the same future-looking alert is within skew.
    s.clock.set(T0 + 10 * MIN);
    const later = await ingest(s, alertBody(T0 + 10 * MIN + 60 * SEC, { fingerprint: 'fp-future-later' }));
    expect(later.status).toBe(202);

    const iso = await ingest(s, alertBody(new Date(T0 + 11 * MIN).toISOString(), { fingerprint: 'fp-iso' }));
    expect(iso.status).toBe(202);
    expect(iso.json.incident.firstSeen).toBe(T0 + 11 * MIN);
  });

  it('a repeated Idempotency-Key replays the stored response; a different alert under that key is 422', async () => {
    const { s, carol } = await world();
    const body = alertBody(s.clock.now(), { fingerprint: 'fp-idem', title: 'Idempotent alert' });

    const first = await ingest(s, body, { idempotencyKey: 'key-1' });
    expect(first.status).toBe(202);
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    const second = await ingest(s, body, { idempotencyKey: 'key-1' });
    expect(second.status).toBe(202);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.json).toEqual(first.json);

    const list = await call(s.base, '/api/incidents', { cookie: carol });
    expect(list.json.total).toBe(1);

    const reused = await ingest(s, alertBody(s.clock.now(), { fingerprint: 'fp-other' }), { idempotencyKey: 'key-1' });
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe('idempotency_key_reused');
  });

  it('an identical alert without a key is reported as a duplicate and changes nothing', async () => {
    const { s } = await world();
    const body = alertBody(s.clock.now(), { fingerprint: 'fp-dup' });
    const first = await ingest(s, body);
    const again = await ingest(s, body);
    expect(first.json.action).toBe('created');
    expect(again.json).toMatchObject({ action: 'duplicate', incidentId: first.json.incidentId });
    expect(again.json.incident.alertCount).toBe(1);
  });

  it('an over-long Idempotency-Key is 400 bad_idempotency_key', async () => {
    const { s } = await world();
    const reply = await ingest(s, alertBody(s.clock.now()), { idempotencyKey: 'k'.repeat(256) });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('bad_idempotency_key');
  });
});

describe('health, static and routing', () => {
  it('healthz is public JSON, and the wrong method gets 405 with Allow', async () => {
    const s = await server();
    const ok = await call(s.base, '/healthz');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, serverTime: T0 });
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');

    const wrong = await call(s.base, '/healthz', { method: 'POST' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    expect(wrong.json.error.code).toBe('method_not_allowed');
  });

  it('with TRIAGE_WEB_DIR=none, page paths are 404 and API paths are JSON 404', async () => {
    const s = await server({ config: { webDir: null } });
    const page = await call(s.base, '/');
    expect(page.status).toBe(404);
    const api = await call(s.base, '/api/nope');
    expect(api.status).toBe(404);
    expect(api.json.error.code).toBe('not_found');
  });

  it('serves the built SPA with fallback, CSP, nosniff, and a traversal guard; API paths never fall back', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'triage-web-'));
    const dir = join(parent, 'web');
    try {
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Triage</title>');
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
      // A file next to the web root, reachable only by escaping it.
      writeFileSync(join(parent, 'secret.txt'), 'should not be served');
      const s = await server({ config: { webDir: dir } });

      const root = await call(s.base, '/');
      expect(root.status).toBe(200);
      expect(root.headers.get('content-type')).toContain('text/html');
      expect(root.headers.get('cache-control')).toBe('no-cache');
      expect(root.text).toContain('<title>Triage</title>');
      expect(root.headers.get('content-security-policy')).toBe(
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      expect(root.headers.get('x-content-type-options')).toBe('nosniff');

      const deep = await call(s.base, '/incidents/42');
      expect(deep.status).toBe(200);
      expect(deep.text).toContain('<title>Triage</title>');

      const asset = await call(s.base, '/assets/app.js');
      expect(asset.headers.get('content-type')).toContain('javascript');
      expect(asset.headers.get('cache-control')).toContain('immutable');

      expect((await call(s.base, '/assets/missing.js')).status).toBe(404);

      const traversal = await call(s.base, '/..%2F..%2F..%2Fetc%2Fpasswd');
      expect(traversal.status).toBe(404);
      const sibling = await call(s.base, '/..%2Fsecret.txt');
      expect(sibling.status).toBe(404);
      expect(sibling.text).not.toContain('should not be served');

      const api = await call(s.base, '/api/nope');
      expect(api.status).toBe(404);
      expect(api.json.error.code).toBe('not_found');
      expect((await call(s.base, '/ingest/extra')).status).toBe(404);
      expect((await call(s.base, '/healthz/extra')).status).toBe(404);
      expect((await call(s.base, '/ingest')).status).toBe(405);

      // Encoded or differently cased API prefixes are still API paths: JSON 404, never the SPA.
      for (const path of ['/%61pi/incidents', '/API/incidents', '/Healthz', '/%49ngest/x']) {
        const reply = await call(s.base, path);
        expect(reply.status, path).toBe(404);
        expect(reply.headers.get('content-type'), path).toContain('application/json');
        expect(reply.json.error.code, path).toBe('not_found');
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('an unexpected server error is a JSON 500 internal_error, not plain text', async () => {
    const s = await server();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      s.clock.now = () => {
        throw new Error('clock broke');
      };
      const reply = await call(s.base, '/healthz');
      expect(reply.status).toBe(500);
      expect(reply.headers.get('content-type')).toContain('application/json');
      expect(reply.json).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('the SLA sweep, when called directly, is what breaches (timers are off in tests)', async () => {
    const { s, carol } = await world();
    await createIncident(s, { severity: 'critical', fingerprint: 'fp-timers' });
    s.clock.advance(SLA_CRITICAL_MS);
    expect(sweepSla(s.app.ctx)).toBe(1);
    const detail = await call(s.base, '/api/incidents/1', { cookie: carol });
    expect(detail.json.incident.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
  });
});
