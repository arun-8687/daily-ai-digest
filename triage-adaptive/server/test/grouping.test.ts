import { describe, expect, it } from 'vitest';
import { FLAP_WINDOW_MS, GROUP_WINDOW_MS } from '../../shared/rules';
import { type GroupCandidate, decideGrouping } from '../src/grouping';

const MIN = 60_000;
const T = 1_800_000_000_000;

function open(id: number, lastSeen: number): GroupCandidate {
  return { id, status: 'open', lastSeen, resolvedAt: null };
}

function acked(id: number, lastSeen: number): GroupCandidate {
  return { id, status: 'acked', lastSeen, resolvedAt: null };
}

function resolved(id: number, lastSeen: number, resolvedAt: number): GroupCandidate {
  return { id, status: 'resolved', lastSeen, resolvedAt };
}

describe('D1 constants', () => {
  it('uses the documented windows', () => {
    expect(GROUP_WINDOW_MS).toBe(10 * MIN);
    expect(FLAP_WINDOW_MS).toBe(5 * MIN);
  });
});

describe('fold (step 1)', () => {
  it('folds at exactly the group window after last_seen (inclusive)', () => {
    expect(decideGrouping(T + GROUP_WINDOW_MS, [open(1, T)], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('creates when the alert is 1ms beyond the group window', () => {
    expect(decideGrouping(T + GROUP_WINDOW_MS + 1, [open(1, T)], null)).toEqual({ kind: 'create' });
  });

  it('folds a late alert exactly the window before last_seen (inclusive)', () => {
    expect(decideGrouping(T - GROUP_WINDOW_MS, [open(1, T)], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('creates when a late alert is 1ms beyond the window before last_seen', () => {
    expect(decideGrouping(T - GROUP_WINDOW_MS - 1, [open(1, T)], null)).toEqual({ kind: 'create' });
  });

  it('folds an alert that is older than last_seen but within the window (late fold)', () => {
    expect(decideGrouping(T - 3 * MIN, [open(7, T)], null)).toEqual({ kind: 'fold', incidentId: 7 });
  });

  it('folds into an acked incident as well as an open one', () => {
    expect(decideGrouping(T + MIN, [acked(4, T)], null)).toEqual({ kind: 'fold', incidentId: 4 });
  });

  it('picks the candidate with the greatest last_seen when several are in the window', () => {
    const decision = decideGrouping(T + 10 * MIN, [open(1, T), open(2, T + 8 * MIN)], null);
    expect(decision).toEqual({ kind: 'fold', incidentId: 2 });
  });

  it('breaks a last_seen tie with the larger id', () => {
    const decision = decideGrouping(T, [open(5, T), open(9, T), open(3, T)], null);
    expect(decision).toEqual({ kind: 'fold', incidentId: 9 });
  });

  it('ignores candidates outside the window even when they have a larger last_seen', () => {
    const decision = decideGrouping(T, [open(1, T - 11 * MIN), open(2, T - 9 * MIN)], null);
    expect(decision).toEqual({ kind: 'fold', incidentId: 2 });
  });

  it('never folds into a resolved entry passed among the unresolved candidates', () => {
    expect(decideGrouping(T, [resolved(1, T, T)], null)).toEqual({ kind: 'create' });
  });
});

describe('reopen / flap (step 2)', () => {
  const RESOLVED_AT = T + 60 * MIN;
  const latest = resolved(3, RESOLVED_AT - 2 * MIN, RESOLVED_AT);

  it('reopens at exactly 5 minutes after resolved_at (inclusive)', () => {
    expect(decideGrouping(RESOLVED_AT + FLAP_WINDOW_MS, [], latest)).toEqual({ kind: 'reopen', incidentId: 3 });
  });

  it('does not reopen 1ms beyond the flap window', () => {
    expect(decideGrouping(RESOLVED_AT + FLAP_WINDOW_MS + 1, [], latest)).toEqual({ kind: 'create' });
  });

  it('reopens at exactly 5 minutes before resolved_at (inclusive)', () => {
    expect(decideGrouping(RESOLVED_AT - FLAP_WINDOW_MS, [], latest)).toEqual({ kind: 'reopen', incidentId: 3 });
  });

  it('a fold into an unresolved incident wins over reopening the resolved one', () => {
    const decision = decideGrouping(RESOLVED_AT + MIN, [open(8, RESOLVED_AT)], latest);
    expect(decision).toEqual({ kind: 'fold', incidentId: 8 });
  });

  it('reopens the latest resolved incident passed in', () => {
    const decision = decideGrouping(RESOLVED_AT + MIN, [], latest);
    expect(decision).toEqual({ kind: 'reopen', incidentId: 3 });
  });
});

describe('attach (step 3)', () => {
  const RESOLVED_AT = T + 60 * MIN;
  const latest = resolved(4, RESOLVED_AT - 2 * MIN, RESOLVED_AT);

  it('attaches when the alert is more than the flap window before resolved_at and near last_seen', () => {
    const ts = RESOLVED_AT - FLAP_WINDOW_MS - 1;
    expect(ts - latest.lastSeen).toBeGreaterThanOrEqual(-GROUP_WINDOW_MS);
    expect(decideGrouping(ts, [], latest)).toEqual({ kind: 'attach', incidentId: 4 });
  });

  it('attaches at exactly the group window from last_seen (inclusive)', () => {
    const resolvedAt = T + 60 * MIN;
    const lastSeen = resolvedAt - 30 * MIN;
    const resolvedCandidate = resolved(6, lastSeen, resolvedAt);
    const ts = lastSeen - GROUP_WINDOW_MS;
    expect(ts < resolvedAt - FLAP_WINDOW_MS).toBe(true);
    expect(decideGrouping(ts, [], resolvedCandidate)).toEqual({ kind: 'attach', incidentId: 6 });
  });

  it('creates when the alert is 1ms beyond the group window from last_seen', () => {
    const resolvedAt = T + 60 * MIN;
    const lastSeen = resolvedAt - 30 * MIN;
    const resolvedCandidate = resolved(6, lastSeen, resolvedAt);
    const ts = lastSeen - GROUP_WINDOW_MS - 1;
    expect(decideGrouping(ts, [], resolvedCandidate)).toEqual({ kind: 'create' });
  });

  it('does not attach an alert that is inside the flap window (it reopens instead)', () => {
    expect(decideGrouping(RESOLVED_AT - FLAP_WINDOW_MS, [], latest).kind).toBe('reopen');
  });

  it('creates when no resolved incident exists and nothing is unresolved', () => {
    expect(decideGrouping(T, [], null)).toEqual({ kind: 'create' });
  });

  it('creates when the latest resolved entry has no resolved_at', () => {
    const broken: GroupCandidate = { id: 2, status: 'resolved', lastSeen: T, resolvedAt: null };
    expect(decideGrouping(T, [], broken)).toEqual({ kind: 'create' });
  });
});
