import { describe, it, expect } from 'vitest';
import { FLAP_WINDOW_MS, GROUP_WINDOW_MS } from '../../shared/rules';
import { decideGrouping, type GroupCandidate } from '../src/grouping';

const T = 1_700_000_000_000;
const MIN = 60_000;

function open(id: number, lastSeen: number, status: 'open' | 'acked' = 'open'): GroupCandidate {
  return { id, status, lastSeen, resolvedAt: null };
}

function resolved(id: number, lastSeen: number, resolvedAt: number): GroupCandidate {
  return { id, status: 'resolved', lastSeen, resolvedAt };
}

describe('D1 grouping: fold into unresolved incidents', () => {
  it('creates when there is nothing to group with', () => {
    expect(decideGrouping(T, [], null)).toEqual({ kind: 'create' });
  });

  it('folds at exactly the group window (inclusive, later side)', () => {
    expect(decideGrouping(T + GROUP_WINDOW_MS, [open(1, T)], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('folds at exactly the group window (inclusive, earlier side)', () => {
    expect(decideGrouping(T - GROUP_WINDOW_MS, [open(1, T)], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('creates 1ms past the group window (later side)', () => {
    expect(decideGrouping(T + GROUP_WINDOW_MS + 1, [open(1, T)], null)).toEqual({ kind: 'create' });
  });

  it('creates 1ms past the group window (earlier side)', () => {
    expect(decideGrouping(T - GROUP_WINDOW_MS - 1, [open(1, T)], null)).toEqual({ kind: 'create' });
  });

  it('a late alert (ts before last_seen, within window) still folds', () => {
    expect(decideGrouping(T - 3 * MIN, [open(7, T)], null)).toEqual({ kind: 'fold', incidentId: 7 });
  });

  it('folds an acked incident too', () => {
    expect(decideGrouping(T + MIN, [open(3, T, 'acked')], null)).toEqual({ kind: 'fold', incidentId: 3 });
  });

  it('with several candidates, folds into the one with the max last_seen', () => {
    const candidates = [open(1, T), open(2, T + 3 * MIN), open(3, T - 2 * MIN)];
    expect(decideGrouping(T + 4 * MIN, candidates, null)).toEqual({ kind: 'fold', incidentId: 2 });
  });

  it('breaks a last_seen tie with the max id', () => {
    const candidates = [open(4, T), open(9, T), open(6, T)];
    expect(decideGrouping(T + MIN, candidates, null)).toEqual({ kind: 'fold', incidentId: 9 });
  });

  it('ignores candidates outside the window and picks one inside it', () => {
    const candidates = [open(1, T + 20 * MIN), open(2, T)];
    expect(decideGrouping(T + 5 * MIN, candidates, null)).toEqual({ kind: 'fold', incidentId: 2 });
  });

  it('prefers an unresolved fold over a flap reopen of the latest resolved incident', () => {
    const resolvedAt = T + MIN;
    const candidates = [open(5, T)];
    expect(decideGrouping(T + 2 * MIN, candidates, resolved(8, T, resolvedAt))).toEqual({
      kind: 'fold',
      incidentId: 5,
    });
  });
});

describe('D1 grouping: flap reopen', () => {
  const R = T + 60 * MIN;

  it('reopens at exactly the flap window before the resolution', () => {
    expect(decideGrouping(R - FLAP_WINDOW_MS, [], resolved(11, R - 30 * MIN, R))).toEqual({
      kind: 'reopen',
      incidentId: 11,
    });
  });

  it('reopens at exactly the flap window after the resolution', () => {
    expect(decideGrouping(R + FLAP_WINDOW_MS, [], resolved(11, R - 30 * MIN, R))).toEqual({
      kind: 'reopen',
      incidentId: 11,
    });
  });

  it('does not reopen 1ms after the flap window (after side); creates instead', () => {
    expect(decideGrouping(R + FLAP_WINDOW_MS + 1, [], resolved(11, R, R))).toEqual({ kind: 'create' });
  });

  it('reopens an exact-window resolution when the alert ts is just inside the flap window (before side)', () => {
    expect(decideGrouping(R - FLAP_WINDOW_MS + 1, [], resolved(11, R, R))).toEqual({
      kind: 'reopen',
      incidentId: 11,
    });
  });

  it('only the most recently resolved incident is considered for a flap', () => {
    // The caller passes the latest resolved incident; an older one never reaches decideGrouping.
    expect(decideGrouping(R, [], resolved(12, R - 2 * MIN, R))).toEqual({ kind: 'reopen', incidentId: 12 });
  });

  it('reopens an unresolved-free fingerprint even when last_seen is far away', () => {
    expect(decideGrouping(R + MIN, [], resolved(13, R - 90 * MIN, R))).toEqual({ kind: 'reopen', incidentId: 13 });
  });
});

describe('D1 grouping: attach late alerts to a resolved incident', () => {
  const R = T + 60 * MIN;

  it('attaches at exactly flap+1ms before resolution when last_seen is within the group window', () => {
    const ts = R - FLAP_WINDOW_MS - 1;
    expect(decideGrouping(ts, [], resolved(21, ts, R))).toEqual({ kind: 'attach', incidentId: 21 });
  });

  it('attaches when the alert is exactly the group window from last_seen (inclusive)', () => {
    const lastSeen = R - 30 * MIN;
    const ts = lastSeen - GROUP_WINDOW_MS;
    expect(decideGrouping(ts, [], resolved(22, lastSeen, R))).toEqual({ kind: 'attach', incidentId: 22 });
  });

  it('creates when the alert is 1ms outside the group window from last_seen', () => {
    const lastSeen = R - 30 * MIN;
    const ts = lastSeen - GROUP_WINDOW_MS - 1;
    expect(decideGrouping(ts, [], resolved(22, lastSeen, R))).toEqual({ kind: 'create' });
  });

  it('creates for an old alert well before the resolution when nothing is close to it', () => {
    const lastSeen = R - 2 * MIN;
    expect(decideGrouping(R - 40 * MIN, [], resolved(23, lastSeen, R))).toEqual({ kind: 'create' });
  });

  it('attach never applies inside the flap window (that case is a reopen)', () => {
    const lastSeen = R - MIN;
    expect(decideGrouping(R - FLAP_WINDOW_MS, [], resolved(24, lastSeen, R))).toEqual({
      kind: 'reopen',
      incidentId: 24,
    });
  });
});

describe('D1 grouping: create', () => {
  it('creates when the only candidates are outside every window', () => {
    const R = T + 60 * MIN;
    expect(decideGrouping(T + 30 * MIN, [open(1, T)], resolved(2, T, R))).toEqual({ kind: 'create' });
  });

  it('ignores a resolved entry that has no resolved_at', () => {
    const malformed: GroupCandidate = { id: 30, status: 'resolved', lastSeen: T, resolvedAt: null };
    expect(decideGrouping(T, [], malformed)).toEqual({ kind: 'create' });
  });
});
