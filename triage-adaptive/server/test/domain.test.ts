import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLAP_WINDOW_MS, SLA_CRITICAL_MS, GROUP_WINDOW_MS } from '../../shared/rules';
import { type IncidentDTO, type IngestResponse, type Severity } from '../../shared/types';
import { type Actor, SYSTEM_SLA, auditFeed } from '../src/audit';
import { manualClock } from '../src/clock';
import { loadConfig } from '../src/config';
import { type AppContext, closeContext, createContext, transact } from '../src/context';
import { HttpError } from '../src/errors';
import { type Frame, type Subscriber } from '../src/hub';
import { applyAction, bulkAck, getIncidentDetail, listIncidents } from '../src/incidents';
import { alertContentHash, ingestAlert, parseAlert } from '../src/ingest';
import { stableStringify } from '../src/util';
import { sweepSla, runMaintenance } from '../src/sla';
import { SESSION_COOKIE, clearSessionCookie, findSession, login, revokeSession, sessionCookie } from '../src/auth';
import { ensureDemoUsers, listUsers, setUserRole } from '../src/users';
import { hashPassword, verifyPassword } from '../src/passwords';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const ALICE: Actor = { id: 'u_alice', name: 'Alice Chen' };
const BOB: Actor = { id: 'u_bob', name: 'Bob Okafor' };

const closers: AppContext[] = [];
afterEach(() => {
  while (closers.length) closeContext(closers.pop()!);
});

/** A fresh context over an in-memory DB (or a file DB when dbPath is given) with a manual clock. */
function setup(start = T0, dbPath = ':memory:') {
  const clock = manualClock(start);
  const ctx = createContext(loadConfig({ TRIAGE_DB: dbPath, TRIAGE_WEB_DIR: 'none' }), clock);
  closers.push(ctx);
  return { ctx, clock };
}

interface AlertOpts {
  fingerprint?: string;
  severity?: Severity;
  title?: string;
  ts?: number;
  source?: string;
  payload?: Record<string, unknown>;
}

/** Sends one alert through the real parse and ingest path, using the clock's current time as receipt time. */
function send(ctx: AppContext, opts: AlertOpts = {}, key?: string) {
  const now = ctx.clock.now();
  const body: Record<string, unknown> = {
    source: opts.source ?? 'monitor',
    fingerprint: opts.fingerprint ?? 'fp-a',
    severity: opts.severity ?? 'warning',
    title: opts.title ?? `Alert on ${opts.fingerprint ?? 'fp-a'}`,
    ts: opts.ts ?? now,
    payload: opts.payload ?? {},
  };
  return ingestAlert(ctx, parseAlert(body, now), key);
}

function count(ctx: AppContext, sql: string, ...params: (string | number)[]): number {
  return ctx.db.get<{ n: number }>(sql, ...params)?.n ?? 0;
}

function eventCount(ctx: AppContext): number {
  return count(ctx, 'SELECT COUNT(*) AS n FROM events');
}

function recorder() {
  const frames: Frame[] = [];
  const sub: Subscriber = {
    lastSent: 0,
    deliver(frame) {
      frames.push(frame);
      sub.lastSent = frame.seq;
    },
  };
  return { sub, frames };
}

function httpErrorOf(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected an HttpError');
}

