import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'success' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let nextId = 1;
let items: Toast[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toast(kind: ToastKind, message: string): void {
  const id = nextId++;
  items = [...items.slice(-3), { id, kind, message }];
  emit();
  window.setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 5000);
}

export function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => items);
}
