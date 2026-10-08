import type { Role, UserDTO } from '../../shared/types';
import type { Actor } from './audit';
import type { AppContext } from './context';
import { transact } from './context';
import { HttpError } from './errors';
import { hashPassword } from './passwords';

export const DEMO_PASSWORD = 'triage-demo';

const DEMO_USERS: ReadonlyArray<{ id: string; username: string; displayName: string; role: Role }> = [
  { id: 'u_alice', username: 'alice', displayName: 'Alice Chen', role: 'admin' },
  { id: 'u_bob', username: 'bob', displayName: 'Bob Okafor', role: 'responder' },
  { id: 'u_carol', username: 'carol', displayName: 'Carol Diaz', role: 'viewer' },
];

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
}

export function toUserDTO(row: Pick<UserRow, 'id' | 'username' | 'display_name' | 'role'>): UserDTO {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

/** Creates any missing demo users. Existing users are left untouched, so this is idempotent. */
export async function ensureDemoUsers(ctx: AppContext, password: string = DEMO_PASSWORD): Promise<void> {
  const missing = DEMO_USERS.filter((u) => ctx.db.get('SELECT id FROM users WHERE id = ?', u.id) === undefined);
  if (missing.length === 0) return;

  const hashed: Array<{ user: (typeof DEMO_USERS)[number]; hash: string }> = [];
  for (const user of missing) {
    hashed.push({ user, hash: await hashPassword(password) });
  }

  transact(ctx, () => {
    for (const { user, hash } of hashed) {
      ctx.db.run(
        'INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        user.id,
        user.username,
        user.displayName,
        user.role,
        hash,
        ctx.clock.now(),
      );
    }
  });
}

export function listUsers(ctx: AppContext): UserDTO[] {
  return ctx.db
    .all<UserRow>('SELECT id, username, display_name, role FROM users ORDER BY display_name, id')
    .map(toUserDTO);
}

/** Changes a user's role. Roles are read from the users table on every request, so this applies immediately. */
export function setUserRole(ctx: AppContext, actor: Actor, targetId: string, role: Role): UserDTO {
  return transact(ctx, (unit) => {
    const target = ctx.db.get<UserRow>(
      'SELECT id, username, display_name, role, password_hash FROM users WHERE id = ?',
      targetId,
    );
    if (!target) {
      throw new HttpError(404, 'not_found', `User ${targetId} not found`);
    }
    if (target.role === role) {
      return toUserDTO(target);
    }
    if (target.role === 'admin' && role !== 'admin') {
      const admins = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
      if ((admins?.n ?? 0) <= 1) {
        throw new HttpError(409, 'last_admin', 'The last admin cannot be demoted');
      }
    }

    ctx.db.run('UPDATE users SET role = ? WHERE id = ?', role, targetId);
    unit.audit({
      incidentId: null,
      actor,
      action: 'user.role_changed',
      before: { userId: targetId, role: target.role },
      after: { userId: targetId, role },
    });
    return toUserDTO({ ...target, role });
  });
}
