import { useMemo, useSyncExternalStore } from 'react';
import { SEVERITIES, STATUSES, type Severity, type Status } from '../../shared/types';
import type { Filters } from '../../shared/rules';

/** URL state: ?status&severity&assignee&q&sel */
export interface UrlState {
  filters: Filters;
  /** Selected (drawer) incident id, or null. */
  sel: number | null;
}

const MAX_Q = 200;
const MAX_ASSIGNEE = 100;

type Listener = () => void;
const listeners = new Set<Listener>();

function isStatus(v: string | null): v is Status {
  return v !== null && (STATUSES as readonly string[]).includes(v);
}

function isSeverity(v: string | null): v is Severity {
  return v !== null && (SEVERITIES as readonly string[]).includes(v);
}

/** Parses a location search string. Unknown or invalid values are dropped. */
export function parseSearch(search: string): UrlState {
  const p = new URLSearchParams(search);
  const filters: Filters = {};
  const status = p.get('status');
  if (isStatus(status)) filters.status = status;
  const severity = p.get('severity');
  if (isSeverity(severity)) filters.severity = severity;
  const assignee = (p.get('assignee') ?? '').trim();
  if (assignee && assignee.length <= MAX_ASSIGNEE) filters.assignee = assignee;
  const q = (p.get('q') ?? '').trim().slice(0, MAX_Q).trim();
  if (q) filters.q = q;
  const selRaw = p.get('sel');
  const sel = selRaw !== null && /^[1-9]\d{0,14}$/.test(selRaw) ? Number(selRaw) : null;
  return { filters, sel };
}

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

function notify(): void {
  for (const l of [...listeners]) l();
}

/** Subscribes to URL changes (navigate and popstate). Stable identity. */
export function subscribeUrl(l: Listener): () => void {
  listeners.add(l);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('popstate', notify);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('popstate', notify);
  };
}

/** Parsed URL state, read without a hook (for event handlers). */
export function getUrlState(): UrlState {
  return parseSearch(currentSearch());
}

/**
 * Merges a patch into the query string and pushes or replaces history. A null or empty value removes the key.
 * Subscribers are notified after the change.
 */
export function navigate(patch: Record<string, string | null>, mode: 'push' | 'replace'): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash, } = window.location;
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  // Compare canonical query strings: the raw search may differ only in encoding (%20 vs +) or not at all.
  if (qs === new URLSearchParams(search).toString()) return;
  const url = `${pathname}${qs ? `?${qs}` : ''}${hash}`;
  if (mode === 'push') window.history.pushState(window.history.state, '', url);
  else window.history.replaceState(window.history.state, '', url);
  notify();
}

/** Current URL state, re-rendering when the URL changes. */
export function useUrlState(): UrlState {
  const search = useSyncExternalStore(subscribeUrl, currentSearch, currentSearch);
  return useMemo(() => parseSearch(search), [search]);
}
