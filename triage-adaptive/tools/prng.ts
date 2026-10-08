// Seeded pseudo-random numbers (mulberry32). Same seed, same sequence: the seed tool and the
// burst simulator are reproducible from their --seed flag.

export interface Rng {
  /** Uniform float in [0, 1). */
  float(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform float in [lo, hi). */
  between(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates, in place. Returns the same array. */
  shuffle<T>(items: T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const float = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(float() * n);
  return {
    float,
    int,
    between: (lo, hi) => lo + float() * (hi - lo),
    chance: (p) => float() < p,
    pick: (items) => items[int(items.length)]!,
    shuffle(items) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return items;
    },
  };
}
