// Incident detail side panel. Its selected id comes from the URL (?sel). It is keyed by id, so it remounts for each incident.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AuditDTO, DetailResponse, UserDTO } from '../../../shared/types';
import { hasRole } from '../../../shared/rules';
import { ApiError, api, isAbortError, messageOf } from '../api';
import { incidentRef, timeOfDay, userName } from '../format';
import { READ_ONLY } from '../messages';
import { store } from '../store';
import { SeverityBadge, SlaCountdown, StatusBadge } from './Badges';
import { ackIncident, assignIncident, reopenIncident } from './actions';

/** Live updates for this incident refresh the detail after this quiet period. */
const DETAIL_REFRESH_MS = 250;

const ACTION_LABEL: Record<string, string> = {
  'incident.created': 'Created',
  'incident.acked': 'Acknowledged',
  'incident.resolved': 'Resolved',
  'incident.reopened': 'Reopened',
  'incident.assigned': 'Assigned',
  'incident.escalated': 'Escalated',
  'incident.sla_breached': 'SLA breached',
  'alert.attached': 'Alert attached',
  'user.role_changed': 'Role changed',
  'auth.login': 'Signed in',
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function payloadText(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? 'null';
  } catch {
    return String(payload);
  }
}

/** The fields that changed in one audit entry, in words. Empty when nothing visible changed. */
function auditSummary(entry: AuditDTO, users: readonly UserDTO[]): string {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const parts: string[] = [];
  const changed = (key: string) => before[key] !== undefined && after[key] !== undefined && before[key] !== after[key];
  if (changed('status')) parts.push(`${String(before.status)} → ${String(after.status)}`);
  if (changed('severity')) parts.push(`severity ${String(before.severity)} → ${String(after.severity)}`);
  if (changed('assigneeId')) {
    const from = userName(users, (before.assigneeId as string | null) ?? null);
    const to = userName(users, (after.assigneeId as string | null) ?? null);
    parts.push(`assignee ${from} → ${to}`);
  }
  if (changed('alertCount')) parts.push(`alerts ${String(before.alertCount)} → ${String(after.alertCount)}`);
  if (changed('role')) parts.push(`role ${String(before.role)} → ${String(after.role)}`);
  return parts.join(', ');
}

export interface DrawerProps {
  id: number;
  user: UserDTO;
  users: readonly UserDTO[];
  onResolve: (id: number) => void;
  onClose: () => void;
}

