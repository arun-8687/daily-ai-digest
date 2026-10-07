import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AlertDTO, AuditDTO, DetailResponse, UserDTO } from '../../../shared/types';
import { api, ApiError, isAbortError, messageOf } from '../api';
import { describeChange, incidentRef, timeOfDay, userName } from '../format';
import { READ_ONLY } from '../messages';
import { store } from '../store';
import { SeverityBadge, SlaCountdown, StatusBadge } from './Badges';

const ACTION_LABEL: Record<string, string> = {
  'incident.created': 'created the incident from an alert',
  'incident.acked': 'acked',
  'incident.resolved': 'resolved',
  'incident.reopened': 'reopened',
  'incident.assigned': 'changed the assignee',
  'incident.escalated': 'raised the severity',
  'incident.sla_breached': 'breached the SLA (no ack within 5 minutes)',
  'alert.attached': 'attached a late alert',
  'user.role_changed': 'changed a user role',
  'auth.login': 'signed in',
};

function fullTime(ms: number): string {
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
}

interface Props {
  id: number;
  me: UserDTO;
  users: UserDTO[];
  canRespond: boolean;
  onClose: () => void;
  onAck: (id: number) => void;
  onResolve: (id: number) => void;
  onReopen: (id: number) => void;
  onAssign: (id: number, assigneeId: string | null) => void;
}

export function Drawer({ id, users, canRespond, onClose, onAck, onResolve, onReopen, onAssign }: Props) {
  const entry = useSyncExternalStore(store.subscribe, () => store.getEntry(id));
  const [detail, setDetail] = useState<{ alerts: AlertDTO[]; audit: AuditDTO[] } | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reloadTimer = useRef<number | undefined>(undefined);

  // Move focus into the drawer on open. On close, return it to the list (see the cleanup below).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    return () => document.getElementById('incidents')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoadState('loading');
    api<DetailResponse>(`/api/incidents/${id}`, { signal: controller.signal })
      .then((d) => {
        if (cancelled) return;
        store.seed(d.incident);
        setDetail({ alerts: d.alerts, audit: d.audit });
        setLoadState('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 404) setLoadState('missing');
        else {
          setLoadError(messageOf(err));
          setLoadState('error');
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, reloadKey]);

  // Live updates to this incident refresh the alerts and audit trail (debounced).
  useEffect(
    () =>
      store.onUpdate((updatedId) => {
        if (updatedId !== null && updatedId !== id) return;
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(() => setReloadKey((k) => k + 1), 250);
      }),
    [id],
  );
  useEffect(() => () => window.clearTimeout(reloadTimer.current), []);

  const inc = entry?.inc;
  if (!inc) {
    return (
      <section className="drawer" role="region" aria-label={incidentRef(id)}>
        <h2 id="drawer-title" ref={headingRef} tabIndex={-1}>
          {incidentRef(id)}
        </h2>
        {loadState === 'missing' && <p>This incident does not exist.</p>}
        {loadState === 'error' && (
          <p role="alert" className="error-text">
            Couldn't load this incident: {loadError}
          </p>
        )}
        {loadState === 'loading' && <p role="status">Loading…</p>}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </section>
    );
  }

  const pending = entry?.pending ?? 0;
  const actionable = canRespond && inc.status !== 'resolved';

  return (
    <section className="drawer" role="region" aria-label={`${incidentRef(inc.id)}: ${inc.title}`}>
      <header className="drawer-head">
        <div className="drawer-title-block">
          <p className="eyebrow">
            {incidentRef(inc.id)} · {inc.source}
          </p>
          <h2 id="drawer-title" ref={headingRef} tabIndex={-1}>
            {inc.title}
          </h2>
          <div className="row-top">
            <SeverityBadge severity={inc.severity} />
            <StatusBadge status={inc.status} />
            <SlaCountdown inc={inc} />
            {pending > 0 && <span className="saving">Saving…</span>}
          </div>
        </div>
        <button type="button" className="ghost icon" onClick={onClose} aria-label="Close incident details">
          ✕
        </button>
      </header>

      <div className="actions" role="group" aria-label="Incident actions">
        {canRespond && inc.status === 'open' && (
          <button type="button" className="primary" aria-keyshortcuts="a" onClick={() => onAck(inc.id)}>
            Ack <kbd aria-hidden="true">a</kbd>
          </button>
        )}
        {actionable && (
          <button type="button" aria-keyshortcuts="r" onClick={() => onResolve(inc.id)}>
            Resolve… <kbd aria-hidden="true">r</kbd>
          </button>
        )}
        {canRespond && inc.status === 'resolved' && (
          <button type="button" onClick={() => onReopen(inc.id)}>
            Reopen
          </button>
        )}
        {!canRespond && <p className="muted">{READ_ONLY}</p>}
      </div>

      {actionable ? (
        <label className="field">
          <span>Assignee</span>
          <select value={inc.assigneeId ?? ''} onChange={(e) => onAssign(inc.id, e.target.value || null)}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>
          <strong>Assignee:</strong> {userName(users, inc.assigneeId)}
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>First seen</dt>
          <dd>{fullTime(inc.firstSeen)}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{fullTime(inc.lastSeen)}</dd>
        </div>
        <div>
          <dt>Alerts</dt>
          <dd>{inc.alertCount}</dd>
        </div>
        <div>
          <dt>Fingerprint</dt>
          <dd>
            <code>{inc.fingerprint}</code>
          </dd>
        </div>
        {inc.ackedAt !== null && (
          <div>
            <dt>Acked</dt>
            <dd>
              {userName(users, inc.ackedBy)} · {fullTime(inc.ackedAt)}
            </dd>
          </div>
        )}
        {inc.resolvedAt !== null && (
          <div>
            <dt>Resolved</dt>
            <dd>
              {userName(users, inc.resolvedBy)} · {fullTime(inc.resolvedAt)}
            </dd>
          </div>
        )}
        <div>
          <dt>Version</dt>
          <dd>{inc.version}</dd>
        </div>
      </dl>

      {loadState === 'error' && (
        <p role="alert" className="error-text">
          Couldn't refresh details: {loadError}
        </p>
      )}

      <section aria-labelledby="alerts-title">
        <h3 id="alerts-title">Alerts</h3>
        {!detail && <p className="muted">Loading alerts…</p>}
        {detail && detail.alerts.length === 0 && <p className="muted">No alerts.</p>}
        {detail && detail.alerts.length > 0 && (
          <ol className="alerts">
            {detail.alerts.map((a) => (
              <li key={a.id} className="alert-item">
                <div className="alert-head">
                  <SeverityBadge severity={a.severity} />
                  <strong>{a.title}</strong>
                </div>
                <p className="muted small">
                  {a.source} · event {timeOfDay(a.ts)} · received {timeOfDay(a.receivedAt)}
                </p>
                <details>
                  <summary>Payload</summary>
                  <pre>{JSON.stringify(a.payload, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="timeline-title">
        <h3 id="timeline-title">Audit timeline</h3>
        {!detail && <p className="muted">Loading history…</p>}
        {detail && (
          <ol className="timeline">
            {detail.audit.map((a) => (
              <li key={a.id}>
                <time dateTime={new Date(a.createdAt).toISOString()}>{fullTime(a.createdAt)}</time>
                <p>
                  <strong>{a.actorName}</strong> {ACTION_LABEL[a.action] ?? a.action}
                  {(a.before || a.after) && <span className="muted"> · {describeChange(a.before, a.after)}</span>}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

