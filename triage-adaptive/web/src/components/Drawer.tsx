import { useEffect, useRef, useState } from 'react';
import { api, ApiError, isAbortError } from '../api';
import { useServerNow } from '../clock';
import {
  auditActionLabel,
  auditChangeSummary,
  ago,
  incidentRef,
  slaLabel,
  userName,
} from '../format';
import { describeFailure, READ_ONLY } from '../messages';
import { navigate } from '../router';
import { useSession } from '../session';
import { store } from '../store';
import type { AlertDTO, AuditDTO, DetailResponse, IncidentDTO, UserDTO } from '../../../shared/types';
import { hasRole } from '../../../shared/rules';
import { SeverityBadge, StatusBadge } from './Badges';
import { assignIncident, ackIncident, canAct, openResolve, reopenIncident } from './actions';
import { useEntry } from './ui';

const DETAIL_DEBOUNCE_MS = 250;

function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function AlertItem({ alert }: { alert: AlertDTO }) {
  return (
    <li className="alert-item">
      <div className="alert-head">
        <strong>{alert.title}</strong>
        <span className="alert-source">{alert.source}</span>
      </div>
      <div className="alert-times">
        <time dateTime={isoOf(alert.ts)}>{`Event ${dateTime(alert.ts)}`}</time>
        <time dateTime={isoOf(alert.receivedAt)}>{`Received ${dateTime(alert.receivedAt)}`}</time>
      </div>
      <details>
        <summary>Payload</summary>
        <pre>{JSON.stringify(alert.payload, null, 2)}</pre>
      </details>
    </li>
  );
}

function AuditItem({ entry, users }: { entry: AuditDTO; users: readonly UserDTO[] }) {
  const summary = auditChangeSummary(entry, users);
  return (
    <li className="audit-item">
      <time dateTime={isoOf(entry.createdAt)}>{dateTime(entry.createdAt)}</time>
      <span className="audit-actor">{entry.actorName}</span>
      <span className="audit-action">{auditActionLabel(entry.action)}</span>
      {summary !== '' && <span className="audit-change">{summary}</span>}
    </li>
  );
}

interface Props {
  id: number;
}

