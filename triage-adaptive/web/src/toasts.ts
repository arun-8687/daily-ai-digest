import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const AUTO_DISMISS_MS = 5_000;
const ERROR_DISMISS_MS = 9_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getToasts(): Toast[] {
  return toasts;
}

/** Shows a toast. Errors stay for 9s, other kinds for 5s. */
export function toast(kind: ToastKind, message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  timers.set(
    id,
    setTimeout(() => dismiss(id), kind === 'error' ? ERROR_DISMISS_MS : AUTO_DISMISS_MS),
  );
  emit();
}

export function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getToasts, getToasts);
}

/** The current toasts, read without a hook (for tests and non-React callers). */
export function currentToasts(): readonly Toast[] {
  return toasts;
}
