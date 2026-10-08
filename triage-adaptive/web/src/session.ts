import { useSyncExternalStore } from 'react';
import { api, ApiError, messageOf } from './api';
import { store } from './store';
import { realtime } from './realtime';
import { toast } from './toasts';
import type { UserDTO } from '../../shared/types';

export interface SessionState {
  status: 'loading' | 'anon' | 'authed';
  user: UserDTO | null;
  users: UserDTO[];
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: SessionState = { status: 'loading', user: null, users: [] };

function setState(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getState(): SessionState {
  return state;
}

/** Loads the user list for the assignee picker. Failures are not fatal. */
async function loadUsers(): Promise<void> {
  try {
    const res = await api<{ users: UserDTO[] }>('/api/users');
    if (state.status !== 'authed') return;
    const me = state.user ? res.users.find((u) => u.id === state.user?.id) : undefined;
    setState({ users: res.users, user: me ?? state.user });
  } catch {
    // The assignee picker falls back to showing ids.
  }
}

const INIT_RETRY_MIN_MS = 1_000;
const INIT_RETRY_MAX_MS = 30_000;
let initTimer: ReturnType<typeof setTimeout> | null = null;
let initBackoffMs = INIT_RETRY_MIN_MS;
/** A failed check was reported and retries are running. The error toast is shown once per streak. */
let initFailing = false;

/** Stops any pending session check retry. Called whenever the session is set by something else. */
function cancelInitRetry(): void {
  if (initTimer !== null) {
    clearTimeout(initTimer);
    initTimer = null;
  }
  initBackoffMs = INIT_RETRY_MIN_MS;
  initFailing = false;
}

/**
 * One session check. 401 means signed out. Any other failure (network, 5xx, bad response) is not a
 * sign-out: the state stays 'loading' and the check is retried with backoff, so a valid session is
 * not mistaken for a logged-out one.
 */
async function checkSession(): Promise<void> {
  try {
    const me = await api<{ user: UserDTO }>('/api/auth/me');
    cancelInitRetry();
    setState({ status: 'authed', user: me.user });
    await loadUsers();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      cancelInitRetry();
      setState({ status: 'anon', user: null, users: [] });
      return;
    }
    if (!initFailing) {
      initFailing = true;
      toast('error', `Couldn't check your session: ${messageOf(err)} Retrying.`);
    }
    const delay = initBackoffMs;
    initBackoffMs = Math.min(initBackoffMs * 2, INIT_RETRY_MAX_MS);
    initTimer = setTimeout(() => {
      initTimer = null;
      if (state.status === 'loading') void checkSession();
    }, delay);
  }
}

async function init(): Promise<void> {
  cancelInitRetry();
  await checkSession();
}

async function login(username: string, password: string): Promise<void> {
  cancelInitRetry();
  const res = await api<{ user: UserDTO }>('/api/auth/login', { method: 'POST', body: { username, password } });
  store.clear();
  setState({ status: 'authed', user: res.user, users: [] });
  await loadUsers();
}

/**
 * Signs out here either way. If the server could not end the session (other than because it had
 * already ended), the user is told: the cookie stays valid until it expires and a reload signs in again.
 */
async function logout(): Promise<void> {
  cancelInitRetry();
  let sessionEnded = true;
  try {
    await api<void>('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    sessionEnded = err instanceof ApiError && err.status === 401;
  }
  realtime.stop();
  store.clear();
  setState({ status: 'anon', user: null, users: [] });
  if (!sessionEnded) {
    toast(
      'error',
      'Signed out on this device, but the server could not end your session. Sign out again when you are back online. Until then the session stays valid.',
    );
  }
}

/** The session ended on the server (for example, the stream found a 401). */
function expire(): void {
  cancelInitRetry();
  realtime.stop();
  store.clear();
  setState({ status: 'anon', user: null, users: [] });
}

/** Reloads the user list (and this user's role) after an admin change. */
async function refreshUsers(): Promise<void> {
  await loadUsers();
}

export const session = { subscribe, getState, init, login, logout, expire, refreshUsers };

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, getState, getState);
}
