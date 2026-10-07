import { describe, expect, it } from 'vitest';
import { transition, type Action } from '../../shared/rules';
import type { Status } from '../../shared/types';

describe('incident state machine', () => {
  const table: [Status, Action, Status | null][] = [
    // ack: open -> acked only
    ['open', 'ack', 'acked'],
    ['acked', 'ack', null],
    ['resolved', 'ack', null],
    // resolve: open or acked -> resolved
    ['open', 'resolve', 'resolved'],
    ['acked', 'resolve', 'resolved'],
    ['resolved', 'resolve', null],
    // reopen: resolved -> open only
    ['resolved', 'reopen', 'open'],
    ['open', 'reopen', null],
    ['acked', 'reopen', null],
    // assign: any unresolved state, status unchanged
    ['open', 'assign', 'open'],
    ['acked', 'assign', 'acked'],
    ['resolved', 'assign', null],
  ];

  it.each(table)('%s + %s -> %s', (from, action, expected) => {
    const result = transition(from, action);
    if (expected === null) {
      expect(result).toEqual({ ok: false });
    } else {
      expect(result).toEqual({ ok: true, to: expected });
    }
  });

  it('every path through the lifecycle is reachable: open -> acked -> resolved -> open', () => {
    let s: Status = 'open';
    for (const action of ['ack', 'resolve', 'reopen'] as const) {
      const r = transition(s, action);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.to;
    }
    expect(s).toBe('open');
  });
});
