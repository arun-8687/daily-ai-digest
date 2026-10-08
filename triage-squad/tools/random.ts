// Seeded pseudo-random numbers for the simulators. Same seed, same sequence, so a run can be reproduced exactly.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element. The list must not be empty. */
  pick<T>(items: readonly T[]): T;
  /** Element chosen with the given relative weights (same length as items). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher-Yates shuffle, returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

/** Turns any seed (number or string) into a 32-bit state (xmur3 hash). */
function hashSeed(seed: number | string): number {
  const text = String(seed);
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: small, fast, and good enough for simulation data. */
export function createRng(seed: number | string): Rng {
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`int(${min}, ${max}): max is below min`);
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick() needs at least one item');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted(items, weights) {
      if (items.length === 0 || items.length !== weights.length) {
        throw new RangeError('weighted() needs one weight per item');
      }
      const total = weights.reduce((sum, w) => sum + w, 0);
      let roll = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        roll -= weights[i] as number;
        if (roll < 0) return items[i] as (typeof items)[number];
      }
      return items[items.length - 1] as (typeof items)[number];
    },
    shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
  };
  return rng;
}
