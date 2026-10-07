import { useSyncExternalStore } from 'react';

// The SLA countdown must follow server time, not the browser's clock, so a skewed laptop
// clock cannot show the wrong deadline. Each API response gives one estimate of the offset.
let offsetMs = 0;
let hasEstimate = false;

export function observeServerTime(serverTime: number, sentAt: number, receivedAt: number): void {
  // Assume the server stamped the response halfway through the round trip.
  const estimate = serverTime - (sentAt + receivedAt) / 2;
  // Smooth the estimates so one slow response does not make the countdown jump.
  offsetMs = hasEstimate ? offsetMs * 0.7 + estimate * 0.3 : estimate;
  hasEstimate = true;
}

export function serverNow(): number {
  return Date.now() + offsetMs;
}

// One shared one-second ticker. Components that display time subscribe to it and re-render on each tick.
let tick = Date.now();
let timer: number | undefined;
const tickListeners = new Set<() => void>();

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      tick = Date.now();
      for (const l of tickListeners) l();
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current server time, updated once a second. */
export function useServerNow(): number {
  useSyncExternalStore(subscribeTick, () => tick);
  return serverNow();
}
