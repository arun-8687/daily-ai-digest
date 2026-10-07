import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { hasRole } from '../../../shared/rules';
import { SEVERITIES, STATUSES, type BulkAckResult, type IncidentDTO, type Severity, type Status, type UserDTO } from '../../../shared/types';
import { api } from '../api';
import { READ_ONLY } from '../messages';
import { describeFailure } from '../messages';
import { incidentRef, SEVERITY_LABEL, STATUS_LABEL, userName } from '../format';
import { navigate, useUrlState } from '../router';
import { session, useSession } from '../session';
import { store } from '../store';
import { toast } from '../toasts';
import { ConnectionBadge } from './Badges';
import { BulkReportDialog, ShortcutsDialog } from './Dialogs';
import { Drawer } from './Drawer';
import { IncidentList, type IncidentListHandle } from './IncidentList';
import { ResolveDialog } from './ResolveDialog';
import { Toasts } from './Toasts';

interface BulkReport {
  total: number;
  results: BulkAckResult[];
}

export function Board() {
  const { filters, sel } = useUrlState();
  const { user, users } = useSession();
  const me = user as UserDTO;
  const canRespond = hasRole(me.role, 'responder');
  const list = useSyncExternalStore(store.subscribe, store.getList);

  const [localActive, setLocalActive] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [resolveTarget, setResolveTarget] = useState<{ id: number; version: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [bulkReport, setBulkReport] = useState<BulkReport | null>(null);
  const [searchDraft, setSearchDraft] = useState(filters.q ?? '');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<IncidentListHandle>(null);
  const active = sel ?? localActive;
  const activeIdx = active === null ? -1 : list.order.indexOf(active);
  const lastActiveIdx = useRef(0);
  useEffect(() => {
    if (activeIdx !== -1) lastActiveIdx.current = activeIdx;
  }, [activeIdx]);

  const filterKey = [filters.status ?? '', filters.severity ?? '', filters.assignee ?? '', filters.q ?? ''].join('|');
  useEffect(() => {
    store.setFilters(filters);
    // Only the key matters: a new object with the same values must not reload the list.
  }, [filterKey]);

  // The search box follows the URL, so back and forward keep it in step.
  useEffect(() => {
    setSearchDraft(filters.q ?? '');
  }, [filters.q]);

  // Typing updates the URL after a pause, not on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = searchDraft.trim();
      if (next !== (filters.q ?? '')) navigate({ q: next || null }, 'push');
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchDraft, filters.q]);

  // ---- actions -----------------------------------------------------------------

  async function ack(id: number) {
    if (!canRespond) return toast('error', READ_ONLY);
    const entry = store.getEntry(id);
    if (!entry) return;
    if (entry.inc.status !== 'open') return toast('info', `${incidentRef(id)} is already ${STATUS_LABEL[entry.inc.status].toLowerCase()}.`);
    try {
      await store.mutate(id, { status: 'acked', ackedBy: me.id, ackedAt: Date.now() }, (version) =>
        api<IncidentDTO>(`/api/incidents/${id}/ack`, { method: 'POST', ifMatch: version }),
      );
      toast('success', `${incidentRef(id)} acked.`);
    } catch (err) {
      toast('error', describeFailure(err, `ack ${incidentRef(id)}`, users));
    }
  }

  function openResolve(id: number) {
    if (!canRespond) return toast('error', READ_ONLY);
    const entry = store.getEntry(id);
    if (!entry) return;
    if (entry.inc.status === 'resolved') return toast('info', `${incidentRef(id)} is already resolved.`);
    // Pin the version the reviewer saw. The server rejects the resolve if it has moved on since.
    setResolveTarget({ id, version: entry.inc.version });
  }

  async function reopen(id: number) {
    if (!canRespond) return toast('error', READ_ONLY);
    try {
      await store.mutate(id, { status: 'open', resolvedBy: null, resolvedAt: null, ackedBy: null, ackedAt: null }, (version) =>
        api<IncidentDTO>(`/api/incidents/${id}/reopen`, { method: 'POST', ifMatch: version }),
      );
      toast('success', `${incidentRef(id)} reopened.`);
    } catch (err) {
      toast('error', describeFailure(err, `reopen ${incidentRef(id)}`, users));
    }
  }

  async function assign(id: number, assigneeId: string | null) {
    if (!canRespond) return toast('error', READ_ONLY);
    try {
      await store.mutate(id, { assigneeId }, (version) =>
        api<IncidentDTO>(`/api/incidents/${id}`, { method: 'PATCH', body: { assigneeId }, ifMatch: version }),
      );
      toast('success', assigneeId ? `${incidentRef(id)} assigned to ${userName(users, assigneeId)}.` : `${incidentRef(id)} unassigned.`);
    } catch (err) {
      toast('error', describeFailure(err, `reassign ${incidentRef(id)}`, users));
    }
  }

  async function bulkAck() {
    if (!canRespond) return toast('error', READ_ONLY);
    const ids = [...selected];
    if (ids.length === 0) return toast('info', 'Nothing selected. Select incidents with x or Space first.');
    try {
      const results = await store.bulkAck(ids, { id: me.id, displayName: me.displayName });
      // Keep the failures selected, so Shift+A retries just those.
      setSelected(new Set(results.filter((r) => !r.ok).map((r) => r.id)));
      setBulkReport({ total: ids.length, results });
    } catch (err) {
      toast('error', describeFailure(err, 'ack the selected incidents', users));
    }
  }

  // ---- selection and keyboard -----------------------------------------------------

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllOpen() {
    setSelected(new Set(list.order.filter((id) => store.getEntry(id)?.inc.status === 'open')));
  }

  function moveActive(delta: number) {
    const order = list.order;
    if (order.length === 0) return;
    // If the active row has left the list (for example, it was acked while the list shows open
    // incidents), step from where it was, so j lands on the row that took its place.
    let base: number;
    if (activeIdx !== -1) base = activeIdx;
    else if (active === null) base = delta > 0 ? -1 : order.length;
    else base = delta > 0 ? lastActiveIdx.current - 1 : lastActiveIdx.current;
    const nextIdx = Math.min(order.length - 1, Math.max(0, base + delta));
    const nextId = order[nextIdx];
    if (sel !== null) navigate({ sel: String(nextId) }, 'replace');
    else setLocalActive(nextId);
    listRef.current?.scrollToIndex(nextIdx);
  }

  function clickRow(id: number, mods: { toggle: boolean; range: boolean }) {
    if (mods.toggle) {
      toggle(id);
      setLocalActive(id);
      return;
    }
    setLocalActive(id);
    navigate({ sel: String(id) }, 'push');
  }

  const keyHandler = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const target = e.target as HTMLElement | null;
    if (target === searchRef.current && e.key === 'Escape') {
      // Escape leaves the search box and hands the keyboard back to the list.
      searchRef.current?.blur();
      document.getElementById('incidents')?.focus();
      return;
    }
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter':
        if (active !== null) {
          e.preventDefault();
          navigate({ sel: String(active) }, 'push');
        }
        break;
      case 'Escape':
        if (sel !== null) navigate({ sel: null }, 'replace');
        else if (selected.size > 0) setSelected(new Set());
        break;
      case 'a':
        if (active !== null) void ack(active);
        break;
      case 'r':
        if (active !== null) openResolve(active);
        break;
      case 'x':
      case ' ':
        if (active !== null) {
          e.preventDefault();
          toggle(active);
        }
        break;
      case 'A':
        if (e.shiftKey) {
          e.preventDefault();
          void bulkAck();
        }
        break;
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        break;
      case '?':
        e.preventDefault();
        setShortcutsOpen(true);
        break;
    }
  };
  // The listener is registered once, and always calls the handler from the latest render.
  const keyHandlerRef = useRef(keyHandler);
  useEffect(() => {
    keyHandlerRef.current = keyHandler;
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // ---- filters ---------------------------------------------------------------------

  const hasFilters = Boolean(filters.status || filters.severity || filters.assignee || filters.q);
  const clearFilters = () => navigate({ status: null, severity: null, assignee: null, q: null }, 'push');
  const onSelect = (key: 'status' | 'severity' | 'assignee') => (e: ChangeEvent<HTMLSelectElement>) =>
    navigate({ [key]: e.target.value || null }, 'push');

  const countText =
    list.total === null
      ? `${list.order.length.toLocaleString()} loaded`
      : `${list.total.toLocaleString()} matching · ${list.order.length.toLocaleString()} loaded`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">▲</span>
          <h1>Triage</h1>
        </div>
        <ConnectionBadge />
        <div className="me">
          <span className="me-name">{me.displayName}</span>
          <span className={`role role-${me.role}`}>{me.role}</span>
          <button type="button" className="ghost" onClick={() => void session.logout()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="board" aria-labelledby="incidents-title">
          <div className="toolbar">
            <h2 id="incidents-title" className="visually-hidden">
              Incidents
            </h2>
            <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
              <label className="field grow">
                <span>Search titles</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={searchDraft}
                  maxLength={200}
                  placeholder="Press / to search"
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Status</span>
                <select value={filters.status ?? ''} onChange={onSelect('status')}>
                  <option value="">All</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s as Status]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Severity</span>
                <select value={filters.severity ?? ''} onChange={onSelect('severity')}>
                  <option value="">All</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {SEVERITY_LABEL[s as Severity]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Assignee</span>
                <select value={filters.assignee ?? ''} onChange={onSelect('assignee')}>
                  <option value="">Anyone</option>
                  <option value="none">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}
                    </option>
                  ))}
                </select>
              </label>
              {hasFilters && (
                <button type="button" className="ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </form>

            <div className="listbar">
              <p className="count" aria-live="polite">
                {countText}
              </p>
              <div className="bulk" role="group" aria-label="Selection">
                {selected.size > 0 ? (
                  <>
                    <span>{selected.size} selected</span>
                    <button type="button" className="primary" disabled={!canRespond} onClick={() => void bulkAck()}>
                      Ack selected <kbd>⇧A</kbd>
                    </button>
                    <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
                      Clear
                    </button>
                  </>
                ) : (
                  list.order.length > 0 && (
                    <button type="button" className="ghost" disabled={!canRespond} onClick={selectAllOpen}>
                      Select open
                    </button>
                  )
                )}
              </div>
            </div>
          </div>

          <IncidentList
            ref={listRef}
            order={list.order}
            status={list.status}
            error={list.error}
            loadingMore={list.loadingMore}
            hasFilters={hasFilters}
            active={active}
            selected={selected}
            onRowClick={clickRow}
            onNeedMore={() => store.loadMore()}
            onRetry={() => store.retry()}
            onClearFilters={clearFilters}
          />
        </section>

        {sel !== null && (
          <Drawer
            id={sel}
            me={me}
            users={users}
            canRespond={canRespond}
            onClose={() => navigate({ sel: null }, 'replace')}
            onAck={(id) => void ack(id)}
            onResolve={openResolve}
            onReopen={(id) => void reopen(id)}
            onAssign={(id, assigneeId) => void assign(id, assigneeId)}
          />
        )}
      </div>

      <ResolveDialog target={resolveTarget} me={me} users={users} onDone={() => setResolveTarget(null)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <BulkReportDialog report={bulkReport} users={users} onClose={() => setBulkReport(null)} />
      <Toasts />
    </div>
  );
}