function incidentOf(res: IngestResponse): IncidentDTO {
  return res.incident;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

describe('D1/D4 ingest and grouping', () => {
  it('creates an incident with version 1, rev 1 and one alert', () => {
    const { ctx } = setup();
    const res = send(ctx, { fingerprint: 'fp-create', title: 'Disk full' });
    expect(res.status).toBe(202);
    expect(res.body.action).toBe('created');
    const inc = incidentOf(res.body);
    expect(inc).toMatchObject({
      status: 'open',
      severity: 'warning',
      version: 1,
      rev: 1,
      alertCount: 1,
      firstSeen: T0,
      lastSeen: T0,
      slaDueAt: null,
      slaBreachedAt: null,
      assigneeId: null,
    });
  });

  it('gives the same last_seen, first_seen and count for every permutation of folding alerts', () => {
    const alerts: AlertOpts[] = [
      { title: 'a', ts: T0, severity: 'warning' },
      { title: 'b', ts: T0 + 4 * MIN, severity: 'info' },
      { title: 'c', ts: T0 + 7 * MIN, severity: 'critical' },
      { title: 'd', ts: T0 + 10 * MIN, severity: 'warning' },
    ];
    const results = permutations([0, 1, 2, 3]).map((order) => {
      const { ctx, clock } = setup(T0 + 10 * MIN);
      for (const i of order) send(ctx, { ...alerts[i]!, fingerprint: 'fp-perm' });
      expect(clock.now()).toBe(T0 + 10 * MIN);
      const rows = ctx.db.all<{ id: number; last_seen: number; first_seen: number; alert_count: number; severity: string; version: number; rev: number }>(
        'SELECT id, last_seen, first_seen, alert_count, severity, version, rev FROM incidents WHERE fingerprint = ?',
        'fp-perm',
      );
      expect(rows).toHaveLength(1);
      return { ...rows[0]! };
    });
    const first = results[0]!;
    expect(first.last_seen).toBe(T0 + 10 * MIN);
    expect(first.first_seen).toBe(T0);
    expect(first.alert_count).toBe(4);
    expect(first.severity).toBe('critical');
    for (const r of results) {
      expect(r.last_seen).toBe(first.last_seen);
      expect(r.first_seen).toBe(first.first_seen);
      expect(r.alert_count).toBe(first.alert_count);
      expect(r.severity).toBe(first.severity);
      expect(r.version).toBe(1);
      expect(r.rev).toBe(4);
    }
  });

  it('a fold bumps rev, not version, and an ack with the pre-fold version still succeeds', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-rev', title: 'first' }).body);
    clock.advance(MIN);
    const folded = incidentOf(send(ctx, { fingerprint: 'fp-rev', title: 'second', ts: clock.now() }).body);
    expect(folded.id).toBe(created.id);
    expect(folded.version).toBe(1);
    expect(folded.rev).toBe(created.rev + 1);
    expect(folded.alertCount).toBe(2);

    const acked = applyAction(ctx, created.id, 'ack', ALICE, 1);
    expect(acked.status).toBe('acked');
    expect(acked.version).toBe(2);
    expect(acked.rev).toBe(folded.rev + 1);
  });

  it('a fold emits exactly one incident.updated event for the touched incident', () => {
    const { ctx, clock } = setup();
    const { sub, frames } = recorder();
    ctx.hub.add(sub);
    send(ctx, { fingerprint: 'fp-evt', title: 'one' });
    expect(frames.map((f) => f.type)).toEqual(['incident.created']);
    clock.advance(MIN);
    send(ctx, { fingerprint: 'fp-evt', title: 'two', ts: clock.now() });
    expect(frames.map((f) => f.type)).toEqual(['incident.created', 'incident.updated']);
    const payload = JSON.parse(frames[1]!.data) as { incident: IncidentDTO; audit: unknown[] };
    expect(payload.incident.alertCount).toBe(2);
    expect(payload.audit).toHaveLength(0);
  });

  it('a content duplicate is action duplicate and changes nothing', () => {
    const { ctx, clock } = setup();
    send(ctx, { fingerprint: 'fp-dup', title: 'same', ts: T0 });
    const before = ctx.db.get<{ rev: number; alert_count: number }>('SELECT rev, alert_count FROM incidents WHERE fingerprint = ?', 'fp-dup')!;
    const events = eventCount(ctx);
    clock.advance(MIN);
    const again = send(ctx, { fingerprint: 'fp-dup', title: 'same', ts: T0 });
    expect(again.body.action).toBe('duplicate');
    expect(again.status).toBe(202);
    const after = ctx.db.get<{ rev: number; alert_count: number }>('SELECT rev, alert_count FROM incidents WHERE fingerprint = ?', 'fp-dup')!;
    expect(after).toEqual(before);
    expect(eventCount(ctx)).toBe(events);
  });

  it('a fold at exactly 10 minutes folds, and 1ms later creates a new incident', () => {
    const { ctx, clock } = setup();
    const first = incidentOf(send(ctx, { fingerprint: 'fp-win', title: 'a', ts: T0 }).body);
    clock.set(T0 + GROUP_WINDOW_MS);
    const folded = send(ctx, { fingerprint: 'fp-win', title: 'b', ts: T0 + GROUP_WINDOW_MS });
    expect(folded.body.action).toBe('folded');
    expect(folded.body.incidentId).toBe(first.id);
    clock.set(T0 + 2 * GROUP_WINDOW_MS + 1);
    const created = send(ctx, { fingerprint: 'fp-win', title: 'c', ts: T0 + 2 * GROUP_WINDOW_MS + 1 });
    expect(created.body.action).toBe('created');
    expect(created.body.incidentId).not.toBe(first.id);
  });

  it('reopens a resolved incident when an alert arrives within the flap window', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-flap', title: 'flap', ts: T0 }).body);
    clock.set(T0 + MIN);
    const resolved = applyAction(ctx, created.id, 'resolve', ALICE, 1);
    expect(resolved.resolvedAt).toBe(T0 + MIN);
    clock.set(T0 + 3 * MIN);
    const res = send(ctx, { fingerprint: 'fp-flap', title: 'flap again', ts: T0 + 3 * MIN });
    expect(res.body.action).toBe('reopened');
    expect(res.body.incidentId).toBe(created.id);
    expect(res.body.incident).toMatchObject({ status: 'open', resolvedAt: null, version: 3, alertCount: 2 });
    const audit = getIncidentDetail(ctx, created.id)!.audit.map((a) => a.action);
    expect(audit).toContain('incident.reopened');
  });

  it('creates a new incident when the alert is 1ms beyond the flap window after resolved_at', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-flap2', title: 'flap', ts: T0 }).body);
    clock.set(T0 + MIN);
    applyAction(ctx, created.id, 'resolve', ALICE, 1);
    const late = T0 + MIN + FLAP_WINDOW_MS + 1;
    clock.set(late);
    const res = send(ctx, { fingerprint: 'fp-flap2', title: 'later', ts: late });
    expect(res.body.action).toBe('created');
    expect(res.body.incidentId).not.toBe(created.id);
  });

  it('attaches an older alert to a resolved incident without changing its status', () => {
    const { ctx, clock } = setup();
    clock.set(T0 + 28 * MIN);
    const created = incidentOf(send(ctx, { fingerprint: 'fp-att', title: 'late arrival', ts: T0 + 28 * MIN }).body);
    clock.set(T0 + 30 * MIN);
    applyAction(ctx, created.id, 'resolve', ALICE, 1);
    const older = T0 + 20 * MIN;
    const res = send(ctx, { fingerprint: 'fp-att', title: 'older', ts: older });
    expect(res.body.action).toBe('attached');
    expect(res.body.incidentId).toBe(created.id);
    expect(res.body.incident).toMatchObject({
      status: 'resolved',
      firstSeen: older,
      lastSeen: T0 + 28 * MIN,
      alertCount: 2,
      version: 2,
    });
    const audit = getIncidentDetail(ctx, created.id)!.audit.map((a) => a.action);
    expect(audit).toContain('alert.attached');
  });

  it('escalating to critical while open starts the SLA clock at receipt and is audited', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-esc', title: 'esc', ts: T0 }).body);
    clock.set(T0 + 3 * MIN);
    const res = send(ctx, { fingerprint: 'fp-esc', title: 'esc critical', ts: T0 + 3 * MIN, severity: 'critical' });
    expect(res.body.incident).toMatchObject({ severity: 'critical', slaDueAt: T0 + 3 * MIN + SLA_CRITICAL_MS });
    expect(res.body.incident.version).toBe(created.version);
    const audit = getIncidentDetail(ctx, created.id)!.audit.map((a) => a.action);
    expect(audit).toContain('incident.escalated');
  });
});

