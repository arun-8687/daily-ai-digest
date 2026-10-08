import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SLA_CRITICAL_MS } from '../../shared/rules';
import type { IncidentEventData } from '../../shared/types';
import { auditFeed, SYSTEM_INGEST, SYSTEM_SLA, type Actor } from '../src/audit';
import { manualClock, type ManualClock } from '../src/clock';
import { DEFAULT_INGEST_TOKEN, type AppConfig } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import { HttpError } from '../src/errors';
import type { Frame } from '../src/hub';
import { parseAlert, ingestAlert, contentHash, type AlertInput } from '../src/ingest';
import { stableStringify } from '../src/util';
import { applyAction, bulkAck, getIncidentDetail, listIncidents } from '../src/incidents';
import { runMaintenance, sweepSla } from '../src/sla';
import { clearSessionCookie, findSession, login, revokeSession, sessionCookie } from '../src/auth';
import { DEMO_PASSWORD, ensureDemoUsers, setUserRole } from '../src/users';

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60_000;

const ALICE: Actor = { id: 'u_alice', name: 'Alice Chen' };
const BOB: Actor = { id: 'u_bob', name: 'Bob Okafor' };

interface Harness {
  ctx: AppContext;
  clock: ManualClock;
}

const opened: AppContext[] = [];

function config(dbPath = ':memory:'): AppConfig {
  return {
    dbPath,
    ingestToken: DEFAULT_INGEST_TOKEN,
    sessionTtlMs: 12 * 3_600_000,
    webDir: null,
    cookieSecure: false,
    sseHeartbeatMs: 15_000,
    sweepIntervalMs: 1_000,
  };
}

function harness(start = T0, dbPath?: string): Harness {
  const clock = manualClock(start);
  const ctx = createContext(config(dbPath), clock);
  opened.push(ctx);
  return { ctx, clock };
}

afterEach(() => {
  for (const ctx of opened.splice(0)) {
    try {
      ctx.db.close();
    } catch {
      // already closed by a test that simulates a restart
    }
  }
});

/** Builds a validated alert whose ts is `ts` (defaults to the clock's now). */
function alert(h: Harness, overrides: Record<string, unknown> = {}): AlertInput {
  const now = h.clock.now();
  return parseAlert(
    {
      source: 'api',
      fingerprint: 'fp-db',
      severity: 'warning',
      title: 'Disk full',
      ts: now,
      ...overrides,
    },
    now,
  );
}

function incidentRows(h: Harness): Array<{ id: number }> {
  return h.ctx.db.all<{ id: number }>('SELECT id FROM incidents ORDER BY id');
}

function alertRows(h: Harness): number {
  return h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM alerts')?.n ?? 0;
}

describe('fold order independence', () => {
  // All offsets lie within a 10 minute span, so every alert is within the group window of every other one.
  const offsets = [0, 4, 8, 2, 10, 6];
  const orders = [
    [0, 1, 2, 3, 4, 5],
    [5, 4, 3, 2, 1, 0],
    [3, 0, 5, 1, 4, 2],
    [2, 4, 0, 5, 1, 3],
    [4, 2, 5, 0, 3, 1],
  ];

  for (const order of orders) {
    it(`order ${order.join(',')} gives one incident with the same last_seen, first_seen and count`, () => {
      const h = harness(T0 + 10 * MIN);
      for (const index of order) {
        const off = offsets[index] ?? 0;
        ingestAlert(h.ctx, alert(h, { ts: T0 + off * MIN, title: `Disk ${off}` }));
      }
      const incidents = listIncidents(h.ctx, { limit: 50 }).items;
      expect(incidents).toHaveLength(1);
      const [incident] = incidents;
      expect(incident?.firstSeen).toBe(T0);
      expect(incident?.lastSeen).toBe(T0 + 10 * MIN);
      expect(incident?.alertCount).toBe(offsets.length);
      // The title follows the alert with the newest ts, whatever the arrival order.
      expect(incident?.title).toBe('Disk 10');
    });
  }
});

