import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Random bytes encoded as base64url (no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time string comparison. Both values are hashed first so the timing
 * does not depend on where they differ or on their lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  const same = timingSafeEqual(digestA, digestB);
  return same && a.length === b.length;
}

/** JSON with object keys sorted recursively, so equal values always serialise identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Object.fromEntries defines own properties, so a key such as "__proto__" stays in the output
    // (assigning out[key] on a plain object would set the prototype and drop the key from the hash).
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortKeys(source[key])]));
  }
  return value;
}

/** Escapes LIKE wildcards and the escape character itself (used with ESCAPE '\'). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
