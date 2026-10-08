import { useEffect, useRef, useState } from 'react';
import { navigate, useUrlState } from '../router';
import { useSession } from '../session';
import { SEVERITY_LABEL, STATUS_LABEL } from '../format';
import { useList, useUi } from './ui';
import { clearFilters } from './actions';
import { SEVERITIES, STATUSES, type Severity, type Status } from '../../../shared/types';

const DEBOUNCE_MS = 300;
const MAX_Q = 200;

export function Filters() {
  const { filters } = useUrlState();
  const users = useSession().users;
  const list = useList();
  const resetTick = useUi((s) => s.filterReset);
  const urlQ = filters.q ?? '';

  const [draft, setDraft] = useState(urlQ);
  /** The query last seen in the URL or last pushed by this input. A change that differs is from history. */
  const lastSeen = useRef(urlQ);
  /** The reset counter this input last applied. Clear filters bumps it, so the draft empties even when the URL q did not change. */
  const seenReset = useRef(resetTick);

  // Clear filters empties the draft and cancels its pending push (the debounce effect below sees draft '' and clears its timer).
  useEffect(() => {
    if (seenReset.current === resetTick) return;
    seenReset.current = resetTick;
    lastSeen.current = '';
    setDraft('');
  }, [resetTick]);

  useEffect(() => {
    if (urlQ !== lastSeen.current) {
      lastSeen.current = urlQ;
      setDraft(urlQ);
    }
  }, [urlQ]);

  useEffect(() => {
    const want = draft.trim().slice(0, MAX_Q).trim();
    if (want === urlQ) return;
    const t = setTimeout(() => {
      lastSeen.current = want;
      navigate({ q: want || null }, 'push');
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, urlQ]);

  const total = list.total === null ? '…' : String(list.total);

  return (
    <form className="filters" role="search" aria-label="Incident filters" onSubmit={(e) => e.preventDefault()}>
      <label className="field search-field">
        <span>Search titles</span>
        <input
          id="incident-search"
          type="search"
          name="q"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_Q}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className="filter-row">
        <label className="field">
          <span>Status</span>
          <select
            value={filters.status ?? ''}
            onChange={(e) => navigate({ status: e.target.value || null }, 'push')}
          >
            <option value="">Any status</option>
            {STATUSES.map((s: Status) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Severity</span>
          <select
            value={filters.severity ?? ''}
            onChange={(e) => navigate({ severity: e.target.value || null }, 'push')}
          >
            <option value="">Any severity</option>
            {SEVERITIES.map((s: Severity) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Assignee</span>
          <select
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
          </select>
        </label>
        <button type="button" className="clear-filters" onClick={clearFilters}>
          Clear filters
        </button>
      </div>
      <p className="count" aria-live="polite">
        {`${total} matching · ${list.order.length} loaded`}
      </p>
    </form>
  );
}