describe('version vs rev (D4)', () => {
  it('a fold bumps rev but not version, and an ack with the old version succeeds', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h)).body.incident;
    expect(created.version).toBe(1);
    expect(created.rev).toBe(1);

    h.clock.advance(2 * MIN);
    const folded = ingestAlert(h.ctx, alert(h)).body.incident;
    expect(folded.alertCount).toBe(2);
    expect(folded.version).toBe(1);
    expect(folded.rev).toBe(2);

    const acked = applyAction(h.ctx, created.id, 'ack', BOB, 1);
    expect(acked.status).toBe('acked');
    expect(acked.version).toBe(2);
    expect(acked.rev).toBe(3);
    expect(acked.ackedBy).toBe(BOB.id);
  });

  it('a stale version gets version_conflict with the current record; illegal transitions are 409 illegal_transition', () => {
    const h = harness();
    const id = ingestAlert(h.ctx, alert(h)).body.incidentId;
    applyAction(h.ctx, id, 'ack', BOB, 1);

    let caught: unknown;
    try {
      applyAction(h.ctx, id, 'ack', BOB, 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).code).toBe('version_conflict');
    expect((caught as HttpError).status).toBe(409);
    expect((caught as HttpError).current?.version).toBe(2);

    try {
      applyAction(h.ctx, id, 'ack', BOB, 2);
      expect.unreachable('ack of an acked incident must fail');
    } catch (err) {
      expect((err as HttpError).code).toBe('illegal_transition');
      expect((err as HttpError).current?.status).toBe('acked');
    }
  });

  it('a 404 is returned for an unknown incident', () => {
    const h = harness();
    expect(() => applyAction(h.ctx, 999, 'ack', BOB, 1)).toThrow(HttpError);
  });
});

