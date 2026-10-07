import { useSyncExternalStore } from 'react';
import { realtime, type ConnStatus } from '../realtime';
import { countdown, SEVERITY_LABEL, STATUS_LABEL } from '../format';
import { useServerNow } from '../clock';
import type { IncidentDTO, Severity, Status } from '../../../shared/types';

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Counts down to the SLA deadline on server time, so it agrees with the server whatever the local clock says. */
export function SlaCountdown({ inc }: { inc: IncidentDTO }) {
  const now = useServerNow();
  if (inc.slaBreachedAt !== null) return <span className="sla sla-breached">SLA breached</span>;
  if (inc.slaDueAt === null) return null;
  const remaining = inc.slaDueAt - now;
  return (
    <span className={`sla${remaining < 60_000 ? ' sla-urgent' : ''}`} title="Time until the 5-minute SLA breach">
      SLA {countdown(remaining)}
    </span>
  );
}

const CONN_LABEL: Record<ConnStatus, { text: string; tone: 'ok' | 'warn' | 'bad' }> = {
  live: { text: 'Live', tone: 'ok' },
  connecting: { text: 'Connecting…', tone: 'warn' },
  reconnecting: { text: 'Reconnecting…', tone: 'warn' },
  offline: { text: 'Offline. Live updates are paused.', tone: 'bad' },
  'signed-out': { text: 'Signed out', tone: 'bad' },
};

export function ConnectionBadge() {
  const status = useSyncExternalStore(realtime.subscribe, realtime.getStatus);
  const { text, tone } = CONN_LABEL[status];
  return (
    <div className={`conn conn-${tone}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
