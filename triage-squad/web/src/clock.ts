// Server-time estimate for countdowns. Samples come from JSON bodies that carry serverTime (see api.ts).
// Nothing here touches window or document, so the module is safe to import under node.
import { useSyncExternalStore } from 'react';

const SMOOTHING = 0.2;
/** Samples with a longer round trip than this are ignored once we have one. */
const MAX_RTT_FOR_UPDATE_MS = 30_000;

let offset = 0;
let samples = 0;

/**
 * Feed one server timestamp. The server's clock is assumed to have read `serverTime` at the midpoint
 * of the request, so the sample is serverTime minus the local midpoint. Samples are smoothed.
 */
export function observeServerTime(serverTime: number, sentAt: number, receivedAt: number): void {
  if (!Number.isFinite(serverTime) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return;
  const rtt = Math.max(0, receivedAt - sentAt);
  if (samples > 0 && rtt > MAX_RTT_FOR_UPDATE_MS) return;
  const sample = serverTime - (sentAt + rtt / 2);
  offset = samples === 0 ? sample : offset + (sample - offset) * SMOOTHING;
  samples += 1;
}

/** Best estimate of the server's current time in epoch milliseconds. */
export function serverNow(): number {
  return Date.now() + offset;
}

// One shared ticker for every component that asks for the time. It only starts while someone is subscribed.
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickNow = serverNow();

function tick(): void {
  tickNow = serverNow();
  for (const listener of [...tickListeners]) listener();
}

function subscribeTick(listener: () => void): () => void {
  if (tickListeners.size === 0) {
    tickNow = serverNow();
    tickTimer = setInterval(tick, 1000);
  }
  tickListeners.add(listener);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

function getTick(): number {
  return tickNow;
}

/** Server-corrected "now" that re-renders about once per second. Shares one interval across all callers. */
export function useServerNow(): number {
  return useSyncExternalStore(subscribeTick, getTick, getTick);
}
