import { hasRole } from '../../shared/rules';
import { type Role, type UserDTO } from '../../shared/types';
import { type Actor, writeAudit } from './audit';
import { type AppContext } from './context';
import { HttpError } from './errors';
import { verifyPassword } from './passwords';
import { newToken, tokenHash } from './util';
import { type UserRow, userToDto } from './users';

export const SESSION_COOKIE = 'triage_session';

export interface AuthSession {
  user: UserDTO;
  tokenHash: string;
  expiresAt: number;
}

export interface LoginResult {
  user: UserDTO;
  token: string;
  expiresAt: number;
}

interface CredentialRow extends UserRow {
  password_hash: string;
}

/**
 * A real scrypt hash (same parameters as passwords.ts) of a throwaway password that nobody knows.
 * It is a fixed constant rather than computed on demand, so an unknown username costs exactly one
 * verify from the first request after boot, the same as a wrong password for a real user.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$Jbd6DI1/DCQJ3T2Uivg5Gw==$6qeJ6oTMmWiHbzPQERlbkqQPUBQLz4JB+zr+30jERb7LcM5UcXO9aJpauw/Iggm5KvKSOdpyPL9Hpep8dVly2A==';

/**
 * Checks credentials. Returns null for an unknown user or a wrong password (both run one scrypt).
 * On success creates a session (only its sha256 is stored) and writes an auth.login audit row.
 */
export async function login(ctx: AppContext, username: string, password: string): Promise<LoginResult | null> {
  const row = ctx.db.get<CredentialRow>(
    'SELECT id, username, display_name, role, password_hash FROM users WHERE username = ?',
    username,
  );
  if (!row) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;

  const token = newToken();
  const now = ctx.clock.now();
  const expiresAt = now + ctx.config.sessionTtlMs;
  const user = userToDto(row);
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      tokenHash(token),
      user.id,
      expiresAt,
      now,
    );
    writeAudit(ctx.db, {
      incidentId: null,
      actor: { id: user.id, name: user.displayName },
      action: 'auth.login',
      before: null,
      after: { username: user.username },
      now,
    });
  });
  return { user, token, expiresAt };
}

/**
 * Resolves a session token. Returns null when the token is missing, unknown or expired.
 * The role is read from the users table on every call, so role changes apply immediately.
 */
export function findSession(ctx: AppContext, token: string | null): AuthSession | null {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = ctx.db.get<{ expires_at: number } & UserRow>(
    `SELECT s.expires_at, u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    hash,
  );
  if (!row) return null;
  if (ctx.clock.now() >= row.expires_at) return null;
  return { user: userToDto(row), tokenHash: hash, expiresAt: row.expires_at };
}

export function revokeSession(ctx: AppContext, token: string): void {
  ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** True when the actual role satisfies the required one (viewer < responder < admin). */
export function roleAllows(actual: Role, required: Role): boolean {
  return hasRole(actual, required);
}

/** Throws 403 forbidden unless the user's role satisfies the requirement. */
export function requireRole(user: UserDTO, required: Role): void {
  if (!roleAllows(user.role, required)) {
    throw new HttpError(403, 'forbidden', `This action requires the ${required} role`);
  }
}

export function actorOf(user: UserDTO): Actor {
  return { id: user.id, name: user.displayName };
}
