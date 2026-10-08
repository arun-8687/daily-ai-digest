import { describe, expect, it } from 'vitest';
import { type Action, type TransitionResult, transition } from '../../shared/rules';
import { type Status } from '../../shared/types';
import { SYSTEM_INGEST, type Actor } from '../src/audit';
import { createContext } from '../src/context';
import { HttpError } from '../src/errors';
import { applyAction, loadIncidentDto } from '../src/incidents';
import { ingestAlert, parseAlert } from '../src/ingest';
import { manualClock } from '../src/clock';
import { loadConfig } from '../src/config';
import { ensureDemoUsers } from '../src/users';

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const ALICE: Actor = { id: 'u_alice', name: 'Alice Chen' };

/** Full transition table: 3 statuses x 4 actions (D3 / shared rules). */
const TABLE: Record<Status, Record<Action, TransitionResult>> = {
  open: {
    ack: { ok: true, to: 'acked' },
    resolve: { ok: true, to: 'resolved' },
    reopen: { ok: false },
    assign: { ok: true, to: 'open' },
  },
  acked: {
    ack: { ok: false },
    resolve: { ok: true, to: 'resolved' },
    reopen: { ok: false },
    assign: { ok: true, to: 'acked' },
  },
  resolved: {
    ack: { ok: false },
    resolve: { ok: false },
    reopen: { ok: true, to: 'open' },
    assign: { ok: false },
  },
};

describe('transition() table', () => {
  for (const from of Object.keys(TABLE) as Status[]) {
    for (const action of Object.keys(TABLE[from]) as Action[]) {
      const expected = TABLE[from][action];
      it(`${from} + ${action} -> ${expected.ok ? expected.to : 'illegal'}`, () => {
        expect(transition(from, action)).toEqual(expected);
      });
    }
  }
});

function freshCtx(clockStart = T0) {
  const clock = manualClock(clockStart);
  const ctx = createContext(loadConfig({ TRIAGE_DB: ':memory:', TRIAGE_WEB_DIR: 'none' }), clock);
  return { ctx, clock };
}

function alertFor(severity: 'warning' | 'critical', ts: number) {
  return parseAlert({ source: 'api', fingerprint: 'fp-state', severity, title: 'State machine alert', ts }, ts);
}

/** Builds an incident in the requested status and returns its id and version. */
async function incidentIn(status: Status) {
  const { ctx, clock } = freshCtx();
  await ensureDemoUsers(ctx);
  const created = ingestAlert(ctx, alertFor('warning', clock.now()));
  const id = created.body.incidentId;
  let version = 1;
  if (status === 'acked') {
    version = applyAction(ctx, id, 'ack', ALICE, version, undefined).version;
  } else if (status === 'resolved') {
    version = applyAction(ctx, id, 'resolve', ALICE, version, undefined).version;
  }
  return { ctx, clock, id, version };
}

describe('applyAction enforces the table (409 illegal_transition with current)', () => {
  const statuses: Status[] = ['open', 'acked', 'resolved'];
  const actions: Action[] = ['ack', 'resolve', 'reopen', 'assign'];

  for (const status of statuses) {
    for (const action of actions) {
      const expected = TABLE[status][action];
      it(`${status} + ${action}: ${expected.ok ? `succeeds to ${expected.to}` : 'is refused'}`, async () => {
        const { ctx, id, version } = await incidentIn(status);
        const run = () =>
          applyAction(ctx, id, action, ALICE, version, action === 'assign' ? 'u_bob' : undefined);
        if (expected.ok) {
          const dto = run();
          expect(dto.status).toBe(expected.to);
        } else {
          let caught: unknown;
          try {
            run();
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(HttpError);
          const httpErr = caught as HttpError;
          expect(httpErr.status).toBe(409);
          expect(httpErr.code).toBe('illegal_transition');
          expect(httpErr.current?.status).toBe(status);
          expect(loadIncidentDto(ctx, id)?.status).toBe(status);
        }
      });
    }
  }

  it('a missing incident is 404 not_found before any other check', () => {
    const { ctx } = freshCtx();
    let caught: unknown;
    try {
      applyAction(ctx, 999, 'ack', ALICE, 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(404);
    expect((caught as HttpError).code).toBe('not_found');
  });

  it('a stale version is 409 version_conflict and is checked before legality', async () => {
    const { ctx, id } = await incidentIn('resolved');
    try {
      applyAction(ctx, id, 'ack', ALICE, 99);
      throw new Error('expected a conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('version_conflict');
      expect((err as HttpError).current?.status).toBe('resolved');
    }
  });

  it('the created audit row is written by system ingest', async () => {
    const { ctx, id } = await incidentIn('open');
    const rows = ctx.db.all<{ actor: string }>('SELECT actor FROM audit_log WHERE incident_id = ?', id);
    expect(rows.map((r) => r.actor)).toContain(SYSTEM_INGEST.id);
  });
});
