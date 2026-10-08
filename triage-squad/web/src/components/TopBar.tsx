// Page header: product name, live connection state, the signed-in user and sign out.
import type { UserDTO } from '../../../shared/types';
import { session } from '../session';
import { ConnectionBadge } from './Badges';

export function TopBar({ user, inert }: { user: UserDTO; inert?: boolean }) {
  return (
    <header className="topbar" inert={inert}>
      <div className="brand">
        <h1>Triage</h1>
        <ConnectionBadge />
      </div>
      <div className="who">
        <span className="name">{user.displayName}</span>
        <span className="role-chip">{user.role}</span>
        <button type="button" onClick={() => void session.logout()}>
          Sign out
        </button>
      </div>
    </header>
  );
}
