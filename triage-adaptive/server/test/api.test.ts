import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepSla } from '../src/sla';
import { openStream, type StreamHandle } from '../src/sse';
import {
  alertBody,
  call,
  createIncident,
  type Harness,
  ingest,
  ingestOk,
  login,
  MINUTE,
  startHarness,
  T0,
  TEST_INGEST_TOKEN,
} from './helpers';
import type { AuditDTO, IncidentDTO } from '../../shared/types';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

// ---------------------------------------------------------------- auth

describe('auth', () => {
  it('rejects anonymous reads with 401 unauthenticated', async () => {
    const list = await call(h, 'GET', '/api/incidents');
    expect(list.status).toBe(401);
    expect(list.json.error.code).toBe('unauthenticated');
    const me = await call(h, 'GET', '/api/auth/me');
    expect(me.status).toBe(401);
    expect(me.json.error.code).toBe('unauthenticated');
  });

  it('logs in and sets the session cookie with HttpOnly, SameSite=Lax and Path=/', async () => {
    const r = await call(h, 'POST', '/api/auth/login', { body: { username: 'alice', password: 'triage-demo' } });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ username: 'alice', role: 'admin', displayName: 'Alice Chen' });
    expect(r.json.serverTime).toBe(h.clock.now());
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^triage_session=[A-Za-z0-9_-]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('adds Secure to the cookie when TRIAGE_COOKIE_SECURE is on', async () => {
    const secure = await startHarness({ config: { cookieSecure: true } });
    try {
      const r = await call(secure, 'POST', '/api/auth/login', { body: { username: 'bob', password: 'triage-demo' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie')).toContain('; Secure');
    } finally {
      await secure.close();
    }
  });

  it('returns 401 invalid_credentials for a wrong password and for an unknown user', async () => {
    const wrong = await call(h, 'POST', '/api/auth/login', { body: { username: 'bob', password: 'nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('invalid_credentials');
    const unknown = await call(h, 'POST', '/api/auth/login', { body: { username: 'mallory', password: 'triage-demo' } });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.code).toBe('invalid_credentials');
  });

  it('validates the login body', async () => {
    const r = await call(h, 'POST', '/api/auth/login', { body: { username: 'bob' } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_failed');
  });

  it('GET /api/auth/me returns the signed-in user', async () => {
    const cookie = await login(h, 'bob');
    const r = await call(h, 'GET', '/api/auth/me', { cookie });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ username: 'bob', role: 'responder' });
    expect(r.json.serverTime).toBe(h.clock.now());
  });

  it('logout returns 204, clears the cookie and revokes the session', async () => {
    const cookie = await login(h, 'bob');
    const out = await call(h, 'POST', '/api/auth/logout', { cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const after = await call(h, 'GET', '/api/auth/me', { cookie });
    expect(after.status).toBe(401);
  });

  it('enforces roles: a viewer cannot ack, a responder cannot manage users', async () => {
    const carol = await login(h, 'carol');
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);

    const ack = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: carol, ifMatch: 1 });
    expect(ack.status).toBe(403);
    expect(ack.json.error.code).toBe('forbidden');

    const bulk = await call(h, 'POST', '/api/incidents/bulk-ack', {
      cookie: carol,
      body: { items: [{ id: inc.id, version: 1 }] },
    });
    expect(bulk.status).toBe(403);

    const users = await call(h, 'PATCH', '/api/users/u_carol', { cookie: bob, body: { role: 'admin' } });
    expect(users.status).toBe(403);

    const list = await call(h, 'GET', '/api/incidents', { cookie: carol });
    expect(list.status).toBe(200);
  });

  it('checks authentication before the precondition: no session gives 401 even without If-Match', async () => {
    const inc = await createIncident(h);
    const r = await call(h, 'POST', `/api/incidents/${inc.id}/ack`);
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthenticated');
  });

  it('applies a role change to an existing session immediately', async () => {
    const alice = await login(h, 'alice');
    const bob = await login(h, 'bob');
    const first = await createIncident(h);
    const second = await createIncident(h);

    const ok = await call(h, 'POST', `/api/incidents/${first.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ok.status).toBe(200);

    const demote = await call(h, 'PATCH', '/api/users/u_bob', { cookie: alice, body: { role: 'viewer' } });
    expect(demote.status).toBe(200);
    expect(demote.json.user).toMatchObject({ id: 'u_bob', role: 'viewer' });

    // Bob's existing cookie is still valid, but the role is read on every request.
    const denied = await call(h, 'POST', `/api/incidents/${second.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
    const still = await call(h, 'GET', '/api/auth/me', { cookie: bob });
    expect(still.json.user.role).toBe('viewer');

    const promote = await call(h, 'PATCH', '/api/users/u_bob', { cookie: alice, body: { role: 'responder' } });
    expect(promote.status).toBe(200);
    const allowed = await call(h, 'POST', `/api/incidents/${second.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(allowed.status).toBe(200);
  });

  it('refuses to demote the last admin with 409 last_admin', async () => {
    const alice = await login(h, 'alice');
    const solo = await call(h, 'PATCH', '/api/users/u_alice', { cookie: alice, body: { role: 'responder' } });
    expect(solo.status).toBe(409);
    expect(solo.json.error.code).toBe('last_admin');

    const promote = await call(h, 'PATCH', '/api/users/u_carol', { cookie: alice, body: { role: 'admin' } });
    expect(promote.status).toBe(200);
    const alicedown = await call(h, 'PATCH', '/api/users/u_alice', { cookie: alice, body: { role: 'responder' } });
    expect(alicedown.status).toBe(200);

    const carol = await login(h, 'carol');
    const last = await call(h, 'PATCH', '/api/users/u_carol', { cookie: carol, body: { role: 'viewer' } });
    expect(last.status).toBe(409);
    expect(last.json.error.code).toBe('last_admin');
  });

  it('PATCH /api/users/:id validates the role and reports unknown users', async () => {
    const alice = await login(h, 'alice');
    const bad = await call(h, 'PATCH', '/api/users/u_bob', { cookie: alice, body: { role: 'god' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation_failed');
    const missing = await call(h, 'PATCH', '/api/users/u_nobody', { cookie: alice, body: { role: 'viewer' } });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------- preconditions and errors

describe('preconditions and errors', () => {
  it('requires If-Match (428) and rejects malformed values (400 bad_if_match)', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);

    const none = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob });
    expect(none.status).toBe(428);
    expect(none.json.error.code).toBe('precondition_required');

    for (const bad of ['abc', '"x"', '-1', '1.5']) {
      const r = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: bad });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('bad_if_match');
    }
  });

  it('accepts 3, "3" and W/"3" forms and answers with an ETag', async () => {
    const bob = await login(h, 'bob');
    const ids = [await createIncident(h), await createIncident(h), await createIncident(h)];
    const forms = ['1', '"1"', 'W/"1"'];
    for (let i = 0; i < ids.length; i += 1) {
      const r = await call(h, 'POST', `/api/incidents/${ids[i]!.id}/ack`, { cookie: bob, ifMatch: forms[i]! });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ id: ids[i]!.id, status: 'acked', version: 2 });
      expect(r.headers.get('etag')).toBe('"2"');
    }
  });

  it('reports version_conflict with the current record (409)', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const first = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(first.status).toBe(200);

    const stale = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('version_conflict');
    expect(stale.json.current).toMatchObject({ id: inc.id, status: 'acked', version: 2 });
  });

  it('reports illegal_transition with the current record (409)', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const resolved = await call(h, 'POST', `/api/incidents/${inc.id}/resolve`, { cookie: bob, ifMatch: 1 });
    expect(resolved.status).toBe(200);
    expect(resolved.json.status).toBe('resolved');

    const ack = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 2 });
    expect(ack.status).toBe(409);
    expect(ack.json.error.code).toBe('illegal_transition');
    expect(ack.json.current).toMatchObject({ status: 'resolved', version: 2 });
  });

  it('returns 404 not_found for an unknown incident once the caller is authorised', async () => {
    const bob = await login(h, 'bob');
    const r = await call(h, 'POST', '/api/incidents/999/ack', { cookie: bob, ifMatch: 1 });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });

  it('checks role before precondition, and precondition (428) before existence (404)', async () => {
    // SPEC D5 lists 404 before the version check. The If-Match header is parsed before the record is
    // loaded, so a mutation without a precondition never reads the incident at all. A 404 is only
    // reported to a caller that sent a valid If-Match.
    const carol = await login(h, 'carol');
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const viewerNoIfMatch = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: carol });
    expect(viewerNoIfMatch.status).toBe(403);
    const missingNoIfMatch = await call(h, 'POST', '/api/incidents/999/ack', { cookie: bob });
    expect(missingNoIfMatch.status).toBe(428);
    const missingWithIfMatch = await call(h, 'POST', '/api/incidents/999/ack', { cookie: bob, ifMatch: 1 });
    expect(missingWithIfMatch.status).toBe(404);
  });

  it('a stale If-Match with an unknown assignee is 409 version_conflict, not 400 unknown_assignee', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const ack = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ack.status).toBe(200);
    const r = await call(h, 'PATCH', `/api/incidents/${inc.id}`, {
      cookie: bob,
      ifMatch: 1,
      body: { assigneeId: 'u_nobody' },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('version_conflict');
    expect(r.json.current).toMatchObject({ id: inc.id, version: 2, assigneeId: null });
  });

  it('PATCH with the same assignee is a no-op: 200, unchanged version and ETag', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const first = await call(h, 'PATCH', `/api/incidents/${inc.id}`, {
      cookie: bob,
      ifMatch: 1,
      body: { assigneeId: 'u_bob' },
    });
    expect(first.status).toBe(200);
    expect(first.json.version).toBe(2);
    const again = await call(h, 'PATCH', `/api/incidents/${inc.id}`, {
      cookie: bob,
      ifMatch: 2,
      body: { assigneeId: 'u_bob' },
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ assigneeId: 'u_bob', version: 2 });
    expect(again.headers.get('etag')).toBe('"2"');
  });

  it('PATCH /api/users/:id validates the body before looking up the user', async () => {
    const alice = await login(h, 'alice');
    const badRole = await call(h, 'PATCH', '/api/users/u_nobody', { cookie: alice, body: { role: 'boss' } });
    expect(badRole.status).toBe(400);
    expect(badRole.json.error.code).toBe('validation_failed');
    const unknown = await call(h, 'PATCH', '/api/users/u_nobody', { cookie: alice, body: { role: 'viewer' } });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('not_found');
  });

  it('returns 415 unsupported_media_type for a body that is not application/json', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const patch = await call(h, 'PATCH', `/api/incidents/${inc.id}`, {
      cookie: bob,
      ifMatch: 1,
      rawBody: '{"assigneeId":null}',
      contentType: 'text/plain',
    });
    expect(patch.status).toBe(415);
    expect(patch.json.error.code).toBe('unsupported_media_type');

    const login415 = await call(h, 'POST', '/api/auth/login', {
      rawBody: 'username=bob',
      contentType: 'text/plain',
    });
    expect(login415.status).toBe(415);
  });

  it('returns 413 payload_too_large above 64 KB', async () => {
    const big = alertBody(h, { payload: { blob: 'a'.repeat(70_000) } });
    const r = await ingest(h, big);
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('payload_too_large');
  });

  it('returns 400 bad_request for a body that is not valid JSON', async () => {
    const r = await call(h, 'POST', '/api/auth/login', { rawBody: '{not json', contentType: 'application/json' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
  });

  it('validates query parameters with 400 bad_request', async () => {
    const bob = await login(h, 'bob');
    for (const qs of [
      'limit=0',
      'limit=201',
      'limit=abc',
      'status=bogus',
      'severity=loud',
      'cursor=abc',
      `q=${'x'.repeat(201)}`,
    ]) {
      const r = await call(h, 'GET', `/api/incidents?${qs}`, { cookie: bob });
      expect(r.status, qs).toBe(400);
      expect(r.json.error.code, qs).toBe('bad_request');
    }
    const audit = await call(h, 'GET', '/api/audit?limit=0', { cookie: bob });
    expect(audit.status).toBe(400);
    expect(audit.json.error.code).toBe('bad_request');
  });
});

// ---------------------------------------------------------------- concurrency

describe('concurrency', () => {
  it('two concurrent acks: exactly one 200 and one 409', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const [a, b] = await Promise.all([
      call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 1 }),
      call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.error.code).toBe('version_conflict');
    expect(loser.json.current).toMatchObject({ status: 'acked', version: 2 });
  });

  it('two concurrent assigns with the same If-Match: one 200, one 409 version_conflict', async () => {
    // Both assigns are legal on an open incident, so only the version check can reject the loser.
    const bob = await login(h, 'bob');
    const alice = await login(h, 'alice');
    const inc = await createIncident(h);
    const [a, b] = await Promise.all([
      call(h, 'PATCH', `/api/incidents/${inc.id}`, { cookie: bob, ifMatch: 1, body: { assigneeId: 'u_bob' } }),
      call(h, 'PATCH', `/api/incidents/${inc.id}`, { cookie: alice, ifMatch: 1, body: { assigneeId: 'u_alice' } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 409 ? a : b;
    expect(loser.json.error.code).toBe('version_conflict');
    expect(loser.json.current).toMatchObject({ version: 2, assigneeId: winner.json.assigneeId });
    const after = await call(h, 'GET', `/api/incidents/${inc.id}`, { cookie: bob });
    expect(after.json.incident).toMatchObject({ version: 2, assigneeId: winner.json.assigneeId });
  });
});

// ---------------------------------------------------------------- list and detail

describe('incident list and detail', () => {
  it('paginates newest first, and the keyset cursor is stable under inserts between pages', async () => {
    const bob = await login(h, 'bob');
    for (let i = 1; i <= 5; i += 1) await createIncident(h, { fingerprint: `page-${i}`, title: `Page ${i}` });

    const first = await call(h, 'GET', '/api/incidents?limit=2', { cookie: bob });
    expect(first.status).toBe(200);
    expect(first.json.items.map((x: IncidentDTO) => x.id)).toEqual([5, 4]);
    expect(first.json.total).toBe(5);
    expect(first.json.nextCursor).toBe('4');
    expect(first.json.serverTime).toBe(h.clock.now());

    // New incidents arrive between pages; they must not shift the next page.
    await createIncident(h, { fingerprint: 'page-6', title: 'Page 6' });
    await createIncident(h, { fingerprint: 'page-7', title: 'Page 7' });

    const second = await call(h, 'GET', `/api/incidents?limit=2&cursor=${first.json.nextCursor}`, { cookie: bob });
    expect(second.json.items.map((x: IncidentDTO) => x.id)).toEqual([3, 2]);
    expect(second.json.total).toBeNull();

    const third = await call(h, 'GET', `/api/incidents?limit=2&cursor=${second.json.nextCursor}`, { cookie: bob });
    expect(third.json.items.map((x: IncidentDTO) => x.id)).toEqual([1]);
    expect(third.json.nextCursor).toBeNull();
  });

  it('filters by status, severity and assignee', async () => {
    const bob = await login(h, 'bob');
    const a = await createIncident(h, { fingerprint: 'fa', title: 'Disk full', severity: 'warning' });
    const b = await createIncident(h, { fingerprint: 'fb', title: 'Database latency', severity: 'critical' });
    const c = await createIncident(h, { fingerprint: 'fc', title: 'Cert expiring', severity: 'info' });

    const assign = await call(h, 'PATCH', `/api/incidents/${b.id}`, {
      cookie: bob,
      ifMatch: 1,
      body: { assigneeId: 'u_bob' },
    });
    expect(assign.status).toBe(200);
    expect(assign.json).toMatchObject({ assigneeId: 'u_bob', version: 2 });
    const ack = await call(h, 'POST', `/api/incidents/${c.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ack.status).toBe(200);

    const ids = async (qs: string): Promise<number[]> => {
      const r = await call(h, 'GET', `/api/incidents?${qs}`, { cookie: bob });
      expect(r.status).toBe(200);
      return r.json.items.map((x: IncidentDTO) => x.id);
    };
    expect(await ids('status=acked')).toEqual([c.id]);
    expect(await ids('severity=critical')).toEqual([b.id]);
    expect(await ids('assignee=u_bob')).toEqual([b.id]);
    expect(await ids('assignee=none')).toEqual([c.id, a.id]);
    expect(await ids('status=open&severity=warning')).toEqual([a.id]);
  });

  it('matches q literally, so % and _ are not wildcards', async () => {
    const bob = await login(h, 'bob');
    const pct = await createIncident(h, { fingerprint: 'q1', title: 'Load at 100% capacity' });
    await createIncident(h, { fingerprint: 'q2', title: 'Load at 100x capacity' });
    const underscore = await createIncident(h, { fingerprint: 'q3', title: 'queue_depth high' });
    await createIncident(h, { fingerprint: 'q4', title: 'queueXdepth high' });

    const ids = async (qs: string): Promise<number[]> => {
      const r = await call(h, 'GET', `/api/incidents?${qs}`, { cookie: bob });
      expect(r.status).toBe(200);
      return r.json.items.map((x: IncidentDTO) => x.id);
    };
    expect(await ids('q=%25')).toEqual([pct.id]);
    expect(await ids('q=100%25')).toEqual([pct.id]);
    expect(await ids('q=_')).toEqual([underscore.id]);
    expect(await ids('q=queue_depth')).toEqual([underscore.id]);
  });

  it('returns the detail with alerts, audit and an ETag', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h, { fingerprint: 'detail-fp', title: 'Queue backlog' });
    await ingestOk(h, { fingerprint: 'detail-fp', title: 'Queue backlog still', ts: h.clock.now() + 1 });

    const r = await call(h, 'GET', `/api/incidents/${inc.id}`, { cookie: bob });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('"1"');
    expect(r.json.incident).toMatchObject({ id: inc.id, alertCount: 2, version: 1 });
    expect(r.json.alerts).toHaveLength(2);
    expect(r.json.alerts[0].ts).toBeGreaterThanOrEqual(r.json.alerts[1].ts);
    expect(r.json.audit.map((a: AuditDTO) => a.action)).toEqual(['incident.created']);
    expect(r.json.serverTime).toBe(h.clock.now());

    const missing = await call(h, 'GET', '/api/incidents/abc', { cookie: bob });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------- bulk ack

describe('bulk ack', () => {
  it('validates the item count (1-500) and item shape', async () => {
    const bob = await login(h, 'bob');
    const empty = await call(h, 'POST', '/api/incidents/bulk-ack', { cookie: bob, body: { items: [] } });
    expect(empty.status).toBe(400);
    expect(empty.json.error.code).toBe('validation_failed');

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, version: 1 }));
    const big = await call(h, 'POST', '/api/incidents/bulk-ack', { cookie: bob, body: { items: tooMany } });
    expect(big.status).toBe(400);

    const shape = await call(h, 'POST', '/api/incidents/bulk-ack', {
      cookie: bob,
      body: { items: [{ id: 'x', version: 1 }, { id: 1 }] },
    });
    expect(shape.status).toBe(400);
    expect(shape.json.error.message).toContain('items[0].id');
    expect(shape.json.error.message).toContain('items[1].version');
  });

  it('returns a per-item result with the same ordering as the request', async () => {
    const bob = await login(h, 'bob');
    const x = await createIncident(h, { fingerprint: 'bx' });
    const y = await createIncident(h, { fingerprint: 'by' });
    const z = await createIncident(h, { fingerprint: 'bz' });
    const preAck = await call(h, 'POST', `/api/incidents/${z.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(preAck.status).toBe(200);

    const r = await call(h, 'POST', '/api/incidents/bulk-ack', {
      cookie: bob,
      body: {
        items: [
          { id: x.id, version: 1 },
          { id: y.id, version: 5 },
          { id: z.id, version: 2 },
          { id: 999, version: 1 },
        ],
      },
    });
    expect(r.status).toBe(200);
    const [rx, ry, rz, r999] = r.json.results;
    expect(rx).toMatchObject({ id: x.id, ok: true, status: 200 });
    expect(rx.incident).toMatchObject({ status: 'acked', version: 2 });

    expect(ry).toMatchObject({ id: y.id, ok: false, status: 409 });
    expect(ry.error.code).toBe('version_conflict');
    expect(ry.current).toMatchObject({ id: y.id, status: 'open', version: 1 });

    expect(rz).toMatchObject({ id: z.id, ok: false, status: 409 });
    expect(rz.error.code).toBe('illegal_transition');
    expect(rz.current).toMatchObject({ status: 'acked' });

    expect(r999).toMatchObject({ id: 999, ok: false, status: 404 });
    expect(r999.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------- audit

describe('audit feed', () => {
  it('lists audit newest first, with before cursor and limit', async () => {
    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const ack = await call(h, 'POST', `/api/incidents/${inc.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ack.status).toBe(200);

    const page = await call(h, 'GET', '/api/audit?limit=2', { cookie: bob });
    expect(page.status).toBe(200);
    expect(page.json.serverTime).toBe(h.clock.now());
    expect(page.json.entries.map((e: AuditDTO) => e.action)).toEqual(['incident.acked', 'incident.created']);
    expect(page.json.entries[0].actorName).toBe('Bob Okafor');
    expect(page.json.entries[0].before).toMatchObject({ status: 'open', version: 1 });
    expect(page.json.entries[0].after).toMatchObject({ status: 'acked', version: 2 });

    const older = await call(h, 'GET', `/api/audit?limit=200&before=${page.json.entries[1].id}`, { cookie: bob });
    expect(older.json.entries.map((e: AuditDTO) => e.action)).toEqual(['auth.login']);
  });
});

// ---------------------------------------------------------------- ingest

describe('ingest', () => {
  it('rejects a missing or wrong ingest token with 401 bad_ingest_token', async () => {
    const none = await ingest(h, alertBody(h), { token: null });
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe('bad_ingest_token');
    const wrong = await ingest(h, alertBody(h), { token: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('bad_ingest_token');
    const ok = await ingest(h, alertBody(h), { token: TEST_INGEST_TOKEN });
    expect(ok.status).toBe(202);
  });

  it('lists every validation problem in one 400 validation_failed', async () => {
    const r = await ingest(h, {
      source: '',
      fingerprint: 'x',
      severity: 'loud',
      title: '   ',
      ts: 'not a date',
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_failed');
    for (const field of ['source:', 'severity:', 'title:', 'ts:']) {
      expect(r.json.error.message).toContain(field);
    }
  });

  it('rejects a text/plain body with 415', async () => {
    const r = await ingest(h, {}, { rawBody: 'source=x', contentType: 'text/plain' });
    expect(r.status).toBe(415);
    expect(r.json.error.code).toBe('unsupported_media_type');
  });

  it('rejects a ts more than 60 s in the future, and accepts exactly 60 s', async () => {
    const edge = await ingest(h, alertBody(h, { ts: h.clock.now() + 60_000 }));
    expect(edge.status).toBe(202);
    const future = await ingest(h, alertBody(h, { ts: h.clock.now() + 60_001 }));
    expect(future.status).toBe(400);
    expect(future.json.error.code).toBe('validation_failed');
    expect(future.json.error.message).toContain('future');
  });

  it('accepts an ISO 8601 ts', async () => {
    const r = await ingest(h, alertBody(h, { ts: '2026-10-08T11:59:00Z' }));
    expect(r.status).toBe(202);
    expect(r.json.action).toBe('created');
    expect(r.json.incident.lastSeen).toBe(Date.parse('2026-10-08T11:59:00Z'));
  });

  it('replays an Idempotency-Key with Idempotent-Replayed and rejects a reused key with 422', async () => {
    const body = alertBody(h, { fingerprint: 'idem-fp', title: 'Idempotent alert' });
    const first = await ingest(h, body, { key: 'k-1' });
    expect(first.status).toBe(202);
    expect(first.json.action).toBe('created');
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    const replay = await ingest(h, body, { key: 'k-1' });
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.json).toEqual(first.json);

    const reused = await ingest(h, { ...body, title: 'Different title' }, { key: 'k-1' });
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe('idempotency_key_reused');
  });

  it('reports identical content as action duplicate', async () => {
    const body = alertBody(h, { fingerprint: 'dup-fp', title: 'Same alert' });
    const first = await ingest(h, body);
    const second = await ingest(h, body);
    expect(first.json.action).toBe('created');
    expect(second.status).toBe(202);
    expect(second.json.action).toBe('duplicate');
    expect(second.json.incidentId).toBe(first.json.incidentId);
  });

  it('rejects an Idempotency-Key longer than 255 characters with 400', async () => {
    const r = await ingest(h, alertBody(h), { key: 'x'.repeat(256) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_failed');
  });
});

// ---------------------------------------------------------------- cross-origin

describe('cross-origin protection', () => {
  it('blocks unsafe requests whose Origin host differs from Host with 403 cross_origin', async () => {
    const body = { username: 'bob', password: 'triage-demo' };
    const evil = await call(h, 'POST', '/api/auth/login', {
      body,
      headers: { Origin: 'http://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe('cross_origin');

    const nullOrigin = await call(h, 'POST', '/api/auth/login', { body, headers: { Origin: 'null' } });
    expect(nullOrigin.status).toBe(403);

    const bob = await login(h, 'bob');
    const inc = await createIncident(h);
    const patch = await call(h, 'PATCH', `/api/incidents/${inc.id}`, {
      cookie: bob,
      ifMatch: 1,
      body: { assigneeId: 'u_bob' },
      headers: { Origin: 'http://evil.example' },
    });
    expect(patch.status).toBe(403);
    expect(patch.json.error.code).toBe('cross_origin');

    const same = await call(h, 'POST', '/api/auth/login', {
      body,
      headers: { Origin: `http://127.0.0.1:${h.port}` },
    });
    expect(same.status).toBe(200);
  });
});

// ---------------------------------------------------------------- live stream

describe('live stream (SSE)', () => {
  it('sends the SSE headers, retry, then hello with serverTime and head', async () => {
    const bob = await login(h, 'bob');
    await createIncident(h);
    await createIncident(h);
    const r = await h.stream({ cookie: bob });
    await r.waitUntil(() => r.events.length >= 1, 2000, 'hello');

    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/event-stream');
    expect(r.headers['cache-control']).toBe('no-cache, no-transform');
    expect(r.headers['x-accel-buffering']).toBe('no');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.raw.startsWith('retry: 2000\n\n')).toBe(true);
    expect(r.raw.startsWith('retry: 2000\n\nevent: hello\n')).toBe(true);
    expect(r.events[0]).toMatchObject({ id: null, event: 'hello' });
    expect(r.events[0]!.json).toEqual({ serverTime: h.clock.now(), head: 2 });
  });

  it('streams live events with ids in order', async () => {
    const bob = await login(h, 'bob');
    const r = await h.stream({ cookie: bob });
    await r.waitUntil(() => r.of('hello').length === 1, 2000, 'hello');
    const head = r.of('hello')[0]!.json.head as number;

    const created = await createIncident(h, { fingerprint: 'live-1', title: 'Live one' });
    await r.waitUntil(() => r.of('incident.created').length === 1, 2000, 'created');
    const ack = await call(h, 'POST', `/api/incidents/${created.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ack.status).toBe(200);
    await r.waitUntil(() => r.of('incident.updated').length === 1, 2000, 'updated');

    const created0 = r.of('incident.created')[0]!;
    expect(created0.id).toBe(head + 1);
    expect(created0.json.incident).toMatchObject({ id: created.id, status: 'open' });
    expect(created0.json.audit[0]).toMatchObject({ action: 'incident.created' });

    const updated = r.of('incident.updated')[0]!;
    expect(updated.id).toBe(head + 2);
    expect(updated.json.incident).toMatchObject({ status: 'acked', version: 2 });
    expect(updated.json.audit[0]).toMatchObject({ action: 'incident.acked' });
  });

  it('resumes via Last-Event-ID with exactly the missed events and no duplicates', async () => {
    const bob = await login(h, 'bob');
    const first = await h.stream({ cookie: bob });
    const one = await createIncident(h, { fingerprint: 'r-1', title: 'Resume one' });
    const two = await createIncident(h, { fingerprint: 'r-2', title: 'Resume two' });
    await first.waitUntil(() => first.of('incident.created').length === 2, 2000, 'two creates');
    const lastSeen = first.events.filter((e) => e.id !== null).at(-1)!.id!;
    first.close();

    // Events while disconnected: a new incident, an ack, and a fold into two.
    await createIncident(h, { fingerprint: 'r-3', title: 'Resume three' });
    const ack = await call(h, 'POST', `/api/incidents/${one.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ack.status).toBe(200);
    const fold = await ingest(h, alertBody(h, { fingerprint: 'r-2', title: 'Resume two again' }));
    expect(fold.json.action).toBe('folded');

    const resumed = await h.stream({ cookie: bob, lastEventId: String(lastSeen) });
    await resumed.waitUntil(() => resumed.events.filter((e) => e.event !== 'hello').length >= 3, 2000, 'missed');
    expect(resumed.events.filter((e) => e.event !== 'hello').map((e) => e.id)).toEqual([
      lastSeen + 1,
      lastSeen + 2,
      lastSeen + 3,
    ]);

    // A live event after the replay arrives once, not twice.
    // A fold bumps rev, not version, so the version is still 1 here.
    const ack2 = await call(h, 'POST', `/api/incidents/${two.id}/ack`, { cookie: bob, ifMatch: 1 });
    expect(ack2.status).toBe(200);
    await resumed.waitUntil(() => resumed.events.filter((e) => e.event !== 'hello').length >= 4, 2000, 'live');
    const ids = resumed.events.filter((e) => e.event !== 'hello').map((e) => e.id);
    expect(ids).toEqual([lastSeen + 1, lastSeen + 2, lastSeen + 3, lastSeen + 4]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accepts ?lastEventId= when no Last-Event-ID header is sent', async () => {
    const bob = await login(h, 'bob');
    await createIncident(h, { fingerprint: 'q-1' });
    await createIncident(h, { fingerprint: 'q-2' });
    const r = await h.stream({ cookie: bob, query: 'lastEventId=1' });
    await r.waitUntil(() => r.of('incident.created').length === 1, 2000, 'replayed');
    expect(r.of('incident.created')[0]!.id).toBe(2);
    expect(r.of('resync')).toHaveLength(0);
  });

  it('sends resync when Last-Event-ID is ahead of head or malformed', async () => {
    const bob = await login(h, 'bob');
    await createIncident(h, { fingerprint: 'ah-1' });
    const ahead = await h.stream({ cookie: bob, lastEventId: '999999' });
    await ahead.waitUntil(() => ahead.of('resync').length === 1, 2000, 'resync');
    const resync = ahead.of('resync')[0]!;
    expect(resync.id).toBe(1);
    expect(resync.json).toEqual({ head: 1 });
    expect(ahead.of('incident.created')).toHaveLength(0);

    const bad = await h.stream({ cookie: bob, lastEventId: 'abc' });
    await bad.waitUntil(() => bad.of('resync').length === 1, 2000, 'resync for malformed id');
    expect(bad.of('resync')[0]!.json).toEqual({ head: 1 });
  });

  it('sends resync when the id is older than the oldest retained event', async () => {
    const bob = await login(h, 'bob');
    for (let i = 1; i <= 3; i += 1) await createIncident(h, { fingerprint: `pr-${i}` });
    // Simulate retention pruning: only events 3 and newer remain.
    h.ctx.db.run('DELETE FROM events WHERE seq < 3');

    const pruned = await h.stream({ cookie: bob, lastEventId: '0' });
    await pruned.waitUntil(() => pruned.of('resync').length === 1, 2000, 'pruned resync');
    expect(pruned.of('resync')[0]!.json).toEqual({ head: 3 });

    // Boundary: oldest - 1 is still replayable.
    const boundary = await h.stream({ cookie: bob, lastEventId: '2' });
    await boundary.waitUntil(() => boundary.of('incident.created').length === 1, 2000, 'boundary replay');
    expect(boundary.of('incident.created')[0]!.id).toBe(3);
    expect(boundary.of('resync')).toHaveLength(0);
  });

  it('sends resync when more than 5000 events would be replayed, and replays exactly 5000', async () => {
    const bob = await login(h, 'bob');
    h.ctx.db.tx(() => {
      for (let i = 0; i < 5001; i += 1) {
        h.ctx.db.run(
          'INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)',
          'incident.updated',
          '{"incident":null,"audit":[]}',
          T0,
        );
      }
    });

    const tooMany = await h.stream({ cookie: bob, lastEventId: '0' });
    await tooMany.waitUntil(() => tooMany.of('resync').length === 1, 3000, 'resync for 5001');
    expect(tooMany.of('resync')[0]!.json).toEqual({ head: 5001 });
    expect(tooMany.of('incident.updated')).toHaveLength(0);

    const exact = await h.stream({ cookie: bob, lastEventId: '1' });
    await exact.waitUntil(() => exact.of('incident.updated').length === 5000, 5000, 'exact replay');
    expect(exact.of('resync')).toHaveLength(0);
    expect(exact.of('incident.updated')[0]!.id).toBe(2);
    expect(exact.of('incident.updated').at(-1)!.id).toBe(5001);
  });

  it('broadcasts an SLA breach on the stream', async () => {
    const bob = await login(h, 'bob');
    const r = await h.stream({ cookie: bob });
    await r.waitUntil(() => r.of('hello').length === 1, 2000, 'hello');
    const inc = await createIncident(h, { fingerprint: 'sla-1', title: 'Payments down', severity: 'critical' });
    await r.waitUntil(() => r.of('incident.created').length === 1, 2000, 'created');

    h.clock.advance(5 * MINUTE);
    expect(sweepSla(h.ctx)).toBe(1);

    await r.waitUntil(() => r.of('incident.sla_breached').length === 1, 2000, 'breach');
    const breach = r.of('incident.sla_breached')[0]!;
    expect(breach.id).toBeGreaterThan(r.of('incident.created')[0]!.id!);
    expect(breach.json.incident).toMatchObject({
      id: inc.id,
      status: 'open',
      slaDueAt: null,
      slaBreachedAt: T0 + 5 * MINUTE,
    });
    expect(breach.json.audit[0]).toMatchObject({ action: 'incident.sla_breached', actor: 'system:sla' });
  });

  it('requires a session to open the stream', async () => {
    const r = await call(h, 'GET', '/api/stream');
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthenticated');
  });
});

describe('live stream heartbeat', () => {
  it('pings on the heartbeat and closes the stream once the session is revoked', async () => {
    const fast = await startHarness({ config: { sseHeartbeatMs: 20 } });
    try {
      const cookie = await login(fast, 'bob');
      const r = await fast.stream({ cookie });
      await r.waitUntil(() => r.of('ping').length >= 2, 2000, 'pings');
      expect(r.of('ping')[0]!.id).toBeNull();
      expect(r.of('ping')[0]!.json).toHaveProperty('serverTime');

      const out = await call(fast, 'POST', '/api/auth/logout', { cookie });
      expect(out.status).toBe(204);
      await r.waitEnd(2000);
      expect(r.ended).toBe(true);
    } finally {
      await fast.close();
    }
  });
});

// ---------------------------------------------------------------- static and routing

describe('static serving and routing', () => {
  let root: string;
  let webDir: string;
  let spa: Harness;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-web-'));
    webDir = path.join(root, 'web');
    fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Triage test</title>');
    fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1);');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
    await h.close();
    spa = await startHarness({ config: { webDir } });
  });

  afterEach(async () => {
    await spa.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves index.html with the CSP for unknown GET paths and files from webDir', async () => {
    const root1 = await call(spa, 'GET', '/');
    expect(root1.status).toBe(200);
    expect(root1.headers.get('content-type')).toContain('text/html');
    expect(root1.headers.get('content-security-policy')).toBe(CSP);
    expect(root1.headers.get('x-content-type-options')).toBe('nosniff');
    expect(root1.text).toContain('<title>Triage test</title>');

    const deep = await call(spa, 'GET', '/incidents/42');
    expect(deep.status).toBe(200);
    expect(deep.text).toContain('Triage test');
    expect(deep.headers.get('content-security-policy')).toBe(CSP);

    const asset = await call(spa, 'GET', '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.text).toBe('console.log(1);');
  });

  it('never falls back to the SPA for API paths; they answer with JSON 404 not_found', async () => {
    for (const p of ['/api/nope', '/ingest', '/api/incidents/1/nothing']) {
      const r = await call(spa, 'GET', p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toContain('application/json');
      expect(r.json.error.code, p).toBe('not_found');
    }
    const health = await call(spa, 'GET', '/healthz');
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true, serverTime: spa.clock.now() });
  });

  it('does not serve files outside webDir', async () => {
    const r = await call(spa, 'GET', '/..%2fsecret.txt');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('TOP SECRET');
  });

  it('treats trailing-slash variants of API paths as API paths: JSON 404, never index.html', async () => {
    for (const p of ['/healthz/', '/ingest/', '/api/', '/api/incidents/', '/api/auth/me/']) {
      const r = await call(spa, 'GET', p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toContain('application/json');
      expect(r.json.error.code, p).toBe('not_found');
    }
  });
});

/** Sends a request line exactly as given, without fetch's URL normalisation. */
function rawGet(port: number, target: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('request target handling', () => {
  it('answers malformed and host-bearing request targets with 400 bad_request, without logging a fault', async () => {
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      for (const target of ['//', '//evil.example/api/users', '/\\evil.example/api/users', 'http://evil.example/api/users']) {
        const r = await rawGet(h.port, target);
        expect(r.status, target).toBe(400);
        expect(r.type, target).toContain('application/json');
        expect(JSON.parse(r.body).error.code, target).toBe('bad_request');
      }
      expect(logged).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  it('routes an origin-form target as usual', async () => {
    const r = await rawGet(h.port, '/healthz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, serverTime: h.clock.now() });
  });
});

/** A ServerResponse stand-in: records writes and lets a test set the buffered byte count. */
class FakeResponse extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  headersSent = false;
  readonly chunks: string[] = [];

  writeHead(): this {
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }

  text(): string {
    return this.chunks.join('');
  }
}

describe('live stream backpressure', () => {
  it('closes a subscriber whose buffer passes 1 MB, removes it from the hub, and stops writing to it', async () => {
    const cookie = await login(h, 'bob');
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const res = new FakeResponse();
    const req = { headers: {}, socket: { setNoDelay() {} } } as unknown as IncomingMessage;
    const streams = new Set<StreamHandle>();
    try {
      openStream({
        ctx: h.ctx,
        config: h.config,
        req,
        res: res as unknown as ServerResponse,
        token,
        lastIdRaw: null,
        streams,
      });
      expect(h.ctx.hub.size).toBe(1);
      expect(streams.size).toBe(1);

      await createIncident(h);
      expect(res.text()).toContain('event: incident.created');

      // The client stops reading: the buffer is over the limit when the next event is delivered.
      res.writableLength = 1024 * 1024 + 1;
      await createIncident(h);
      expect(h.ctx.hub.size).toBe(0);
      expect(streams.size).toBe(0);
      expect(res.writableEnded).toBe(true);

      const written = res.chunks.length;
      await createIncident(h);
      expect(res.chunks.length).toBe(written);
    } finally {
      for (const s of [...streams]) s.close();
    }
  });
});

describe('static serving disabled', () => {
  it('answers non-API GET with a JSON 404 when webDir is null', async () => {
    const r = await call(h, 'GET', '/somewhere');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });
});
