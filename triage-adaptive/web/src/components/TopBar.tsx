import { useSyncExternalStore } from 'react';
import { realtime, type ConnStatus } from '../realtime';
import { session, useSession } from '../session';
import type { Role } from '../../../shared/types';

const CONN_LABEL: Record<ConnStatus, string> = {
  live: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline. Live updates are paused.',
  'signed-out': 'Signed out',
};

const ROLE_LABEL: Record<Role, string> = { viewer: 'Viewer', responder: 'Responder', admin: 'Admin' };

export function TopBar() {
  const conn = useSyncExternalStore(realtime.subscribe, realtime.getStatus, realtime.getStatus);
  const user = useSession().user;
  return (
    <header className="topbar">
      <h1>Triage</h1>
      <div className="conn" role="status" data-state={conn}>
        {CONN_LABEL[conn]}
      </div>
      {user && (
        <div className="who">
          <span className="who-name">{user.displayName}</span>
          <span className="who-role">{ROLE_LABEL[user.role]}</span>
          <button type="button" onClick={() => void session.logout()}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