export function Drawer({ id, user, users, onResolve, onClose }: DrawerProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const getEntry = useCallback(() => store.getEntry(id), [id]);
  const entry = useSyncExternalStore(store.subscribe, getEntry, getEntry);
  const inc = entry?.inc ?? detail?.incident ?? null;
  const pending = (entry?.pending ?? 0) > 0;
  const ref = incidentRef(id);
  const canChange = hasRole(user.role, 'responder');
  const editable = canChange && inc !== null && inc.status !== 'resolved';

  useEffect(() => {
    sectionRef.current?.focus();
  }, []);

  // Refetch the detail for this incident after live updates, debounced.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = store.onUpdate((changed) => {
      if (changed !== null && changed !== id) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setRefreshToken((n) => n + 1);
      }, DETAIL_REFRESH_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    api<DetailResponse>(`/api/incidents/${id}`, { signal: controller.signal }).then(
      (body) => {
        setDetail(body);
        setLoadError(null);
        // A deep-linked incident outside the list still needs a store entry for the actions.
        if (!store.getEntry(id)) store.seed(body.incident);
      },
      (err: unknown) => {
        if (isAbortError(err)) return;
        setLoadError(err instanceof ApiError && err.status === 404 ? `${ref} does not exist.` : messageOf(err));
      },
    );
    return () => controller.abort();
  }, [id, refreshToken, ref]);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      role="region"
      aria-label={inc ? `${ref}: ${inc.title}` : ref}
      className="drawer"
    >
      <header className="drawer-head">
        <div className="drawer-badges">
          <span className="row-ref">{ref}</span>
          {inc && <SeverityBadge severity={inc.severity} />}
          {inc && <StatusBadge status={inc.status} />}
          {inc && <SlaCountdown dueAt={inc.slaDueAt} breachedAt={inc.slaBreachedAt} />}
          {pending && <span className="saving">Saving…</span>}
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          Close <kbd aria-hidden="true">Esc</kbd>
        </button>
      </header>

      {/* A load error is announced once, in the alert below. The heading stays the incident reference. */}
      <h2 className="drawer-title">{inc?.title ?? (loadError ? ref : 'Loading…')}</h2>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}

      {inc && (
        <>
          <div className="drawer-actions">
            {canChange ? (
              <>
                {inc.status === 'open' && (
                  <button
                    type="button"
                    className="primary"
                    aria-keyshortcuts="a"
                    disabled={pending}
                    onClick={() => void ackIncident(id, user, users)}
                  >
                    Ack <kbd aria-hidden="true">a</kbd>
                  </button>
                )}
                {inc.status !== 'resolved' && (
                  <button
                    type="button"
                    aria-keyshortcuts="r"
                    disabled={pending}
                    onClick={() => onResolve(id)}
                  >
                    Resolve… <kbd aria-hidden="true">r</kbd>
                  </button>
                )}
                {inc.status === 'resolved' && (
                  <button type="button" disabled={pending} onClick={() => void reopenIncident(id, users)}>
                    Reopen
                  </button>
                )}
              </>
            ) : (
              <p className="notice">{READ_ONLY}</p>
            )}
          </div>

          <div className="field-row">
            {/* The label names the select only when there is one. Read-only assignees are plain text. */}
            <label htmlFor={editable ? 'drawer-assignee' : undefined}>Assignee</label>
            {editable ? (
              <select
                id="drawer-assignee"
                value={inc.assigneeId ?? ''}
                onChange={(e) => void assignIncident(id, e.target.value === '' ? null : e.target.value, users)}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
                {inc.assigneeId !== null && !users.some((u) => u.id === inc.assigneeId) && (
                  <option value={inc.assigneeId}>Unknown user</option>
                )}
              </select>
            ) : (
              <p>{userName(users, inc.assigneeId)}</p>
            )}
          </div>

          <dl className="facts">
            <div>
              <dt>First seen</dt>
              <dd>{dateTime(inc.firstSeen)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{dateTime(inc.lastSeen)}</dd>
            </div>
            <div>
              <dt>Alerts</dt>
              <dd>{inc.alertCount}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{inc.version}</dd>
            </div>
            <div>
              <dt>Acked</dt>
              <dd>
                {inc.ackedAt !== null ? `${dateTime(inc.ackedAt)} by ${userName(users, inc.ackedBy)}` : '—'}
              </dd>
            </div>
            <div>
              <dt>Resolved</dt>
              <dd>
                {inc.resolvedAt !== null ? `${dateTime(inc.resolvedAt)} by ${userName(users, inc.resolvedBy)}` : '—'}
              </dd>
            </div>
            <div className="fact-wide">
              <dt>Fingerprint</dt>
              <dd className="mono">{inc.fingerprint}</dd>
            </div>
          </dl>

          <section className="drawer-section" aria-labelledby="drawer-alerts-title">
            <h3 id="drawer-alerts-title">{`Alerts${detail ? ` (${detail.alerts.length})` : ''}`}</h3>
            {!detail ? (
              <p className="muted">Loading alerts…</p>
            ) : detail.alerts.length === 0 ? (
              <p className="muted">No alerts.</p>
            ) : (
              <ol className="alerts">
                {detail.alerts.map((alert) => (
                  <li key={alert.id}>
                    <div className="alert-title">{alert.title}</div>
                    <div className="muted">
                      {`${alert.source} · event ${dateTime(alert.ts)} · received ${dateTime(alert.receivedAt)}`}
                    </div>
                    <details>
                      <summary>Payload</summary>
                      <pre>{payloadText(alert.payload)}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="drawer-section" aria-labelledby="drawer-audit-title">
            <h3 id="drawer-audit-title">Activity</h3>
            {!detail ? (
              <p className="muted">Loading activity…</p>
            ) : detail.audit.length === 0 ? (
              <p className="muted">No activity yet.</p>
            ) : (
              <ol className="timeline">
                {detail.audit.map((entryItem) => {
                  const summary = auditSummary(entryItem, users);
                  return (
                    <li key={entryItem.id}>
                      <time dateTime={new Date(entryItem.createdAt).toISOString()}>
                        {timeOfDay(entryItem.createdAt)}
                      </time>
                      <span>{entryItem.actorName}</span>
                      <span>{actionLabel(entryItem.action)}</span>
                      {summary && <span className="muted">{summary}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}
