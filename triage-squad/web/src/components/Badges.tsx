// Small status displays. The SLA countdown uses server time and re-renders about once a second through the shared ticker.
import { useSyncExternalStore } from 'react';
import type { Severity, Status } from '../../../shared/types';
import { useServerNow } from '../clock';
import { countdown, SEVERITY_LABEL, STATUS_LABEL } from '../format';
import { realtime, type ConnStatus } from '../realtime';

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Final minute of the SLA window gets an urgent style. */
const URGENT_MS = 60_000;

export function SlaCountdown({ dueAt, breachedAt }: { dueAt: number | null; breachedAt: number | null }) {
  if (breachedAt !== null) return <span className="badge sla sla-breached">SLA breached</span>;
  if (dueAt === null) return null;
  return <LiveCountdown dueAt={dueAt} />;
}

function LiveCountdown({ dueAt }: { dueAt: number }) {
  const now = useServerNow();
  const remaining = dueAt - now;
  const cls = remaining <= URGENT_MS ? 'badge sla sla-urgent' : 'badge sla';
  return <span className={cls}>{`SLA ${countdown(remaining)}`}</span>;
}

const CONN_TEXT: Record<ConnStatus, string> = {
  live: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline. Live updates are paused.',
  'signed-out': 'Signed out',
};

export function ConnectionBadge() {
  const status = useSyncExternalStore(realtime.subscribe, realtime.getStatus, realtime.getStatus);
  return (
    <span className={`conn conn-${status}`} role="status" data-state={status}>
      <span className="dot" aria-hidden="true" />
      {CONN_TEXT[status]}
    </span>
  );
}