describe('D5/D6 version, SLA and deadlines', () => {
  it('a critical incident is breached at exactly 5:00 and not one millisecond earlier', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-sla5', severity: 'critical', title: 'db down' }).body);
    expect(created.slaDueAt).toBe(T0 + SLA_CRITICAL_MS);
    clock.set(T0 + SLA_CRITICAL_MS - 1);
    expect(sweepSla(ctx)).toBe(0);
    clock.set(T0 + SLA_CRITICAL_MS);
    expect(sweepSla(ctx)).toBe(1);
    const after = getIncidentDetail(ctx, created.id)!.incident;
    expect(after.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
    expect(after.slaDueAt).toBeNull();
    expect(after.status).toBe('open');
    expect(after.version).toBe(1);
    expect(after.rev).toBe(created.rev + 1);
  });

  it('stamps the breach at the deadline, not at the (later) sweep time', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-deadline', severity: 'critical', title: 'late sweep' }).body);
    clock.set(T0 + 7 * MIN);
    expect(sweepSla(ctx)).toBe(1);
    expect(getIncidentDetail(ctx, created.id)!.incident.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
  });

  it('an ack in time clears the clock and prevents a breach', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-ack', severity: 'critical', title: 'ack me' }).body);
    clock.set(T0 + 4 * MIN);
    const acked = applyAction(ctx, created.id, 'ack', BOB, 1);
    expect(acked.slaDueAt).toBeNull();
    expect(acked.ackedBy).toBe(BOB.id);
    clock.set(T0 + 30 * MIN);
    expect(sweepSla(ctx)).toBe(0);
    expect(getIncidentDetail(ctx, created.id)!.incident.slaBreachedAt).toBeNull();
  });

  it('escalation to critical after a warning starts the clock at that moment', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-esc-sla', title: 'warn first' }).body);
    clock.set(T0 + 3 * MIN);
    send(ctx, { fingerprint: 'fp-esc-sla', title: 'now critical', ts: T0 + 3 * MIN, severity: 'critical' });
    clock.set(T0 + 8 * MIN - 1);
    expect(sweepSla(ctx)).toBe(0);
    clock.set(T0 + 8 * MIN);
    expect(sweepSla(ctx)).toBe(1);
    expect(getIncidentDetail(ctx, created.id)!.incident.slaBreachedAt).toBe(T0 + 8 * MIN);
  });

  it('escalation to critical while acked starts no clock', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-ack-esc', title: 'acked first' }).body);
    clock.set(T0 + MIN);
    applyAction(ctx, created.id, 'ack', ALICE, 1);
    clock.set(T0 + 2 * MIN);
    const res = send(ctx, { fingerprint: 'fp-ack-esc', title: 'now critical', ts: T0 + 2 * MIN, severity: 'critical' });
    expect(res.body.incident).toMatchObject({ severity: 'critical', status: 'acked', slaDueAt: null });
    clock.set(T0 + 60 * MIN);
    expect(sweepSla(ctx)).toBe(0);
  });

  it('reopening a breached critical incident restarts the clock and resets the breach', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-reopen-sla', severity: 'critical', title: 'again' }).body);
    clock.set(T0 + 5 * MIN);
    expect(sweepSla(ctx)).toBe(1);
    clock.set(T0 + 6 * MIN);
    const resolved = applyAction(ctx, created.id, 'resolve', ALICE, 1);
    expect(resolved.version).toBe(2);
    const reopened = applyAction(ctx, created.id, 'reopen', ALICE, 2);
    expect(reopened.version).toBe(3);
    expect(reopened.slaBreachedAt).toBeNull();
    expect(reopened.slaDueAt).toBe(T0 + 11 * MIN);
    clock.set(T0 + 11 * MIN - 1);
    expect(sweepSla(ctx)).toBe(0);
    clock.set(T0 + 11 * MIN);
    expect(sweepSla(ctx)).toBe(1);
    expect(getIncidentDetail(ctx, created.id)!.incident.slaBreachedAt).toBe(T0 + 11 * MIN);
  });

  it('publishes incident.sla_breached with the breach and its SLA monitor audit row', () => {
    const { ctx, clock } = setup();
    const { sub, frames } = recorder();
    ctx.hub.add(sub);
    const created = incidentOf(send(ctx, { fingerprint: 'fp-breach-evt', severity: 'critical', title: 'evt' }).body);
    clock.set(T0 + SLA_CRITICAL_MS);
    sweepSla(ctx);
    const breach = frames.find((f) => f.type === 'incident.sla_breached');
    expect(breach).toBeDefined();
    const data = JSON.parse(breach!.data) as { incident: IncidentDTO; audit: { actor: string; action: string }[] };
    expect(data.incident.id).toBe(created.id);
    expect(data.incident.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
    expect(data.audit).toEqual([expect.objectContaining({ actor: SYSTEM_SLA.id, action: 'incident.sla_breached' })]);
  });

  it('a sweep with nothing due does not write', () => {
    const { ctx } = setup();
    send(ctx, { fingerprint: 'fp-quiet', title: 'warning only' });
    const events = eventCount(ctx);
    expect(sweepSla(ctx)).toBe(0);
    expect(eventCount(ctx)).toBe(events);
  });

  it('restart with a file DB resumes the pending breach', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-restart-'));
    try {
      const file = path.join(dir, 'triage.db');
      const first = setup(T0, file);
      const created = incidentOf(send(first.ctx, { fingerprint: 'fp-restart', severity: 'critical', title: 'survive' }).body);
      closeContext(first.ctx);
      closers.pop();

      const second = setup(T0 + 4 * MIN, file);
      expect(sweepSla(second.ctx)).toBe(0);
      second.clock.set(T0 + SLA_CRITICAL_MS);
      expect(sweepSla(second.ctx)).toBe(1);
      const after = getIncidentDetail(second.ctx, created.id)!.incident;
      expect(after.slaBreachedAt).toBe(T0 + SLA_CRITICAL_MS);
      expect(after.status).toBe('open');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweeps in batches until none are due', () => {
    const { ctx, clock } = setup();
    for (let i = 0; i < 1_200; i++) {
      send(ctx, { fingerprint: `fp-batch-${i}`, severity: 'critical', title: `batch ${i}` });
    }
    clock.set(T0 + SLA_CRITICAL_MS);
    expect(sweepSla(ctx)).toBe(1_200);
    expect(sweepSla(ctx)).toBe(0);
  });
});

