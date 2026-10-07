import type { Role, UserDTO } from '../../shared/types';
import { writeAudit, type Actor } from './audit';
import { transact, type AppContext } from './context';
import { HttpError } from './errors';
import { hashPassword } from './passwords';

export const DEMO_PASSWORD = 'triage-demo';

/** The three seeded accounts: one per role. */
export const DEMO_USERS: { id: string; username: string; displayName: string; role: Role }[] = [
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

export function toUserDTO(r: UserRow): UserDTO {
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role };
}

export function findUserRowByUsername(ctx: AppContext, username: string): UserRow | undefined {
  return ctx.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
}

export function findUserById(ctx: AppContext, id: string): UserDTO | null {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  return row ? toUserDTO(row) : null;
}

export function listUsers(ctx: AppContext): UserDTO[] {
  return ctx.db.all<UserRow>('SELECT * FROM users ORDER BY display_name').map(toUserDTO);
}

/** Creates the demo accounts if they do not exist yet. Safe to call on every start. */
export async function ensureDemoUsers(ctx: AppContext, password: string = DEMO_PASSWORD): Promise<void> {
  for (const u of DEMO_USERS) {
    if (ctx.db.get('SELECT 1 FROM users WHERE id = ?', u.id)) continue;
    ctx.db.run(
      'INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      u.id,
      u.username,
      u.displayName,
      u.role,
      await hashPassword(password),
      ctx.clock.now(),
    );
  }
}

/** Admin-only. Keeps at least one admin, and every change is audited. */
export function setUserRole(ctx: AppContext, actor: Actor, targetId: string, role: Role): UserDTO {
  return transact(ctx, () => {
    const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', targetId);
    if (!row) throw new HttpError(404, 'not_found', 'No such user');
    if (row.role === role) return toUserDTO(row);
    if (row.role === 'admin') {
      const admins = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'") as { n: number };
      if (admins.n <= 1) throw new HttpError(409, 'last_admin', 'At least one admin must remain');
    }
    ctx.db.run('UPDATE users SET role = ? WHERE id = ?', role, targetId);
    writeAudit(ctx, {
      incidentId: null,
      actor,
      action: 'user.role_changed',
      before: { userId: row.id, role: row.role },
      after: { userId: row.id, role },
    });
    return toUserDTO({ ...row, role });
  });
}
