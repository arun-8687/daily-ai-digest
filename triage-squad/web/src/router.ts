// URL state: ?status&severity&assignee&q&sel. The URL is the source of truth for filters and the selected incident.
import { useSyncExternalStore } from 'react';
import { SEVERITIES, STATUSES, type Severity, type Status } from '../../shared/types';
import type { Filters } from '../../shared/rules';

export interface UrlState {
  filters: Filters;
  sel: number | null;
}

const MAX_Q = 200;

export function parseSearch(search: string): UrlState {
  const params = new URLSearchParams(search);
  const filters: Filters = {};

  const status = params.get('status');
  if (status && (STATUSES as readonly string[]).includes(status)) filters.status = status as Status;

  const severity = params.get('severity');
  if (severity && (SEVERITIES as readonly string[]).includes(severity)) filters.severity = severity as Severity;

  const assignee = params.get('assignee')?.trim();
  if (assignee) filters.assignee = assignee;

  const q = params.get('q')?.trim();
  if (q) filters.q = q.slice(0, MAX_Q);

  const selRaw = params.get('sel');
  const sel = selRaw !== null && /^\d+$/.test(selRaw) ? Number(selRaw) : NaN;
  return { filters, sel: Number.isSafeInteger(sel) && sel > 0 ? sel : null };
}

const routeListeners = new Set<() => void>();

function notifyRoute(): void {
  for (const listener of [...routeListeners]) listener();
}

/** Writes the URL. Empty or null values remove the parameter. Same-URL writes are skipped. */
export function navigate(patch: Record<string, string | null>, mode: 'push' | 'replace'): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (url === current) return;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  notifyRoute();
}

function subscribeRoute(listener: () => void): () => void {
  if (routeListeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('popstate', notifyRoute);
  }
  routeListeners.add(listener);
  return () => {
    routeListeners.delete(listener);
    if (routeListeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('popstate', notifyRoute);
    }
  };
}

let cachedSearch: string | null = null;
let cachedState: UrlState = parseSearch('');

/** Same search string gives the same object, so useSyncExternalStore does not re-render needlessly. */
function getUrlSnapshot(): UrlState {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  if (search !== cachedSearch) {
    cachedSearch = search;
    cachedState = parseSearch(search);
  }
  return cachedState;
}

export function useUrlState(): UrlState {
  return useSyncExternalStore(subscribeRoute, getUrlSnapshot, getUrlSnapshot);
}