describe('D2 idempotency', () => {
  it('replays the stored status and body for the same key and content, without changes', () => {
    const { ctx } = setup();
    const first = send(ctx, { fingerprint: 'fp-idem', title: 'idem' }, 'key-1');
    expect(first.replayed).toBe(false);
    const events = eventCount(ctx);
    const second = send(ctx, { fingerprint: 'fp-idem', title: 'idem' }, 'key-1');
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(eventCount(ctx)).toBe(events);
    expect(count(ctx, 'SELECT alert_count AS n FROM incidents WHERE fingerprint = ?', 'fp-idem')).toBe(1);
  });

  it('the same key with different content is 422 idempotency_key_reused and changes nothing', () => {
    const { ctx } = setup();
    send(ctx, { fingerprint: 'fp-idem2', title: 'original' }, 'key-2');
    const err = httpErrorOf(() => send(ctx, { fingerprint: 'fp-idem2', title: 'different' }, 'key-2'));
    expect(err.status).toBe(422);
    expect(err.code).toBe('idempotency_key_reused');
    expect(count(ctx, 'SELECT alert_count AS n FROM incidents WHERE fingerprint = ?', 'fp-idem2')).toBe(1);
  });

  it('a key older than 24h is treated as expired and may be reused', () => {
    const { ctx, clock } = setup();
    send(ctx, { fingerprint: 'fp-idem3', title: 'old' }, 'key-3');
    clock.advance(24 * 3_600_000 + 1);
    const res = send(ctx, { fingerprint: 'fp-idem4', title: 'new' }, 'key-3');
    expect(res.replayed).toBe(false);
    expect(res.body.action).toBe('created');
  });

  it('rejects an Idempotency-Key outside 1-255 characters', () => {
    const { ctx } = setup();
    const err = httpErrorOf(() => send(ctx, { fingerprint: 'fp-idem5' }, ''));
    expect(err.status).toBe(400);
  });
});

