import { useSyncExternalStore } from 'react';

/** Smoothed estimate of (server clock - local clock) in ms. */
let offset = 0;
let hasSample = false;

const TICK_MS = 1000;
const tickListeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
let tickSnapshot: number | null = null;
let snapshotAt = 0;

/**
 * Feeds one sample. The server stamped serverTime somewhere between sentAt and receivedAt (local ms).
 * The sample is the midpoint estimate; slow round trips move the estimate less.
 */
export function observeServerTime(serverTime: number, sentAt: number, receivedAt: number): void {
  if (!Number.isFinite(serverTime) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return;
  const rtt = Math.max(0, receivedAt - sentAt);
  const sample = serverTime - (sentAt + receivedAt) / 2;
  if (!hasSample) {
    offset = sample;
    hasSample = true;
    return;
  }
  const alpha = rtt > 2000 ? 0.1 : 0.3;
  offset += alpha * (sample - offset);
}

export function serverNow(): number {
  return Date.now() + offset;
}

function refreshSnapshot(): number {
  tickSnapshot = serverNow();
  snapshotAt = Date.now();
  return tickSnapshot;
}

function tick(): void {
  refreshSnapshot();
  for (const l of [...tickListeners]) l();
}

function subscribeTick(l: () => void): () => void {
  tickListeners.add(l);
  if (ticker === null) ticker = setInterval(tick, TICK_MS);
  return () => {
    tickListeners.delete(l);
    if (tickListeners.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/**
 * Cached per second. Without a running ticker the value is still refreshed once it is a second old,
 * so a component that mounts after the last ticker stopped never renders with an old time.
 * Repeated calls within the same second return the same number, as useSyncExternalStore requires.
 */
function getTickSnapshot(): number {
  if (tickSnapshot === null || Date.now() - snapshotAt >= TICK_MS) return refreshSnapshot();
  return tickSnapshot;
}

/** Server time in ms, re-rendering once per second through one shared ticker. */
export function useServerNow(): number {
  return useSyncExternalStore(subscribeTick, getTickSnapshot, getTickSnapshot);
}
