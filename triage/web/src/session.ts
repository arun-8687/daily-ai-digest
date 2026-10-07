import { useSyncExternalStore } from 'react';
import { api } from './api';
import { realtime } from './realtime';
import { store } from './store';
import type { UserDTO } from '../../shared/types';

export interface SessionState {
  status: 'loading' | 'anon' | 'authed';
  user: UserDTO | null;
  users: UserDTO[];
}

class SessionStore {
  private state: SessionState = { status: 'loading', user: null, users: [] };
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Runs once on page load. Restores an existing session cookie, if there is one. */
  async init(): Promise<void> {
    try {
      const { user } = await api<{ user: UserDTO }>('/api/auth/me');
      await this.enter(user);
    } catch {
      this.set({ status: 'anon', user: null, users: [] });
    }
  }

  async login(username: string, password: string): Promise<void> {
    const { user } = await api<{ user: UserDTO }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    await this.enter(user);
  }

  private async enter(user: UserDTO): Promise<void> {
    const { users } = await api<{ users: UserDTO[] }>('/api/users');
    this.set({ status: 'authed', user, users });
    realtime.start(() => this.expire());
  }

  async logout(): Promise<void> {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* the cookie is cleared on the next successful request anyway */
    }
    this.expire();
  }

  expire(): void {
    realtime.stop();
    store.clear();
    this.set({ status: 'anon', user: null, users: [] });
  }
}

export const session = new SessionStore();

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}