describe('D13 validation', () => {
  it('lists every problem in one 400 validation_failed', () => {
    const err = httpErrorOf(() =>
      parseAlert({ source: '', fingerprint: 'x'.repeat(300), severity: 'loud', title: '   ', ts: 'yesterday' }, T0),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
    for (const field of ['source', 'fingerprint', 'severity', 'title', 'ts']) {
      expect(err.message).toContain(field);
    }
  });

  it('accepts ISO strings and epoch numbers and rejects ts beyond the future skew', () => {
    const iso = parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: 't', ts: new Date(T0).toISOString() }, T0);
    expect(iso.ts).toBe(T0);
    const epoch = parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: ' t ', ts: T0 }, T0);
    expect(epoch.title).toBe('t');
    const future = httpErrorOf(() =>
      parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: 't', ts: T0 + 60_001 }, T0),
    );
    expect(future.status).toBe(400);
    expect(future.message).toContain('future');
    expect(() => parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: 't', ts: T0 + 60_000 }, T0)).not.toThrow();
  });

  it('rejects fractional epoch milliseconds and impossible ISO calendar dates', () => {
    const base = { source: 's', fingerprint: 'f', severity: 'info', title: 't' };
    const bad: unknown[] = [T0 + 0.5, '2026-02-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-13-01', '2026-04-31', '2026-01-01T24:00:00Z'];
    for (const ts of bad) {
      const err = httpErrorOf(() => parseAlert({ ...base, ts }, T0));
      expect(err.code).toBe('validation_failed');
      expect(err.message).toContain('ts');
    }
    // 2028 is a leap year, so Feb 29 is real. Date-only and zoned forms are accepted.
    expect(parseAlert({ ...base, ts: '2028-02-29' }, T0 + 10 * 365 * 86_400_000).ts).toBe(Date.UTC(2028, 1, 29));
    expect(parseAlert({ ...base, ts: '2026-10-08T12:00:00+02:00' }, T0).ts).toBe(T0 - 2 * 3_600_000);
  });

  it('keeps a "__proto__" payload key in the content hash', () => {
    const now = T0;
    const mk = (payload: Record<string, unknown>) =>
      alertContentHash(parseAlert({ source: 's', fingerprint: 'f', severity: 'info', title: 't', ts: T0, payload }, now));
    expect(mk(JSON.parse('{"__proto__":{"a":1}}'))).not.toBe(mk(JSON.parse('{"__proto__":{"a":2}}')));
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
});

