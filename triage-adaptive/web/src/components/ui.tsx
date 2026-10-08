// Client-only UI state (keyboard cursor, bulk selection, open dialogs) and small store hooks.
import { useSyncExternalStore } from 'react';
import { getUrlState, navigate } from '../router';
import { store, type Entry, type ListState } from '../store';

export interface ResolvePin {
  readonly id: number;
  /** The version the user saw when the dialog opened. Sent as If-Match. */
  readonly version: number;
}

export interface BulkFailure {
  readonly id: number;
  /** The sentence shown in the report. */
  readonly message: string;
}

export interface BulkReportState {
  readonly total: number;
  readonly ok: number;
  readonly failures: readonly BulkFailure[];
}

export interface UiState {
  /** Keyboard cursor: the id of the active row in the list. */
  readonly active: number | null;
  /** Last known position of the active row in the loaded order. */
  readonly hint: number;
  /**
   * The active row was just put in place of a row that left the list. The next j stays on it
   * instead of skipping past it.
   */
  readonly landed: boolean;
  /** The active row has been seen in the loaded order (so its departure is a real removal). */
  readonly activeListed: boolean;
  readonly selected: ReadonlySet<number>;
  readonly resolve: ResolvePin | null;
  readonly bulk: BulkReportState | null;
  readonly shortcuts: boolean;
  /** A bulk ack request is in flight. A second one is refused until it settles. */
  readonly bulkBusy: boolean;
  /** Bumped by Clear filters so the search draft in the Filters form is emptied as well. */
  readonly filterReset: number;
}

const EMPTY_SELECTION: ReadonlySet<number> = new Set();

const initial: UiState = {
  active: null,
  hint: 0,
  landed: false,
  activeListed: false,
  selected: EMPTY_SELECTION,
  resolve: null,
  bulk: null,
  shortcuts: false,
  bulkBusy: false,
  filterReset: 0,
};

let state: UiState = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

function subscribeUi(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const ui = {
  get(): UiState {
    return state;
  },

  /** Makes id the keyboard cursor. pos is its index in the loaded order, or -1 when not listed. */
  activate(id: number, pos: number): void {
    set({ active: id, hint: pos >= 0 ? pos : state.hint, landed: false, activeListed: pos >= 0 });
  },

  /**
   * Keeps the cursor on a real row. When the active row leaves the loaded order, the row now at its
   * position takes its place and the next j lands on it.
   */
  syncOrder(order: readonly number[]): void {
    const a = state.active;
    if (a === null) return;
    const i = order.indexOf(a);
    if (i >= 0) {
      if (i !== state.hint || !state.activeListed) set({ hint: i, activeListed: true });
      return;
    }
    if (!state.activeListed) return;
    if (order.length === 0) {
      set({ active: null, hint: 0, landed: false, activeListed: false });
      return;
    }
    const pos = Math.min(state.hint, order.length - 1);
    const next = order[pos];
    set({ active: next, hint: pos, landed: true, activeListed: true });
    // The open drawer follows the cursor, so the keys and the drawer always name the same incident.
    if (getUrlState().sel === a) navigate({ sel: String(next) }, 'replace');
  },

  /** Moves the cursor within the list. A landed cursor stays put on the next j. */
  moveTo(id: number, pos: number): void {
    set({ active: id, hint: pos, landed: false, activeListed: true });
  },

  toggleSelected(id: number): void {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: next });
  },

  setSelected(ids: Iterable<number>): void {
    set({ selected: new Set(ids) });
  },

  clearSelected(): void {
    if (state.selected.size === 0) return;
    set({ selected: EMPTY_SELECTION });
  },

  openResolve(pin: ResolvePin): void {
    set({ resolve: pin });
  },

  closeResolve(): void {
    if (state.resolve !== null) set({ resolve: null });
  },

  setBulk(bulk: BulkReportState | null): void {
    set({ bulk });
  },

  setShortcuts(open: boolean): void {
    if (state.shortcuts !== open) set({ shortcuts: open });
  },

  setBulkBusy(busy: boolean): void {
    if (state.bulkBusy !== busy) set({ bulkBusy: busy });
  },

  resetFilterDraft(): void {
    set({ filterReset: state.filterReset + 1 });
  },

  /** Clears everything (sign-out). */
  reset(): void {
    state = initial;
    for (const l of [...listeners]) l();
  },
};

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(subscribeUi, () => select(state), () => select(state));
}

export function useList(): ListState {
  return useSyncExternalStore(store.subscribe, store.getList, store.getList);
}

export function useEntry(id: number): Entry | undefined {
  const get = (): Entry | undefined => store.getEntry(id);
  return useSyncExternalStore(store.subscribe, get, get);
}
