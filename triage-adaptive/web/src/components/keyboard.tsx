// The one global keydown handler (SPEC section 5). Installed once by the App.
import { getUrlState, navigate } from '../router';
import { session } from '../session';
import { store } from '../store';
import { toast } from '../toasts';
import { hasRole } from '../../../shared/rules';
import { READ_ONLY } from '../messages';
import { ackIncident, bulkAckSelected, canAct, openResolve } from './actions';
import { ui } from './ui';

function isTypingTarget(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function isSearchInput(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'search';
}

/**
 * The incident the keys act on: the active row (the highlighted cursor), the one target the user sees.
 * The drawer's incident is only a fallback when no row is active. An opened or moved drawer already makes
 * its incident the active row, so the two agree except after a Ctrl/Cmd-click, where the cursor wins.
 */
function currentId(): number | null {
  return ui.get().active ?? getUrlState().sel;
}

/** Moves the cursor one row. A landed cursor does not move on the next j. */
function moveActive(dir: 1 | -1): void {
  const order = store.getList().order;
  if (order.length === 0) return;
  ui.syncOrder(order);
  const s = ui.get();
  const idx = s.active === null ? -1 : order.indexOf(s.active);
  let target: number;
  if (idx < 0) target = dir > 0 ? 0 : order.length - 1;
  else if (dir > 0 && s.landed) target = idx;
  else target = Math.min(order.length - 1, Math.max(0, idx + dir));
  const id = order[target];
  ui.moveTo(id, target);
  if (getUrlState().sel !== null) navigate({ sel: String(id) }, 'replace');
}

function ackCurrent(): void {
  const id = currentId();
  if (id === null) return;
  const user = session.getState().user;
  const entry = store.getEntry(id);
  if (!user || !entry) return;
  if (!hasRole(user.role, 'responder')) {
    toast('info', READ_ONLY);
    return;
  }
  if (!canAct(entry.inc, 'ack', user.role)) return;
  void ackIncident(id);
}

function resolveCurrent(): void {
  const id = currentId();
  if (id === null) return;
  const user = session.getState().user;
  const entry = store.getEntry(id);
  if (!user || !entry) return;
  if (!hasRole(user.role, 'responder')) {
    toast('info', READ_ONLY);
    return;
  }
  if (!canAct(entry.inc, 'resolve', user.role)) return;
  openResolve(id);
}

function toggleCurrent(): void {
  const id = currentId();
  if (id !== null) ui.toggleSelected(id);
}

export function handleKeyDown(e: KeyboardEvent): void {
  if (session.getState().status !== 'authed') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;

  const target = e.target instanceof Element ? e.target : null;
  const listEl = document.getElementById('incidents');

  if (target !== null && isSearchInput(target) && e.key === 'Escape') {
    e.preventDefault();
    target.blur();
    listEl?.focus();
    return;
  }
  if (target !== null && isTypingTarget(target)) return;

  // Enter, Space and the arrows only act when the list or the page body has focus, never on buttons,
  // links, summaries or anything inside the drawer.
  const onList = target !== null && (target === listEl || target === document.body);

  // Shift+A is the bulk key. It is matched on the letter, not the reported key, so Caps Lock (which reports
  // a plain press as 'A') does not turn a plain a into a bulk ack.
  if (e.shiftKey && e.key.length === 1 && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    // Holding the key auto-repeats keydown. Only the first press counts.
    if (!e.repeat) void bulkAckSelected();
    return;
  }
  // Single letters match in lower case unless Shift is held, so Caps Lock does not break j, k, r, x or a.
  const key = e.key.length === 1 && !e.shiftKey ? e.key.toLowerCase() : e.key;

  switch (key) {
    case 'j':
      e.preventDefault();
      moveActive(1);
      return;
    case 'k':
      e.preventDefault();
      moveActive(-1);
      return;
    case 'ArrowDown':
      if (!onList) return;
      e.preventDefault();
      moveActive(1);
      return;
    case 'ArrowUp':
      if (!onList) return;
      e.preventDefault();
      moveActive(-1);
      return;
    case 'Enter': {
      if (!onList) return;
      const active = ui.get().active;
      if (active === null) return;
      e.preventDefault();
      navigate({ sel: String(active) }, 'push');
      return;
    }
    case ' ':
    case 'Spacebar':
      if (target !== listEl) return;
      e.preventDefault();
      if (ui.get().active !== null) ui.toggleSelected(ui.get().active as number);
      return;
    case 'a':
      e.preventDefault();
      if (!e.repeat) ackCurrent();
      return;
    case 'r':
      e.preventDefault();
      if (!e.repeat) resolveCurrent();
      return;
    case 'x':
      e.preventDefault();
      toggleCurrent();
      return;
    case '/': {
      const search = document.getElementById('incident-search');
      if (!(search instanceof HTMLInputElement)) return;
      e.preventDefault();
      search.focus();
      return;
    }
    case '?':
      ui.setShortcuts(true);
      return;
    case 'Escape': {
      if (getUrlState().sel !== null) {
        navigate({ sel: null }, 'replace');
        return;
      }
      ui.clearSelected();
      return;
    }
    default:
      return;
  }
}
