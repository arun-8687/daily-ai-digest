import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt parameters are stored in every hash, so they can be raised later. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAX_MEM = 64 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, keyLen: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Returns `scrypt$N$r$p$salt$hash` (base64 salt and hash). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await deriveKey(password, salt, KEY_LEN, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!(n > 0 && r > 0 && p > 0) || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await deriveKey(password, salt, expected.length, n, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