describe('SLA (D6)', () => {
  it('a critical incident breaches at exactly 5:00, stamped at the deadline', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h, { severity: 'critical' })).body.incident;
    expect(created.slaDueAt).toBe(T0 + SLA_CRITICAL_MS);

    h.clock.set(T0 + SLA_CRITICAL_MS - 1);
    expect(sweepSla(h.ctx)).toBe(0);

    h.clock.set(T0 + SLA_CRITICAL_MS);
    expect(sweepSla(h.ctx)).toBe(1);
    const detail = getIncidentDetail(h.ctx, created.id);
    expect(detail?.incident.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
    expect(detail?.incident.slaDueAt).toBeNull();
    expect(detail?.incident.version).toBe(1);
    expect(detail?.incident.rev).toBeGreaterThan(created.rev);
    expect(detail?.audit[0]?.action).toBe('incident.sla_breached');
    expect(detail?.audit[0]?.actor).toBe(SYSTEM_SLA.id);
    expect(detail?.audit[0]?.actorName).toBe('SLA monitor');

    expect(sweepSla(h.ctx)).toBe(0);
  });

  it('the breach stamp is the deadline even when the sweep runs much later', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h, { severity: 'critical' })).body.incident;
    h.clock.set(T0 + 17 * MIN);
    expect(sweepSla(h.ctx)).toBe(1);
    expect(getIncidentDetail(h.ctx, created.id)?.incident.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
  });

  it('an ack in time clears the clock and nothing breaches', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h, { severity: 'critical' })).body.incident;
    h.clock.set(T0 + 4 * MIN);
    const acked = applyAction(h.ctx, created.id, 'ack', BOB, created.version);
    expect(acked.slaDueAt).toBeNull();

    h.clock.set(T0 + 30 * MIN);
    expect(sweepSla(h.ctx)).toBe(0);
    expect(getIncidentDetail(h.ctx, created.id)?.incident.slaBreachedAt).toBeNull();
  });

  it('escalation to critical while open starts the clock at receipt time', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h, { severity: 'warning' })).body.incident;
    expect(created.slaDueAt).toBeNull();

    h.clock.set(T0 + 2 * MIN);
    const escalated = ingestAlert(h.ctx, alert(h, { severity: 'critical' })).body.incident;
    expect(escalated.severity).toBe('critical');
    expect(escalated.slaDueAt).toBe(T0 + 2 * MIN + SLA_CRITICAL_MS);

    h.clock.set(T0 + 7 * MIN - 1);
    expect(sweepSla(h.ctx)).toBe(0);
    h.clock.set(T0 + 7 * MIN);
    expect(sweepSla(h.ctx)).toBe(1);
    expect(getIncidentDetail(h.ctx, created.id)?.incident.slaBreachedAt).toBe(T0 + 7 * MIN);

    const audit = getIncidentDetail(h.ctx, created.id)?.audit.map((a) => a.action) ?? [];
    expect(audit).toContain('incident.escalated');
  });

  it('escalation of an acked incident does not start a clock', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h, { severity: 'warning' })).body.incident;
    applyAction(h.ctx, created.id, 'ack', BOB, created.version);
    h.clock.advance(MIN);
    const escalated = ingestAlert(h.ctx, alert(h, { severity: 'critical' })).body.incident;
    expect(escalated.severity).toBe('critical');
    expect(escalated.slaDueAt).toBeNull();
    h.clock.advance(60 * MIN);
    expect(sweepSla(h.ctx)).toBe(0);
  });

  it('reopening a critical incident restarts the clock and resets the breach stamp', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h, { severity: 'critical' })).body.incident;
    h.clock.advance(SLA_CRITICAL_MS);
    sweepSla(h.ctx);
    const breached = getIncidentDetail(h.ctx, created.id)?.incident;
    expect(breached?.slaBreachedAt).not.toBeNull();

    const resolved = applyAction(h.ctx, created.id, 'resolve', BOB, breached?.version ?? 1);
    const reopened = applyAction(h.ctx, created.id, 'reopen', BOB, resolved.version);
    expect(reopened.slaBreachedAt).toBeNull();
    expect(reopened.slaDueAt).toBe(h.clock.now() + SLA_CRITICAL_MS);
  });

  it('restart with a file database resumes the SLA clock and still stamps the deadline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-domain-'));
    try {
      const path = join(dir, 'triage.db');
      const first = harness(T0, path);
      const created = ingestAlert(first.ctx, alert(first, { severity: 'critical' })).body.incident;
      expect(created.slaDueAt).toBe(T0 + SLA_CRITICAL_MS);
      first.ctx.db.close();

      const second = harness(T0 + 4 * MIN, path);
      expect(sweepSla(second.ctx)).toBe(0);
      expect(getIncidentDetail(second.ctx, created.id)?.incident.slaDueAt).toBe(T0 + SLA_CRITICAL_MS);

      // The process was down for a long time. The breach is still stamped at the deadline, not at restart.
      second.clock.set(T0 + 9 * MIN);
      expect(sweepSla(second.ctx)).toBe(1);
      expect(getIncidentDetail(second.ctx, created.id)?.incident.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('idempotency (D2)', () => {
  it('replays the stored status and body for the same key and the same content', () => {
    const h = harness();
    const first = ingestAlert(h.ctx, alert(h), 'key-1');
    expect(first.replayed).toBe(false);
    expect(first.status).toBe(202);
    expect(first.body.action).toBe('created');

    h.clock.advance(MIN);
    const replay = ingestAlert(h.ctx, alert(h, { ts: T0 }), 'key-1');
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(alertRows(h)).toBe(1);
  });

  it('returns 422 idempotency_key_reused for the same key with different content', () => {
    const h = harness();
    ingestAlert(h.ctx, alert(h), 'key-2');
    try {
      ingestAlert(h.ctx, alert(h, { title: 'Something else' }), 'key-2');
      expect.unreachable('a reused key with different content must fail');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).code).toBe('idempotency_key_reused');
    }
    expect(alertRows(h)).toBe(1);
  });

  it('treats a key older than 24 hours as absent', () => {
    const h = harness();
    ingestAlert(h.ctx, alert(h), 'key-3');
    h.clock.advance(25 * 3_600_000);
    const fresh = ingestAlert(h.ctx, alert(h, { title: 'Another alert', fingerprint: 'fp-other' }), 'key-3');
    expect(fresh.replayed).toBe(false);
    expect(fresh.body.action).toBe('created');
  });
});

describe('content duplicates (D2)', () => {
  it('an identical alert for the same fingerprint is a duplicate and changes nothing', () => {
    const h = harness();
    const first = ingestAlert(h.ctx, alert(h));
    const before = getIncidentDetail(h.ctx, first.body.incidentId)?.incident;

    const second = ingestAlert(h.ctx, alert(h));
    expect(second.body.action).toBe('duplicate');
    expect(second.body.incidentId).toBe(first.body.incidentId);
    expect(alertRows(h)).toBe(1);
    expect(getIncidentDetail(h.ctx, first.body.incidentId)?.incident).toEqual(before);
  });

  it('the same content with a different payload is a new alert and folds', () => {
    const h = harness();
    ingestAlert(h.ctx, alert(h, { payload: { host: 'a' } }));
    const second = ingestAlert(h.ctx, alert(h, { payload: { host: 'b' } }));
    expect(second.body.action).toBe('folded');
    expect(second.body.incident.alertCount).toBe(2);
  });
});

