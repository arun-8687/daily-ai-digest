import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

// Format: scrypt$N$r$p$<salt base64>$<hash base64>
const COST_N = 16_384;
const BLOCK_R = 8;
const PARALLEL_P = 1;
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, { N: n, r, p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST_N, BLOCK_R, PARALLEL_P, KEY_LENGTH);
  return `scrypt$${COST_N}$${BLOCK_R}$${PARALLEL_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2) return false;

  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (expected.length === 0) return false;

  const key = await derive(password, salt, n, r, p, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
