import { randomBytes } from 'node:crypto';
import { hashPassword } from './passwords';
import type { UserDTO } from '../../shared/types';
import { writeAudit } from './audit';
import { transact, type AppContext } from './context';
import { sha256 } from './util';
import { toUserDTO, type UserRow } from './users';

export const SESSION_COOKIE = 'triage_session';

export interface AuthSession {
  user: UserDTO;
  tokenHash: string;
  expiresAt: number;
}

/** Stores only a hash of the token, so a leaked database does not leak live sessions. */
export function createSession(ctx: AppContext, userId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expiresAt = now + ctx.config.sessionTtlMs;
  ctx.db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token),
    userId,
    now,
    expiresAt,
  );
  return { token, expiresAt };
}

export function findSession(ctx: AppContext, token: string | null): AuthSession | null {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = ctx.db.get<{ expires_at: number } & UserRow>(
    `SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    ctx.clock.now(),
  );
  if (!row) return null;
  return { user: toUserDTO(row), tokenHash, expiresAt: row.expires_at };
}

export function revokeSession(ctx: AppContext, token: string): void {
  ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Creates a session and records the login in the audit log, atomically. */
export function startSession(ctx: AppContext, user: UserDTO): { token: string; expiresAt: number } {
  return transact(ctx, () => {
    const session = createSession(ctx, user.id);
    writeAudit(ctx, {
      incidentId: null,
      actor: { id: user.id, name: user.displayName },
      action: 'auth.login',
      before: null,
      after: { username: user.username },
    });
    return session;
  });
}

let dummy: string | null = null;

/** A real hash of a throwaway secret, used so unknown usernames cost the same as known ones. */
export async function hashedDummy(): Promise<string> {
  dummy ??= await hashPassword(randomBytes(12).toString('hex'));
  return dummy;
}
