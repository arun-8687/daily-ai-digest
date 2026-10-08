// Injectable time source (D14). Every time read in the server goes through a Clock.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

/** Deterministic clock for tests and the seed simulation. */
export function manualClock(start: number): ManualClock {
  let t = start;
  return {
    now: () => t,
    set(ms: number) {
      t = ms;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}
