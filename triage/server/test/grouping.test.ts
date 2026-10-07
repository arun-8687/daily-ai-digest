import { describe, expect, it } from 'vitest';
import { decideGrouping, type GroupCandidate } from '../src/grouping';

const T = Date.UTC(2026, 0, 15, 12, 0, 0);
const MIN = 60_000;

const unresolved = (id: number, lastSeen: number, status: 'open' | 'acked' = 'open'): GroupCandidate => ({
  id,
  status,
  lastSeen,
  resolvedAt: null,
});
const resolved = (id: number, lastSeen: number, resolvedAt: number): GroupCandidate => ({
  id,
  status: 'resolved',
  lastSeen,
  resolvedAt,
});

describe('decideGrouping: folding into unresolved incidents', () => {
  it('creates an incident when nothing exists', () => {
    expect(decideGrouping(T, [], null)).toEqual({ kind: 'create' });
  });

  it('folds an alert exactly 10 minutes after the last alert (inclusive boundary)', () => {
    expect(decideGrouping(T + 10 * MIN, [unresolved(1, T)], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('starts a new incident 10 minutes plus 1 ms after the last alert', () => {
    expect(decideGrouping(T + 10 * MIN + 1, [unresolved(1, T)], null)).toEqual({ kind: 'create' });
  });

  it('folds late, out-of-order alerts that are within 10 minutes before last_seen', () => {
    expect(decideGrouping(T - 7 * MIN, [unresolved(1, T)], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('folds into acked incidents as well as open ones', () => {
    expect(decideGrouping(T + MIN, [unresolved(1, T, 'acked')], null)).toEqual({ kind: 'fold', incidentId: 1 });
  });

  it('prefers the candidate with the most recent last_seen when several match', () => {
    const older = unresolved(1, T);
    const newer = unresolved(2, T + 8 * MIN);
    // T+10min is within 10min of both (distance 10 and 2). The newer one wins.
    expect(decideGrouping(T + 10 * MIN, [older, newer], null)).toEqual({ kind: 'fold', incidentId: 2 });
  });
});

describe('decideGrouping: flapping (alerts around a resolve)', () => {
  const resolvedAt = T + 30 * MIN;

  it('reopens when an alert arrives 5 minutes after the resolve (inclusive)', () => {
    expect(decideGrouping(resolvedAt + 5 * MIN, [], resolved(7, T, resolvedAt))).toEqual({
      kind: 'reopen',
      incidentId: 7,
    });
  });

  it('reopens for an alert just before the resolve (late delivery of a flap)', () => {
    expect(decideGrouping(resolvedAt - 2 * MIN, [], resolved(7, T, resolvedAt))).toEqual({
      kind: 'reopen',
      incidentId: 7,
    });
  });

  it('starts a new incident once the alert is later than 5 minutes after the resolve', () => {
    expect(decideGrouping(resolvedAt + 5 * MIN + 1, [], resolved(7, T, resolvedAt))).toEqual({ kind: 'create' });
  });

  it('attaches a late alert from before the resolved episode without reopening it', () => {
    // 8 minutes after the episode's last alert (within the window) and 22 minutes before the resolve.
    expect(decideGrouping(T + 8 * MIN, [], resolved(7, T, resolvedAt))).toEqual({
      kind: 'attach',
      incidentId: 7,
    });
  });

  it('starts a new incident for an old alert far from the resolved episode', () => {
    expect(decideGrouping(T - 60 * MIN, [], resolved(7, T, resolvedAt))).toEqual({ kind: 'create' });
  });

  it('prefers folding into an unresolved incident over reopening a resolved one', () => {
    expect(decideGrouping(resolvedAt + MIN, [unresolved(9, resolvedAt)], resolved(7, T, resolvedAt))).toEqual({
      kind: 'fold',
      incidentId: 9,
    });
  });
});
