import { ROLES, type Role, type UserDTO } from '../../shared/types';
import { type Actor, writeAudit } from './audit';
import { type AppContext } from './context';
import { HttpError } from './errors';
import { hashPassword } from './passwords';

export const DEMO_PASSWORD = 'triage-demo';

export const DEMO_USERS: ReadonlyArray<UserDTO> = [
  { id: 'u_alice', username: 'alice', displayName: 'Alice Chen', role: 'admin' },
  { id: 'u_bob', username: 'bob', displayName: 'Bob Okafor', role: 'responder' },
  { id: 'u_carol', username: 'carol', displayName: 'Carol Diaz', role: 'viewer' },
];

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
}

export function userToDto(r: UserRow): UserDTO {
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role };
}

/** Inserts the demo users that do not exist yet. Existing users (even with changed roles) are left alone. */
export async function ensureDemoUsers(ctx: AppContext, password: string = DEMO_PASSWORD): Promise<void> {
  for (const u of DEMO_USERS) {
    const exists = ctx.db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', u.id);
    if (exists) continue;
    const hash = await hashPassword(password);
    ctx.db.run(
      'INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      u.id,
      u.username,
      u.displayName,
      u.role,
      hash,
      ctx.clock.now(),
    );
  }
}

export function listUsers(ctx: AppContext): UserDTO[] {
  return ctx.db
    .all<UserRow>('SELECT id, username, display_name, role FROM users ORDER BY display_name COLLATE NOCASE, id')
    .map(userToDto);
}

export function getUser(ctx: AppContext, id: string): UserDTO | null {
  const r = ctx.db.get<UserRow>('SELECT id, username, display_name, role FROM users WHERE id = ?', id);
  return r ? userToDto(r) : null;
}

/**
 * Changes a user's role. Writes user.role_changed. Demoting the last admin is a 409 last_admin.
 * The count and the update share one BEGIN IMMEDIATE transaction, so concurrent demotions cannot both pass.
 */
export function setUserRole(ctx: AppContext, actor: Actor, targetId: string, role: Role): UserDTO {
  // Validated here, not left to the SQLite CHECK constraint, so a bad value is a 400 for every caller.
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new HttpError(400, 'validation_failed', `role: must be ${ROLES.join(', ')}`);
  }
  return ctx.db.tx(() => {
    const target = ctx.db.get<UserRow>('SELECT id, username, display_name, role FROM users WHERE id = ?', targetId);
    if (!target) throw new HttpError(404, 'not_found', 'User not found');
    if (target.role === role) return userToDto(target);
    if (target.role === 'admin' && role !== 'admin') {
      const admins = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0;
      if (admins <= 1) {
        throw new HttpError(409, 'last_admin', 'The last admin cannot be demoted');
      }
    }
    ctx.db.run('UPDATE users SET role = ? WHERE id = ?', role, targetId);
    writeAudit(ctx.db, {
      incidentId: null,
      actor,
      action: 'user.role_changed',
      before: { userId: targetId, role: target.role },
      after: { userId: targetId, role },
      now: ctx.clock.now(),
    });
    return userToDto({ ...target, role });
  });
}
