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

export function manualClock(start: number): ManualClock {
  let current = start;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}
