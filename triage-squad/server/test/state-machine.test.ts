import { describe, it, expect } from 'vitest';
import { transition, type Action } from '../../shared/rules';
import type { Status } from '../../shared/types';

// Full transition table (D3). ok means the action is legal from that status.
const TABLE: Record<Status, Record<Action, Status | null>> = {
  open: { ack: 'acked', resolve: 'resolved', reopen: null, assign: 'open' },
  acked: { ack: null, resolve: 'resolved', reopen: null, assign: 'acked' },
  resolved: { ack: null, resolve: null, reopen: 'open', assign: null },
};

describe('state machine transition table', () => {
  for (const from of Object.keys(TABLE) as Status[]) {
    for (const action of Object.keys(TABLE[from]) as Action[]) {
      const expected = TABLE[from][action];
      it(`${from} + ${action} -> ${expected ?? 'illegal'}`, () => {
        const result = transition(from, action);
        if (expected === null) {
          expect(result).toEqual({ ok: false });
        } else {
          expect(result).toEqual({ ok: true, to: expected });
        }
      });
    }
  }

  it('covers all 12 combinations', () => {
    let count = 0;
    for (const from of Object.keys(TABLE) as Status[]) {
      count += Object.keys(TABLE[from]).length;
    }
    expect(count).toBe(12);
  });

  it('resolve is legal from open (stale-resolve scenario) and from acked', () => {
    expect(transition('open', 'resolve').ok).toBe(true);
    expect(transition('acked', 'resolve').ok).toBe(true);
  });

  it('nothing except reopen leaves resolved', () => {
    expect(transition('resolved', 'ack').ok).toBe(false);
    expect(transition('resolved', 'resolve').ok).toBe(false);
    expect(transition('resolved', 'assign').ok).toBe(false);
  });
});
