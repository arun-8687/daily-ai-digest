// Filters and the open drawer live in the URL, so back and forward restore them.
import { useMemo, useSyncExternalStore } from 'react';
import type { Filters } from '../../shared/rules';
import { SEVERITIES, STATUSES, type Severity, type Status } from '../../shared/types';

export interface UrlState {
  filters: Filters;
  sel: number | null;
}

const NAV_EVENT = 'triage:navigate';

export function parseSearch(search: string): UrlState {
  const p = new URLSearchParams(search);
  const status = p.get('status');
  const severity = p.get('severity');
  const sel = Number(p.get('sel'));
  const q = p.get('q')?.trim() ?? '';
  return {
    filters: {
      status: (STATUSES as readonly string[]).includes(status ?? '') ? (status as Status) : undefined,
      severity: (SEVERITIES as readonly string[]).includes(severity ?? '') ? (severity as Severity) : undefined,
      assignee: p.get('assignee') || undefined,
      q: q || undefined,
    },
    sel: Number.isInteger(sel) && sel > 0 ? sel : null,
  };
}

/** Writes a change to the address bar. `push` adds a history entry, so back returns to the previous view. */
export function navigate(patch: Record<string, string | null>, mode: 'push' | 'replace'): void {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') p.delete(k);
    else p.set(k, v);
  }
  const query = p.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  window.dispatchEvent(new Event(NAV_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAV_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

export function useUrlState(): UrlState {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return useMemo(() => parseSearch(search), [search]);
}