describe('audit log (D7)', () => {
  it('UPDATE and DELETE on audit_log are aborted by triggers', () => {
    const h = harness();
    ingestAlert(h.ctx, alert(h));
    expect(() => h.ctx.db.run("UPDATE audit_log SET action = 'tampered'")).toThrow(/append-only/);
    expect(() => h.ctx.db.run('DELETE FROM audit_log')).toThrow(/append-only/);
    expect(auditFeed(h.ctx, null, 10)[0]?.action).toBe('incident.created');
  });

  it('records before and after snapshots and the system actor for ingest', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h)).body.incident;
    applyAction(h.ctx, created.id, 'ack', BOB, created.version);
    const entries = getIncidentDetail(h.ctx, created.id)?.audit ?? [];
    expect(entries.map((e) => e.action)).toEqual(['incident.acked', 'incident.created']);
    const ack = entries[0];
    expect(ack?.before).toMatchObject({ status: 'open', version: 1, rev: 1 });
    expect(ack?.after).toMatchObject({ status: 'acked', version: 2, rev: 2, alertCount: 1 });
    expect(entries[1]?.actor).toBe(SYSTEM_INGEST.id);
    expect(entries[1]?.actorName).toBe('Ingest');
  });

  it('routine folds are not audited', () => {
    const h = harness();
    ingestAlert(h.ctx, alert(h));
    h.clock.advance(MIN);
    ingestAlert(h.ctx, alert(h, { title: 'Disk full again' }));
    const actions = getIncidentDetail(h.ctx, 1)?.audit.map((a) => a.action) ?? [];
    expect(actions).toEqual(['incident.created']);
  });
});

describe('events and transactions (D8)', () => {
  it('publishes committed events to subscribers with the audit entries of that transaction', () => {
    const h = harness();
    const frames: Frame[] = [];
    const seenInTransaction: boolean[] = [];
    h.ctx.hub.add({
      lastSent: 0,
      deliver(frame) {
        frames.push(frame);
        seenInTransaction.push(h.ctx.db.raw.isTransaction);
      },
    });

    ingestAlert(h.ctx, alert(h));
    expect(frames.map((f) => f.type)).toEqual(['incident.created']);
    expect(seenInTransaction).toEqual([false]);
    const data = JSON.parse(frames[0]?.data ?? '{}') as IncidentEventData;
    expect(data.incident.alertCount).toBe(1);
    expect(data.audit.map((a) => a.action)).toEqual(['incident.created']);
    expect(frames[0]?.seq).toBeGreaterThan(0);
  });

  it('a failed transaction rolls back and publishes nothing', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h)).body.incident;
    const frames: Frame[] = [];
    h.ctx.hub.add({ lastSent: 0, deliver: (frame) => frames.push(frame) });

    expect(() => applyAction(h.ctx, created.id, 'ack', BOB, 99)).toThrow(HttpError);
    expect(frames).toHaveLength(0);
    expect(getIncidentDetail(h.ctx, created.id)?.incident.status).toBe('open');
  });

  it('event seq values increase and reflect every committed write', () => {
    const h = harness();
    const created = ingestAlert(h.ctx, alert(h)).body.incident;
    applyAction(h.ctx, created.id, 'ack', BOB, created.version);
    const seqs = h.ctx.db.all<{ seq: number; type: string }>('SELECT seq, type FROM events ORDER BY seq');
    expect(seqs.map((s) => s.type)).toEqual(['incident.created', 'incident.updated']);
    expect(seqs[1]!.seq).toBeGreaterThan(seqs[0]!.seq);
  });

  it('maintenance keeps events and drops idempotency keys older than 24 hours', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      ingestAlert(h.ctx, alert(h, { fingerprint: `fp-${i}` }), `k-${i}`);
    }
    runMaintenance(h.ctx);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')?.n).toBe(3);

    h.clock.advance(25 * 3_600_000);
    runMaintenance(h.ctx);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idempotency_keys')?.n).toBe(0);
  });
});

describe('ingest validation (D13)', () => {
  it('lists every problem in one 400 validation_failed', () => {
    const now = T0;
    try {
      parseAlert({ source: '', fingerprint: 'x', severity: 'loud', title: '', ts: 'not a date' }, now);
      expect.unreachable('invalid alert must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).code).toBe('validation_failed');
      expect((err as HttpError).message).toContain('source');
      expect((err as HttpError).message).toContain('severity');
      expect((err as HttpError).message).toContain('title');
      expect((err as HttpError).message).toContain('ts');
    }
  });

  it('rejects a ts more than the future skew ahead, and accepts ISO strings', () => {
    const now = T0;
    expect(() => parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: 't', ts: now + 61_000 }, now)).toThrow(
      /future/,
    );
    const ok = parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: 't', ts: new Date(now).toISOString() }, now);
    expect(ok.ts).toBe(now);
  });
});

