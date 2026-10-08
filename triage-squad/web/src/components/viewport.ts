// Whether the drawer is a full-screen sheet. At this width the content behind it must be inert, or Tab reaches it.
import { useSyncExternalStore } from 'react';

/** Keep in step with the drawer breakpoint in styles.css. */
const SHEET_QUERY = '(max-width: 900px)';

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(SHEET_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function snapshot(): boolean {
  return window.matchMedia(SHEET_QUERY).matches;
}

export function useSheetViewport(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
