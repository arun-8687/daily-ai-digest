import { createHash, randomBytes } from 'node:crypto';

/** Sorted-key JSON so that equal objects always serialise identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    // A null-prototype target so a key such as "__proto__" becomes an ordinary property
    // instead of invoking the Object.prototype setter and being dropped.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key] = sortKeys(src[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Session and idempotency tokens are stored only as their sha256. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return sha256Hex(token);
}

/** Escapes LIKE wildcards so user input is matched literally (used with ESCAPE '\'). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