describe('list, detail and bulk (D11, bulk ack)', () => {
  it('matches a title with escaped % and _ literally', () => {
    const h = harness();
    ingestAlert(h.ctx, alert(h, { fingerprint: 'a', title: 'snake_case job failed' }));
    ingestAlert(h.ctx, alert(h, { fingerprint: 'b', title: 'snakeXcase job failed' }));
    ingestAlert(h.ctx, alert(h, { fingerprint: 'c', title: 'Disk 100% full' }));
    ingestAlert(h.ctx, alert(h, { fingerprint: 'd', title: 'Disk 1000 full' }));

    expect(listIncidents(h.ctx, { q: 'snake_case', limit: 50 }).items.map((i) => i.title)).toEqual([
      'snake_case job failed',
    ]);
    expect(listIncidents(h.ctx, { q: '100%', limit: 50 }).items.map((i) => i.title)).toEqual(['Disk 100% full']);
  });

  it('keyset pagination is stable under inserts between pages', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      ingestAlert(h.ctx, alert(h, { fingerprint: `p-${i}`, title: `Item ${i}` }));
    }
    const first = listIncidents(h.ctx, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([5, 4]);
    expect(first.total).toBe(5);

    ingestAlert(h.ctx, alert(h, { fingerprint: 'p-new', title: 'New' }));
    const second = listIncidents(h.ctx, { limit: 2, cursor: Number(first.nextCursor) });
    expect(second.items.map((i) => i.id)).toEqual([3, 2]);
    expect(second.total).toBeNull();
  });

  it('bulk ack gives each item its own result', () => {
    const h = harness();
    const a = ingestAlert(h.ctx, alert(h, { fingerprint: 'bulk-a' })).body.incident;
    const b = ingestAlert(h.ctx, alert(h, { fingerprint: 'bulk-b' })).body.incident;
    const results = bulkAck(h.ctx, BOB, [
      { id: a.id, version: a.version },
      { id: b.id, version: 7 },
    ]);
    expect(results[0]).toMatchObject({ id: a.id, ok: true, status: 200 });
    expect(results[0]?.incident?.status).toBe('acked');
    expect(results[1]).toMatchObject({ id: b.id, ok: false, status: 409 });
    expect(results[1]?.error?.code).toBe('version_conflict');
    expect(results[1]?.current?.status).toBe('open');
  });

  it('assign: unknown assignee is 400, an unchanged assignee does not bump the version', async () => {
    const h = harness();
    await ensureDemoUsers(h.ctx);
    const created = ingestAlert(h.ctx, alert(h)).body.incident;

    let caught: unknown;
    try {
      applyAction(h.ctx, created.id, 'assign', ALICE, created.version, 'u_nobody');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect((caught as HttpError).code).toBe('unknown_assignee');

    const assigned = applyAction(h.ctx, created.id, 'assign', ALICE, created.version, BOB.id);
    expect(assigned.assigneeId).toBe(BOB.id);
    expect(assigned.version).toBe(created.version + 1);

    const same = applyAction(h.ctx, created.id, 'assign', ALICE, assigned.version, BOB.id);
    expect(same.version).toBe(assigned.version);
    expect(same.rev).toBe(assigned.rev);
  });

  it('the last admin cannot be demoted, but an admin can once another admin exists', async () => {
    const h = harness();
    await ensureDemoUsers(h.ctx);

    let caught: unknown;
    try {
      setUserRole(h.ctx, BOB, 'u_alice', 'viewer');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).code).toBe('last_admin');
    expect((caught as HttpError).status).toBe(409);

    setUserRole(h.ctx, ALICE, 'u_bob', 'admin');
    const demoted = setUserRole(h.ctx, ALICE, 'u_alice', 'viewer');
    expect(demoted.role).toBe('viewer');
  });
});

