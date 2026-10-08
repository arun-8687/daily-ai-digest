import type { UserDTO } from '../../shared/types';
import type { AppContext } from './context';
import { transact } from './context';
import { hashPassword, verifyPassword } from './passwords';
import { randomToken, sha256Hex } from './util';
import { toUserDTO, type UserRow } from './users';

export const SESSION_COOKIE = 'triage_session';

export interface AuthSession {
  user: UserDTO;
  tokenHash: string;
  expiresAt: number;
}

/**
 * A real scrypt hash used for unknown usernames, so a failed login always costs one scrypt.
 * Computed at module load so the first unknown-user login does not pay for hashing as well.
 */
const dummyHash: Promise<string> = hashPassword('timing-equalizer-not-a-password');
// Login awaits this same promise and surfaces any failure there; this only stops an early rejection being reported as unhandled.
dummyHash.catch(() => undefined);

export async function login(
  ctx: AppContext,
  username: string,
  password: string,
): Promise<{ user: UserDTO; token: string; expiresAt: number } | null> {
  const row = ctx.db.get<UserRow>(
    'SELECT id, username, display_name, role, password_hash FROM users WHERE username = ?',
    username,
  );
  const hash = row ? row.password_hash : await dummyHash;
  const ok = await verifyPassword(password, hash);
  if (!row || !ok) return null;

  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  return transact(ctx, (unit) => {
    const now = ctx.clock.now();
    const expiresAt = now + ctx.config.sessionTtlMs;
    ctx.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      tokenHash,
      row.id,
      now,
      expiresAt,
    );
    unit.audit({
      incidentId: null,
      actor: { id: row.id, name: row.display_name },
      action: 'auth.login',
      before: null,
      after: { username: row.username, role: row.role },
    });
    return { user: toUserDTO(row), token, expiresAt };
  });
}

export function findSession(ctx: AppContext, token: string | null): AuthSession | null {
  if (!token) return null;
  const row = ctx.db.get<{
    token_hash: string;
    expires_at: number;
    id: string;
    username: string;
    display_name: string;
    role: UserDTO['role'];
  }>(
    `SELECT s.token_hash, s.expires_at, u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    sha256Hex(token),
  );
  if (!row || row.expires_at <= ctx.clock.now()) return null;
  return {
    user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role },
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
  };
}

export function revokeSession(ctx: AppContext, token: string): void {
  transact(ctx, () => {
    ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256Hex(token));
  });
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