describe('D7 audit triggers', () => {
  it('rejects UPDATE and DELETE on audit_log', () => {
    const { ctx } = setup();
    send(ctx, { fingerprint: 'fp-audit', title: 'audit me' });
    expect(() => ctx.db.run("UPDATE audit_log SET actor = 'x'")).toThrow(/append-only/);
    expect(() => ctx.db.run('DELETE FROM audit_log')).toThrow(/append-only/);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM audit_log')).toBeGreaterThan(0);
  });

  it('audit feed is newest first and paginates with an exclusive id cursor', () => {
    const { ctx, clock } = setup();
    const created = incidentOf(send(ctx, { fingerprint: 'fp-feed', title: 'feed' }).body);
    clock.advance(MIN);
    applyAction(ctx, created.id, 'ack', ALICE, 1);
    const feed = auditFeed(ctx, null, 50);
    expect(feed[0]!.id).toBeGreaterThan(feed[1]!.id);
    const older = auditFeed(ctx, feed[0]!.id, 50);
    expect(older.map((a) => a.id)).toEqual(feed.slice(1).map((a) => a.id));
  });
});

describe('transactions and publishing (D8)', () => {
  it('publishes frames only after COMMIT', () => {
    const { ctx } = setup();
    const { sub, frames } = recorder();
    ctx.hub.add(sub);
    const result = transact(ctx, (unit) => {
      unit.emit('probe', { step: 1 });
      expect(frames).toHaveLength(0);
      return 'done';
    });
    expect(result).toBe('done');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe('probe');
    expect(JSON.parse(frames[0]!.data)).toEqual({ step: 1 });
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM events WHERE seq = ?', frames[0]!.seq)).toBe(1);
  });

  it('publishes nothing and stores no event when the transaction throws', () => {
    const { ctx } = setup();
    const { sub, frames } = recorder();
    ctx.hub.add(sub);
    const before = eventCount(ctx);
    expect(() =>
      transact(ctx, (unit) => {
        unit.emit('probe', { rolledBack: true });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(frames).toHaveLength(0);
    expect(eventCount(ctx)).toBe(before);
  });

  it('a rejected ingest (422) publishes nothing', () => {
    const { ctx } = setup();
    send(ctx, { fingerprint: 'fp-quiet-422', title: 'a' }, 'k-422');
    const { sub, frames } = recorder();
    ctx.hub.add(sub);
    httpErrorOf(() => send(ctx, { fingerprint: 'fp-quiet-422', title: 'b' }, 'k-422'));
    expect(frames).toHaveLength(0);
  });

  it('nested transactions are refused', () => {
    const { ctx } = setup();
    expect(() => ctx.db.tx(() => ctx.db.tx(() => 1))).toThrow(/Nested/);
  });

  it('a subscriber never receives a frame at or below its lastSent', () => {
    const { ctx } = setup();
    const { sub, frames } = recorder();
    sub.lastSent = 100;
    ctx.hub.add(sub);
    ctx.hub.publish({ seq: 50, type: 'old', data: '{}' });
    ctx.hub.publish({ seq: 101, type: 'new', data: '{}' });
    expect(frames.map((f) => f.type)).toEqual(['new']);
  });
});

describe('lists and bulk actions (D11, bulk)', () => {
  it('keyset pagination is stable under inserts between pages', () => {
    const { ctx } = setup();
    for (let i = 1; i <= 5; i++) send(ctx, { fingerprint: `fp-page-${i}`, title: `page ${i}` });
    const p1 = listIncidents(ctx, { limit: 2 });
    expect(p1.items.map((i) => i.id)).toEqual([5, 4]);
    expect(p1.nextCursor).toBe('4');
    expect(p1.total).toBe(5);

    send(ctx, { fingerprint: 'fp-page-new', title: 'inserted between pages' });
    const p2 = listIncidents(ctx, { limit: 2, cursor: Number(p1.nextCursor) });
    expect(p2.items.map((i) => i.id)).toEqual([3, 2]);
    expect(p2.nextCursor).toBe('2');
    expect(p2.total).toBeNull();

    const p3 = listIncidents(ctx, { limit: 2, cursor: 2 });
    expect(p3.items.map((i) => i.id)).toEqual([1]);
    expect(p3.nextCursor).toBeNull();
  });

  it('title search escapes LIKE wildcards', () => {
    const { ctx } = setup();
    send(ctx, { fingerprint: 'fp-l1', title: 'Disk 100% full' });
    send(ctx, { fingerprint: 'fp-l2', title: 'Disk 100x full' });
    send(ctx, { fingerprint: 'fp-l3', title: 'disk_full_alpha' });
    send(ctx, { fingerprint: 'fp-l4', title: 'diskXfull' });
    expect(listIncidents(ctx, { limit: 50, q: '100%' }).items.map((i) => i.title)).toEqual(['Disk 100% full']);
    expect(listIncidents(ctx, { limit: 50, q: '%' }).items.map((i) => i.title)).toEqual(['Disk 100% full']);
    expect(listIncidents(ctx, { limit: 50, q: '_' }).items.map((i) => i.title)).toEqual(['disk_full_alpha']);
    expect(listIncidents(ctx, { limit: 50, q: 'DISK' }).items).toHaveLength(4);
  });

  it('bulk ack returns a per-item result with 200, 409 (with current) and 404', () => {
    const { ctx } = setup();
    const a = incidentOf(send(ctx, { fingerprint: 'fp-b1', title: 'a' }).body);
    const b = incidentOf(send(ctx, { fingerprint: 'fp-b2', title: 'b' }).body);
    applyAction(ctx, b.id, 'ack', ALICE, 1);
    const c = incidentOf(send(ctx, { fingerprint: 'fp-b3', title: 'c' }).body);
    const results = bulkAck(ctx, BOB, [
      { id: a.id, version: 1 },
      { id: b.id, version: 2 },
      { id: c.id, version: 9 },
      { id: 999_999, version: 1 },
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 409, 409, 404]);
    expect(results[0]!.incident?.status).toBe('acked');
    expect(results[1]!.error?.code).toBe('illegal_transition');
    expect(results[1]!.current?.status).toBe('acked');
    expect(results[2]!.error?.code).toBe('version_conflict');
    expect(results[2]!.current?.status).toBe('open');
    expect(results[3]!.current).toBeUndefined();
  });

  it('assigning the current assignee is a no-op, and an unknown assignee is 400', async () => {
    const { ctx } = setup();
    await ensureDemoUsers(ctx);
    const created = incidentOf(send(ctx, { fingerprint: 'fp-assign', title: 'assign' }).body);
    const err = httpErrorOf(() => applyAction(ctx, created.id, 'assign', ALICE, 1, 'u_nobody'));
    expect(err.status).toBe(400);
    expect(err.code).toBe('unknown_assignee');

    const assigned = applyAction(ctx, created.id, 'assign', ALICE, 1, 'u_bob');
    expect(assigned.assigneeId).toBe('u_bob');
    expect(assigned.version).toBe(2);
    const rev = assigned.rev;
    const same = applyAction(ctx, created.id, 'assign', ALICE, 2, 'u_bob');
    expect(same.version).toBe(2);
    expect(same.rev).toBe(rev);
  });
});

describe('D9 users and sessions', () => {
  it('ensureDemoUsers is idempotent and creates the three demo users', async () => {
    const { ctx } = setup();
    await ensureDemoUsers(ctx);
    await ensureDemoUsers(ctx);
    const users = listUsers(ctx);
    expect(users.map((u) => [u.id, u.username, u.displayName, u.role]).sort()).toEqual(
      [
        ['u_alice', 'alice', 'Alice Chen', 'admin'],
        ['u_bob', 'bob', 'Bob Okafor', 'responder'],
        ['u_carol', 'carol', 'Carol Diaz', 'viewer'],
      ].sort(),
    );
  });

  it('login issues a session that resolves to the user, and logout revokes it', async () => {
    const { ctx, clock } = setup();
    await ensureDemoUsers(ctx);
    expect(await login(ctx, 'bob', 'wrong-password')).toBeNull();
    expect(await login(ctx, 'nobody', 'triage-demo')).toBeNull();
    const ok = await login(ctx, 'bob', 'triage-demo');
    expect(ok).not.toBeNull();
    expect(ok!.user.role).toBe('responder');
    expect(findSession(ctx, ok!.token)?.user.id).toBe('u_bob');
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', ok!.token)).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', 'auth.login')).toBe(1);
    revokeSession(ctx, ok!.token);
    expect(findSession(ctx, ok!.token)).toBeNull();
    clock.advance(1);
  });

  it('an expired session is not accepted', async () => {
    const { ctx, clock } = setup();
    await ensureDemoUsers(ctx);
    const ok = await login(ctx, 'carol', 'triage-demo');
    clock.set(ok!.expiresAt - 1);
    expect(findSession(ctx, ok!.token)).not.toBeNull();
    clock.set(ok!.expiresAt);
    expect(findSession(ctx, ok!.token)).toBeNull();
  });

  it('a role change applies to the next request and the last admin cannot be demoted', async () => {
    const { ctx } = setup();
    await ensureDemoUsers(ctx);
    const bob = await login(ctx, 'bob', 'triage-demo');
    setUserRole(ctx, ALICE, 'u_bob', 'viewer');
    expect(findSession(ctx, bob!.token)?.user.role).toBe('viewer');
    const err = httpErrorOf(() => setUserRole(ctx, BOB, 'u_alice', 'viewer'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('last_admin');
    setUserRole(ctx, ALICE, 'u_carol', 'admin');
    expect(setUserRole(ctx, ALICE, 'u_alice', 'responder').role).toBe('responder');
    expect(count(ctx, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.role_changed'")).toBe(3);
  });

  it('cookies carry the flags the spec requires', () => {
    const now = T0;
    const expiresAt = now + 3_600_000;
    const cookie = sessionCookie('tok', expiresAt, false, now);
    expect(cookie).toBe(`${SESSION_COOKIE}=tok; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
    expect(sessionCookie('tok', expiresAt, true, now)).toMatch(/; Secure$/);
    expect(clearSessionCookie(false)).toMatch(/Max-Age=0/);
  });

  it('password hashes verify and use the scrypt$N$r$p$salt$hash layout', async () => {
    const stored = await hashPassword('triage-demo');
    expect(stored.split('$')).toHaveLength(6);
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('triage-demo', stored)).toBe(true);
    expect(await verifyPassword('triage-demp', stored)).toBe(false);
    expect(await verifyPassword('triage-demo', 'not-a-hash')).toBe(false);
  });

  it('an unknown username and a wrong password both fail with null', async () => {
    const { ctx } = setup();
    await ensureDemoUsers(ctx);
    expect(await login(ctx, 'ghost', 'anything')).toBeNull();
    expect(await login(ctx, 'ghost', 'triage-demo')).toBeNull();
  });

  it('setUserRole rejects an unknown role with a 400, not a raw SQLite error', async () => {
    const { ctx } = setup();
    await ensureDemoUsers(ctx);
    const err = httpErrorOf(() => setUserRole(ctx, ALICE, 'u_bob', 'root' as never));
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
    expect(listUsers(ctx).find((u) => u.id === 'u_bob')?.role).toBe('responder');
  });
});

describe('D12 retention', () => {
  it('keeps the newest 100,000 events and never prunes audit rows', () => {
    const { ctx } = setup();
    const insert = ctx.db.raw.prepare('INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)');
    ctx.db.tx(() => {
      for (let i = 0; i < 100_005; i++) insert.run('probe', '{}', T0);
    });
    runMaintenance(ctx);
    expect(eventCount(ctx)).toBe(100_000);
    const oldest = ctx.db.get<{ seq: number }>('SELECT MIN(seq) AS seq FROM events')!.seq;
    const newest = ctx.db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM events')!.seq;
    expect(newest - oldest).toBe(99_999);
  });
});

