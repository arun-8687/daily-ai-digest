// Transient messages. Errors stay longer. Module scope touches no DOM globals.
import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const MAX_TOASTS = 5;
const INFO_MS = 5_000;
const ERROR_MS = 9_000;

let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export function dismiss(id: number): void {
  clearTimer(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function toast(kind: ToastKind, message: string): void {
  const id = nextId++;
  const next = [...toasts, { id, kind, message }];
  while (next.length > MAX_TOASTS) {
    const dropped = next.shift();
    if (dropped) clearTimer(dropped.id);
  }
  toasts = next;
  timers.set(id, setTimeout(() => dismiss(id), kind === 'error' ? ERROR_MS : INFO_MS));
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Toast[] {
  return toasts;
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
