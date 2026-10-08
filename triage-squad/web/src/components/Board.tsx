// The incident board: URL-bound filters, the list, the drawer, bulk selection and the keyboard map (SPEC section 5).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { STATUSES, SEVERITIES, type BulkAckResult, type UserDTO } from '../../../shared/types';
import { hasRole } from '../../../shared/rules';
import { incidentRef, SEVERITY_LABEL, STATUS_LABEL } from '../format';
import { READ_ONLY, describeFailure } from '../messages';
import { navigate, parseSearch, useUrlState } from '../router';
import { store } from '../store';
import { toast } from '../toasts';
import { Drawer } from './Drawer';
import { IncidentList } from './IncidentList';
import { BulkReportDialog, ShortcutsDialog, type BulkReport } from './Dialogs';
import { ResolveDialog, type ResolveTarget } from './ResolveDialog';
import { ackIncident } from './actions';
import { useSheetViewport } from './viewport';

/** Typing pause before the search text is written to the URL. */
const SEARCH_DEBOUNCE_MS = 300;

/** True for fields where letter keys belong to the user. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

export interface BoardProps {
  user: UserDTO;
  users: UserDTO[];
}

export function Board({ user, users }: BoardProps) {
  const url = useUrlState();
  const { filters, sel } = url;
  const list = useSyncExternalStore(store.subscribe, store.getList, store.getList);
  const order = list.order;
  const canChange = hasRole(user.role, 'responder');
  const hasFilters = Object.keys(filters).length > 0;
  /** A full-screen drawer covers the board, so the content behind it is inert while it is open. */
  const sheet = useSheetViewport() && sel !== null;
  const filterKey = JSON.stringify([filters.status ?? '', filters.severity ?? '', filters.assignee ?? '', filters.q ?? '']);

  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [activeId, setActiveId] = useState<number | null>(null);
  const [resolveTarget, setResolveTarget] = useState<ResolveTarget | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [report, setReport] = useState<BulkReport | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [qDraft, setQDraft] = useState(filters.q ?? '');

  const searchRef = useRef<HTMLInputElement>(null);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Position of the active row the last time it was in the list. Used when it leaves the list. */
  const lastPos = useRef(0);
  const busyRef = useRef(false);
  const prevSel = useRef<number | null>(sel);
  const handleKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);

  // Filters are the URL. Any change (typing, select, Back/Forward) reloads the first page and clears the selection.
  useEffect(() => {
    store.setFilters(filters);
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
    // filterKey is the dependency. The filters object for it is the one from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // A selected row that leaves the list (acked under an Open filter, say) is no longer visible, so it is dropped.
  useEffect(() => {
    const live = new Set(order);
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [order]);

  // The search box follows the URL unless the typed text already means the same thing.
  useEffect(() => {
    setQDraft((prev) => ((prev.trim() === (filters.q ?? '').trim() ? prev : (filters.q ?? ''))));
  }, [filters.q]);

  useEffect(
    () => () => {
      if (qTimer.current !== null) clearTimeout(qTimer.current);
    },
    [],
  );

  // The drawer follows the URL, so a deep link (?sel=) makes its row the active one.
  useEffect(() => {
    if (sel !== null) setActiveId(sel);
  }, [sel]);

  useEffect(() => {
    if (activeId === null) return;
    const pos = order.indexOf(activeId);
    if (pos !== -1) lastPos.current = pos;
  }, [order, activeId]);

  // Closing the drawer returns focus to the list, unless the user has moved focus somewhere else.
  useEffect(() => {
    const was = prevSel.current;
    prevSel.current = sel;
    if (was !== null && sel === null) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        const listbox = document.getElementById('incidents');
        if (listbox && !listbox.hidden) listbox.focus();
        else searchRef.current?.focus();
      }
    }
  }, [sel]);

  // Back and Forward move the URL under a pending search. The typed text is dropped, so the timer cannot push over them.
  useEffect(() => {
    const onPop = () => {
      if (qTimer.current !== null) {
        clearTimeout(qTimer.current);
        qTimer.current = null;
      }
      setQDraft(parseSearch(window.location.search).filters.q ?? '');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The resolve dialog hands focus back to the Resolve button it was opened from. After a resolve that button is gone,
  // so focus would fall to the page. Put it on the drawer instead.
  const resolveOpen = resolveTarget !== null;
  const wasResolveOpen = useRef(false);
  useEffect(() => {
    const was = wasResolveOpen.current;
    wasResolveOpen.current = resolveOpen;
    if (!was || resolveOpen) return;
    const active = document.activeElement;
    if (sel !== null && (!active || active === document.body)) {
      document.querySelector<HTMLElement>('.drawer')?.focus();
    }
  }, [resolveOpen, sel]);

  // SLA breaches are errors the responder should see wherever they are on the board.
  useEffect(
    () =>
      store.onUpdate((id, type) => {
        if (type !== 'incident.sla_breached' || id === null) return;
        const inc = store.getEntry(id)?.inc;
        toast('error', `SLA breached: ${incidentRef(id)}${inc ? ` ${inc.title}` : ''}`);
      }),
    [],
  );

  const openIncident = useCallback((id: number) => navigate({ sel: String(id) }, 'push'), []);
  const closeDrawer = useCallback(() => navigate({ sel: null }, 'push'), []);
  const toggleSelected = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const activate = useCallback((id: number) => setActiveId(id), []);
  const closeResolve = useCallback(() => setResolveTarget(null), []);

  /** The active row, but only while it is still in the list. */
  function activeRow(): number | null {
    return activeId !== null && order.includes(activeId) ? activeId : null;
  }

  function moveActive(delta: 1 | -1): void {
    if (order.length === 0) return;
    const last = order.length - 1;
    const clamp = (n: number) => Math.min(last, Math.max(0, n));
    let next: number;
    if (activeId === null) {
      next = delta > 0 ? order[0] : order[last];
    } else {
      const pos = order.indexOf(activeId);
      if (pos === -1) {
        // The active row left the list. The row that took its place sits at the old position.
        const base = clamp(lastPos.current);
        next = delta > 0 ? order[base] : order[clamp(base - 1)];
      } else {
        next = order[clamp(pos + delta)];
      }
    }
    setActiveId(next);
  }

  function openResolve(id: number): void {
    if (!canChange) {
      toast('info', READ_ONLY);
      return;
    }
    const entry = store.getEntry(id);
    // A change still in flight may move the version, so the dialog waits for it to settle.
    if (!entry || entry.inc.status === 'resolved' || entry.pending > 0) return;
    setResolveTarget({ id, version: entry.inc.version });
  }

  async function runBulkAck(): Promise<void> {
    if (!canChange) {
      toast('info', READ_ONLY);
      return;
    }
    if (selected.size === 0) {
      toast('info', 'Select incidents with x, then press Shift+A.');
      return;
    }
    if (busyRef.current) return;
    const ids = [...selected].filter((id) => store.getEntry(id) !== undefined);
    if (ids.length === 0) return;
    busyRef.current = true;
    setBulkBusy(true);
    let results: BulkAckResult[];
    try {
      results = await store.bulkAck(ids, { id: user.id, displayName: user.displayName });
    } catch (err) {
      toast('error', describeFailure(err, 'ack the selected incidents', users));
      return;
    } finally {
      busyRef.current = false;
      setBulkBusy(false);
    }
    const failed = results.filter((r) => !r.ok);
    // Failed items stay selected while they are still in the list. One that has left it (acked by someone else) is not.
    const visible = new Set(store.getList().order);
    setSelected(new Set(failed.map((r) => r.id).filter((id) => visible.has(id))));
    setReport({ acked: results.length - failed.length, total: results.length, failures: failed });
  }

  function selectOpen(): void {
    const ids = order.filter((id) => store.getEntry(id)?.inc.status === 'open');
    if (ids.length === 0) {
      toast('info', 'No open incidents are loaded.');
      return;
    }
    setSelected((prev) => new Set([...prev, ...ids]));
  }

  // Keyboard map. Registered once. The handler reads the latest render through handleKeyRef.
  function handleKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (isTextEntry(e.target)) return;

    const listbox = document.getElementById('incidents');
    const target = e.target;
    // Enter and arrows belong to the list only when focus is on the listbox or the page itself.
    // Buttons, links, summaries and anything inside the drawer keep their own key behaviour.
    const onList = target === listbox || target === document.body;
    // Focus inside the drawer makes a and r act on the incident the drawer shows, not on the list's active row.
    const inDrawer = target instanceof Element && target.closest('.drawer') !== null;
    const key = e.key;

    if (e.repeat && key !== 'j' && key !== 'k' && key !== 'ArrowDown' && key !== 'ArrowUp') return;

    if (key === 'j' || (key === 'ArrowDown' && onList)) {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (key === 'k' || (key === 'ArrowUp' && onList)) {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (key === 'Enter') {
      if (!onList) return;
      const id = activeRow();
      if (id !== null) {
        e.preventDefault();
        openIncident(id);
      }
      return;
    }
    if (key === ' ') {
      if (target !== listbox) return;
      const id = activeRow();
      if (id !== null) {
        e.preventDefault();
        toggleSelected(id);
      }
      return;
    }
    if (key === 'x') {
      const id = activeRow();
      if (id !== null) toggleSelected(id);
      return;
    }
    if (key === 'a' || key === 'A') {
      // Shift+A acks every selected incident. Without Shift, a letter acks one row. Caps Lock sends 'A' without Shift.
      if (e.shiftKey) {
        void runBulkAck();
        return;
      }
      const id = inDrawer ? sel : activeRow();
      if (id === null) return;
      // A row with a change in flight is not acked again. Its version is about to move, so a second ack would conflict.
      const entry = store.getEntry(id);
      if (!entry || entry.inc.status !== 'open' || entry.pending > 0) return;
      if (!canChange) {
        toast('info', READ_ONLY);
        return;
      }
      void ackIncident(id, user, users);
      return;
    }
    if (key === 'r') {
      const id = inDrawer ? sel : (activeRow() ?? sel);
      if (id !== null) openResolve(id);
      return;
    }
    if (key === '/') {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (key === '?') {
      e.preventDefault();
      setShortcutsOpen(true);
      return;
    }
    if (key === 'Escape') {
      if (sel !== null) closeDrawer();
      else if (selected.size > 0) setSelected(new Set());
    }
  }

  useEffect(() => {
    handleKeyRef.current = handleKey;
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handleKeyRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // Search box.
  function commitQuery(value: string): void {
    navigate({ q: value.trim() === '' ? null : value }, 'push');
  }

  function onSearchChange(value: string): void {
    setQDraft(value);
    if (qTimer.current !== null) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      qTimer.current = null;
      commitQuery(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // The listbox is hidden while it is empty. Focus then stays in the search box, rather than being lost to the page.
    const listbox = document.getElementById('incidents');
    if (listbox && !listbox.hidden) {
      e.currentTarget.blur();
      listbox.focus();
    }
  }

  function onFormSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (qTimer.current !== null) {
      clearTimeout(qTimer.current);
      qTimer.current = null;
    }
    commitQuery(qDraft);
  }

  function clearFilters(): void {
    if (qTimer.current !== null) {
      clearTimeout(qTimer.current);
      qTimer.current = null;
    }
    setQDraft('');
    navigate({ status: null, severity: null, assignee: null, q: null }, 'push');
  }

  const countText = `${list.total === null ? '…' : list.total.toLocaleString()} matching · ${order.length.toLocaleString()} loaded`;
  const knownAssignee = filters.assignee && filters.assignee !== 'none' && !users.some((u) => u.id === filters.assignee);

  return (
    <main className="board" id="main">
      <form role="search" className="filters" onSubmit={onFormSubmit} aria-label="Filter incidents" inert={sheet}>
        <div className="field field-search">
          <label htmlFor="flt-q">Search titles</label>
          <input
            id="flt-q"
            ref={searchRef}
            type="search"
            value={qDraft}
            autoComplete="off"
            spellCheck={false}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>
        <div className="field">
          <label htmlFor="flt-status">Status</label>
          <select
            id="flt-status"
            value={filters.status ?? ''}
            onChange={(e) => navigate({ status: e.target.value || null }, 'push')}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="flt-severity">Severity</label>
          <select
            id="flt-severity"
            value={filters.severity ?? ''}
            onChange={(e) => navigate({ severity: e.target.value || null }, 'push')}
          >
            <option value="">Any severity</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="flt-assignee">Assignee</label>
          <select
            id="flt-assignee"
            value={filters.assignee ?? ''}
            onChange={(e) => navigate({ assignee: e.target.value || null }, 'push')}
          >
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
            {knownAssignee && <option value={filters.assignee}>Unknown user</option>}
          </select>
        </div>
        <button type="button" className="ghost" onClick={clearFilters}>
          Clear filters
        </button>
      </form>

      <div className="toolbar" inert={sheet}>
        <p className="count" aria-live="polite">
          {countText}
        </p>
        <div className="selection-bar" role="group" aria-label="Bulk selection">
          <span className="sel-count">{`${selected.size} selected`}</span>
          {canChange && (
            <button
              type="button"
              className="primary"
              onClick={() => void runBulkAck()}
              disabled={bulkBusy || selected.size === 0}
            >
              Ack selected <kbd aria-hidden="true">Shift+A</kbd>
            </button>
          )}
          <button type="button" onClick={selectOpen}>
            Select open
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Clear
          </button>
        </div>
      </div>

      <div className={`workspace${sel !== null ? ' has-drawer' : ''}`}>
        <div className="list-pane" inert={sheet}>
          <IncidentList
            order={order}
            status={list.status}
            error={list.error}
            loadingMore={list.loadingMore}
            nextCursor={list.nextCursor}
            hasFilters={hasFilters}
            activeId={activeId}
            selected={selected}
            users={users}
            onOpen={openIncident}
            onToggle={toggleSelected}
            onActivate={activate}
            onClearFilters={clearFilters}
          />
        </div>
        {sel !== null && (
          <Drawer key={sel} id={sel} user={user} users={users} onResolve={openResolve} onClose={closeDrawer} />
        )}
      </div>

      <ResolveDialog target={resolveTarget} user={user} users={users} onClose={closeResolve} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <BulkReportDialog report={report} users={users} onClose={() => setReport(null)} />
    </main>
  );
}