/** The incident side panel. Opened by the URL's sel parameter. */
export function Drawer({ id }: Props) {
  const me = useSession();
  const users = me.users;
  const role = me.user?.role ?? 'viewer';
  const now = useServerNow();
  const entry = useEntry(id);
  const [detail, setDetail] = useState<{ id: number; data: DetailResponse } | null>(null);
  /** A load failure, tagged with the incident it belongs to, so it never shows on a different incident after j/k. */
  const [loadError, setLoadError] = useState<{ id: number; message: string } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const errorHere = loadError !== null && loadError.id === id ? loadError.message : null;

  // Focus moves into the drawer when it opens and back to the list when it closes.
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
    return () => {
      document.getElementById('incidents')?.focus({ preventScroll: true });
    };
  }, []);

  // Loads alerts and audit for this incident, seeds it into the store when it is not in the list,
  // and refetches (debounced) when the store reports a change to it.
  useEffect(() => {
    let cancelled = false;
    let ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = (): void => {
      ctrl.abort();
      ctrl = new AbortController();
      api<DetailResponse>(`/api/incidents/${id}`, { signal: ctrl.signal }).then(
        (data) => {
          if (cancelled) return;
          setDetail({ id, data });
          setLoadError(null);
          if (!store.getEntry(id)) store.seed(data.incident);
        },
        (err: unknown) => {
          if (cancelled || isAbortError(err)) return;
          setLoadError({
            id,
            message:
              err instanceof ApiError && err.status === 404
                ? 'This incident could not be found.'
                : describeFailure(err, `load ${incidentRef(id)}`, []),
          });
        },
      );
    };

    load();
    const off = store.onUpdate((updated) => {
      if (updated !== id && updated !== null) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        load();
      }, DETAIL_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      ctrl.abort();
      off();
    };
  }, [id]);

  const inc: IncidentDTO | undefined = entry?.inc ?? (detail?.id === id ? detail.data.incident : undefined);
  const alerts = detail?.id === id ? detail.data.alerts : null;
  const audit = detail?.id === id ? detail.data.audit : null;
  const ref = incidentRef(id);
  const canRespond = hasRole(role, 'responder');
  const close = (): void => navigate({ sel: null }, 'replace');

  const sla = inc ? slaLabel(inc, now) : null;
  const canAck = inc !== undefined && canAct(inc, 'ack', role);
  const canResolve = inc !== undefined && canAct(inc, 'resolve', role);
  const canReopen = inc !== undefined && canAct(inc, 'reopen', role);
  const canAssign = inc !== undefined && canAct(inc, 'assign', role);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="drawer"
      role="region"
      aria-label={inc ? `${ref}: ${inc.title}` : ref}
    >
      <header className="drawer-head">
        <div className="drawer-title">
          <p className="drawer-ref">{ref}</p>
          <h2>{inc ? inc.title : errorHere !== null ? 'Incident unavailable' : 'Loading…'}</h2>
        </div>
        <button type="button" className="drawer-close" onClick={close}>
          Close
        </button>
      </header>

      {errorHere !== null && (
        <p className="notice error" role="alert">
          {errorHere}
        </p>
      )}

      {inc && (
        <>
          <div className="badges">
            <SeverityBadge severity={inc.severity} />
            <StatusBadge status={inc.status} />
            {sla !== null && <span className={`sla${inc.slaBreachedAt !== null ? ' sla-breached' : ''}`}>{sla}</span>}
            {entry && entry.pending > 0 && <span className="saving">Saving…</span>}
          </div>

          {canRespond ? (
            <div className="actions">
              {canAck && (
                <button type="button" aria-keyshortcuts="a" onClick={() => void ackIncident(id)}>
                  Ack <kbd aria-hidden="true">a</kbd>
                </button>
              )}
              {canResolve && (
                <button type="button" aria-keyshortcuts="r" onClick={() => openResolve(id)}>
                  Resolve… <kbd aria-hidden="true">r</kbd>
                </button>
              )}
              {canReopen && (
                <button type="button" onClick={() => void reopenIncident(id)}>
                  Reopen
                </button>
              )}
            </div>
          ) : (
            <p className="readonly">{READ_ONLY}</p>
          )}

          <div className="assignee">
            {canAssign ? (
              <label className="field">
                <span>Assignee</span>
                <select
                  value={inc.assigneeId ?? ''}
                  onChange={(e) => void assignIncident(id, e.target.value === '' ? null : e.target.value)}
                >
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
                <span className="fact-label">Assignee</span> {userName(users, inc.assigneeId)}
              </p>
            )}
          </div>

          <dl className="facts">
            <div>
              <dt>First seen</dt>
              <dd>
                <time dateTime={isoOf(inc.firstSeen)}>{dateTime(inc.firstSeen)}</time>
              </dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>
                <time dateTime={isoOf(inc.lastSeen)}>{`${dateTime(inc.lastSeen)} (${ago(inc.lastSeen, now)})`}</time>
              </dd>
            </div>
            <div>
              <dt>Alerts</dt>
              <dd>{inc.alertCount}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{inc.source}</dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd>
                <code>{inc.fingerprint}</code>
              </dd>
            </div>
            <div>
              <dt>Acked</dt>
              <dd>
                {inc.ackedAt !== null
                  ? `${dateTime(inc.ackedAt)} by ${userName(users, inc.ackedBy)}`
                  : 'Not acked'}
              </dd>
            </div>
            <div>
              <dt>Resolved</dt>
              <dd>
                {inc.resolvedAt !== null
                  ? `${dateTime(inc.resolvedAt)} by ${userName(users, inc.resolvedBy)}`
                  : 'Not resolved'}
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{inc.version}</dd>
            </div>
          </dl>

          <section className="drawer-section" aria-labelledby="alerts-heading">
            <h3 id="alerts-heading">Alerts</h3>
            {alerts === null ? (
              <p className="muted">Loading alerts…</p>
            ) : alerts.length === 0 ? (
              <p className="muted">No alerts recorded.</p>
            ) : (
              <ol className="alert-list">
                {alerts.map((a) => (
                  <AlertItem key={a.id} alert={a} />
                ))}
              </ol>
            )}
          </section>

          <section className="drawer-section" aria-labelledby="audit-heading">
            <h3 id="audit-heading">Audit</h3>
            {audit === null ? (
              <p className="muted">Loading history…</p>
            ) : audit.length === 0 ? (
              <p className="muted">No changes recorded.</p>
            ) : (
              <ol className="timeline">
                {audit.map((a) => (
                  <AuditItem key={a.id} entry={a} users={users} />
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}

