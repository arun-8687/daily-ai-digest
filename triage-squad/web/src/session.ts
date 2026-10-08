// Who is signed in, and the lifecycle that follows: the realtime stream runs only while authed.
import { useSyncExternalStore } from 'react';
import type { UserDTO } from '../../shared/types';
import { ApiError, api } from './api';
import { realtime } from './realtime';
import { store } from './store';
import { toast } from './toasts';

export interface SessionState {
  status: 'loading' | 'anon' | 'authed';
  user: UserDTO | null;
  users: UserDTO[];
}

type Listener = () => void;

/** Backoff for the startup check when the server cannot be reached. */
const INIT_RETRY_MIN_MS = 500;
const INIT_RETRY_MAX_MS = 5_000;

let state: SessionState = { status: 'loading', user: null, users: [] };
const listeners = new Set<Listener>();

function setState(next: SessionState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

async function fetchUsers(): Promise<UserDTO[]> {
  const body = await api<{ users: UserDTO[] }>('/api/users');
  return body.users;
}

function enterAuthed(user: UserDTO): void {
  setState({ status: 'authed', user, users: [] });
  realtime.start(() => session.expire());
  fetchUsers().then(
    (users) => {
      if (state.status === 'authed' && state.user?.id === user.id) setState({ ...state, users });
    },
    () => {
      // Without the user list the assignee select offers only "Anyone" and "Unassigned".
    },
  );
}

function leave(): void {
  realtime.stop();
  store.clear();
  setState({ status: 'anon', user: null, users: [] });
}

export const session = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): SessionState {
    return state;
  },

  /**
   * Asks the server who we are. Call once at startup. Only a 401 means signed out. Any other failure (network, 5xx)
   * keeps the state at loading and retries with a capped backoff, so a restarting server does not show the login form.
   */
  async init(): Promise<void> {
    let delay = INIT_RETRY_MIN_MS;
    for (;;) {
      let me: { user: UserDTO } | null = null;
      try {
        me = await api<{ user: UserDTO }>('/api/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setState({ status: 'anon', user: null, users: [] });
          return;
        }
      }
      if (me) {
        enterAuthed(me.user);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      // Someone signed in or out while we waited. Their state wins.
      if (state.status !== 'loading') return;
      delay = Math.min(INIT_RETRY_MAX_MS, delay * 2);
    }
  },

  /** Rejects with ApiError on bad credentials so the form can show the message. */
  async login(username: string, password: string): Promise<void> {
    const res = await api<{ user: UserDTO }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    store.clear();
    enterAuthed(res.user);
  },

  /** Signs out locally even when the request fails. */
  async logout(): Promise<void> {
    try {
      await api<void>('/api/auth/logout', { method: 'POST' });
    } catch {
      // The local session is dropped regardless.
    }
    leave();
  },

  /** The server no longer recognises the session. */
  expire(): void {
    const wasAuthed = state.status === 'authed';
    leave();
    if (wasAuthed) toast('info', 'Your session ended. Sign in again to keep following incidents.');
  },
};

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}