describe('auth and sessions (D9)', () => {
  it('logs in, resolves the session with the live role, and revokes it', async () => {
    const h = harness();
    await ensureDemoUsers(h.ctx);

    expect(await login(h.ctx, 'bob', 'wrong-password')).toBeNull();
    expect(await login(h.ctx, 'nobody', DEMO_PASSWORD)).toBeNull();

    const result = await login(h.ctx, 'bob', DEMO_PASSWORD);
    expect(result?.user).toEqual({ id: 'u_bob', username: 'bob', displayName: 'Bob Okafor', role: 'responder' });
    const token = result?.token ?? '';
    expect(token.length).toBeGreaterThanOrEqual(43);

    // Only the sha256 of the token is stored.
    const stored = h.ctx.db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(stored.map((s) => s.token_hash)).not.toContain(token);
    expect(stored).toHaveLength(1);

    expect(findSession(h.ctx, token)?.user.role).toBe('responder');
    setUserRole(h.ctx, ALICE, 'u_bob', 'viewer');
    expect(findSession(h.ctx, token)?.user.role).toBe('viewer');

    expect(auditFeed(h.ctx, null, 5)[0]?.action).toBe('user.role_changed');
    expect(auditFeed(h.ctx, null, 5).some((e) => e.action === 'auth.login')).toBe(true);

    revokeSession(h.ctx, token);
    expect(findSession(h.ctx, token)).toBeNull();
    expect(findSession(h.ctx, null)).toBeNull();
  });

  it('sessions expire after the configured TTL', async () => {
    const h = harness();
    await ensureDemoUsers(h.ctx);
    const result = await login(h.ctx, 'carol', DEMO_PASSWORD);
    const token = result?.token ?? '';
    h.clock.set(T0 + 12 * 3_600_000 - 1);
    expect(findSession(h.ctx, token)).not.toBeNull();
    h.clock.set(T0 + 12 * 3_600_000);
    expect(findSession(h.ctx, token)).toBeNull();
  });

  it('builds cookies with HttpOnly, SameSite=Lax and Secure only when configured', () => {
    const plain = sessionCookie('tok', T0 + 3_600_000, false, T0);
    expect(plain).toMatch(/^triage_session=tok;/);
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('SameSite=Lax');
    expect(plain).toContain('Path=/');
    expect(plain).toContain('Max-Age=3600');
    expect(plain).not.toContain('Secure');
    expect(sessionCookie('tok', T0 + 3_600_000, true, T0)).toContain('; Secure');
    expect(clearSessionCookie(false)).toContain('Max-Age=0');
  });
});

describe('review fixes', () => {
  it('keeps an own __proto__ payload key in the content hash (D2)', () => {
    const one = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    const two = JSON.parse('{"__proto__":{"x":2}}') as Record<string, unknown>;
    expect(stableStringify(one)).not.toBe(stableStringify(two));
    expect(stableStringify(one)).toContain('"__proto__"');

    const h = harness();
    const a = alert(h, { payload: one });
    const b = alert(h, { payload: two });
    expect(contentHash(a)).not.toBe(contentHash(b));
    ingestAlert(h.ctx, a);
    const second = ingestAlert(h.ctx, b);
    expect(second.body.action).not.toBe('duplicate');
    expect(alertRows(h)).toBe(2);
  });

  it('bounds the Idempotency-Key to 1-255 characters (D2)', () => {
    const h = harness();
    for (const key of ['', 'k'.repeat(256)]) {
      try {
        ingestAlert(h.ctx, alert(h), key);
        expect.unreachable('an out-of-range key must be rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
        expect((err as HttpError).code).toBe('bad_idempotency_key');
      }
    }
    expect(alertRows(h)).toBe(0);
    const edge = ingestAlert(h.ctx, alert(h), 'k'.repeat(255));
    expect(edge.body.action).toBe('created');
  });

  it('trims only the title; source and fingerprint are kept as sent (D13)', () => {
    const now = T0;
    const parsed = parseAlert(
      { source: ' api ', fingerprint: ' db ', severity: 'info', title: '  Disk full  ', ts: now },
      now,
    );
    expect(parsed.title).toBe('Disk full');
    expect(parsed.source).toBe(' api ');
    expect(parsed.fingerprint).toBe(' db ');

    const h = harness();
    const spaced = ingestAlert(h.ctx, alert(h, { fingerprint: ' db ' }));
    const plain = ingestAlert(h.ctx, alert(h, { fingerprint: 'db' }));
    expect(spaced.body.incidentId).not.toBe(plain.body.incidentId);
  });

  it('still rejects a whitespace-only title (D13)', () => {
    expect(() => parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: '   ', ts: T0 }, T0)).toThrow(
      /title/,
    );
  });
});
