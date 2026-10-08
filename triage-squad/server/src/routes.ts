// Every endpoint in SPEC section 2. Each handler checks auth and role before it reads the body or touches data.
// Check order for mutations (D5): auth (401/403), exists (404), If-Match presence and syntax (428/400), then version
// and legality (409) inside applyAction. A missing incident is 404 even without If-Match.
import type { IncomingMessage } from 'node:http';
import { hasRole, type Action } from '../../shared/rules';
import {
  ROLES,
  SEVERITIES,
  STATUSES,
  type BulkAckItem,
  type Role,
  type Severity,
  type Status,
} from '../../shared/types';
import { auditFeed, type Actor } from './audit';
import { findSession, login, revokeSession, sessionCookie, clearSessionCookie, SESSION_COOKIE, type AuthSession } from './auth';
import type { AppContext } from './context';
import { HttpError } from './errors';
import { etagOf, readCookie, readJsonBody, requireIfMatch, Router, sendJson, sendNoContent, type RouteContext } from './http';
import { parseAlert, ingestAlert } from './ingest';
import { applyAction, bulkAck, getIncidentDetail, listIncidents } from './incidents';
import { openStream } from './sse';
import { listUsers, setUserRole } from './users';
import { constantTimeEqual } from './util';

const MAX_TITLE_QUERY = 200;

function authorize(ctx: AppContext, req: IncomingMessage, role: Role): AuthSession {
  const session = findSession(ctx, readCookie(req.headers.cookie, SESSION_COOKIE));
  if (session === null) {
    throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  }
  if (!hasRole(session.user.role, role)) {
    throw new HttpError(403, 'forbidden', `This action needs the ${role} role`);
  }
  return session;
}

function actorOf(session: AuthSession): Actor {
  return { id: session.user.id, name: session.user.displayName };
}

function requireIngestToken(ctx: AppContext, req: IncomingMessage): void {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const presented = match?.[1] ?? '';
  if (presented === '' || !constantTimeEqual(presented, ctx.config.ingestToken)) {
    throw new HttpError(401, 'bad_ingest_token', 'Missing or invalid ingest token');
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'validation_failed', `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Path ids that are not positive integers cannot name an incident, so they are 404. */
function parseId(raw: string, noun = 'Incident'): number {
  const id = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    throw new HttpError(404, 'not_found', `${noun} ${raw} not found`);
  }
  return id;
}

/** Mutations look the incident up before they look at If-Match (D5 order). Incidents are never deleted, so this holds. */
function requireExistingIncident(ctx: AppContext, id: number): void {
  const row = ctx.db.get<{ id: number }>('SELECT id FROM incidents WHERE id = ?', id);
  if (row === undefined) {
    throw new HttpError(404, 'not_found', `Incident ${id} not found`);
  }
}

function queryValue(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new HttpError(400, 'validation_failed', `${name} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
}

function parseCursor(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HttpError(400, 'bad_cursor', `${name} must be a non-negative integer`);
  }
  return Number(raw);
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= 200)) {
    throw new HttpError(400, 'bad_limit', 'limit must be an integer from 1 to 200');
  }
  return limit;
}

function parseBulkItems(raw: unknown): BulkAckItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) {
    throw new HttpError(400, 'validation_failed', 'items must be an array of 1 to 500 entries');
  }
  const problems: string[] = [];
  const items: BulkAckItem[] = [];
  raw.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`items[${index}] must be an object`);
      return;
    }
    const { id, version } = entry as Record<string, unknown>;
    const idOk = typeof id === 'number' && Number.isSafeInteger(id) && id >= 1;
    const versionOk = typeof version === 'number' && Number.isSafeInteger(version) && version >= 0;
    if (!idOk) problems.push(`items[${index}].id must be a positive integer`);
    if (!versionOk) problems.push(`items[${index}].version must be a non-negative integer`);
    if (idOk && versionOk) items.push({ id: id as number, version: version as number });
  });
  if (problems.length > 0) {
    throw new HttpError(400, 'validation_failed', `Invalid bulk ack: ${problems.join('; ')}`);
  }
  return items;
}

const ACTIONS: ReadonlyArray<{ path: string; action: Exclude<Action, 'assign'> }> = [
  { path: 'ack', action: 'ack' },
  { path: 'resolve', action: 'resolve' },
  { path: 'reopen', action: 'reopen' },
];

export function buildRouter(ctx: AppContext): Router {
  const router = new Router();
  const now = (): number => ctx.clock.now();

  router.add('GET', '/healthz', ({ res }: RouteContext) => {
    sendJson(res, 200, { ok: true, serverTime: now() });
  });

  // --- Auth ---

  router.add('POST', '/api/auth/login', async ({ req, res }: RouteContext) => {
    const body = asObject(await readJsonBody(req), 'Login body');
    const problems: string[] = [];
    const { username, password } = body;
    if (typeof username !== 'string' || username.length < 1 || username.length > 200) {
      problems.push('username must be 1-200 characters');
    }
    if (typeof password !== 'string' || password.length < 1 || password.length > 1024) {
      problems.push('password must be 1-1024 characters');
    }
    if (problems.length > 0 || typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'validation_failed', `Invalid login: ${problems.join('; ')}`);
    }

    const result = await login(ctx, username, password);
    if (result === null) {
      throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');
    }
    sendJson(
      res,
      200,
      { user: result.user, serverTime: now() },
      { 'Set-Cookie': sessionCookie(result.token, result.expiresAt, ctx.config.cookieSecure, now()) },
    );
  });

  router.add('POST', '/api/auth/logout', ({ req, res }: RouteContext) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token !== null) revokeSession(ctx, token);
    sendNoContent(res, { 'Set-Cookie': clearSessionCookie(ctx.config.cookieSecure) });
  });

  router.add('GET', '/api/auth/me', ({ req, res }: RouteContext) => {
    const session = authorize(ctx, req, 'viewer');
    sendJson(res, 200, { user: session.user, serverTime: now() });
  });

  // --- Users ---

  router.add('GET', '/api/users', ({ req, res }: RouteContext) => {
    authorize(ctx, req, 'viewer');
    sendJson(res, 200, { users: listUsers(ctx) });
  });

  router.add('PATCH', '/api/users/:id', async ({ req, res, params }: RouteContext) => {
    const session = authorize(ctx, req, 'admin');
    const body = asObject(await readJsonBody(req), 'Body');
    const role = body.role;
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      throw new HttpError(400, 'validation_failed', `role must be one of ${ROLES.join(', ')}`);
    }
    const user = setUserRole(ctx, actorOf(session), params.id ?? '', role as Role);
    sendJson(res, 200, { user });
  });

  // --- Incidents ---

  router.add('GET', '/api/incidents', ({ req, res, url }: RouteContext) => {
    authorize(ctx, req, 'viewer');
    const page = listIncidents(ctx, {
      status: parseEnum<Status>(queryValue(url, 'status'), STATUSES, 'status'),
      severity: parseEnum<Severity>(queryValue(url, 'severity'), SEVERITIES, 'severity'),
      assignee: queryValue(url, 'assignee'),
      q: queryValue(url, 'q'),
      cursor: parseCursor(queryValue(url, 'cursor'), 'cursor'),
      limit: parseLimit(queryValue(url, 'limit'), 50),
    });
    sendJson(res, 200, { ...page, serverTime: now() });
  });

  router.add('POST', '/api/incidents/bulk-ack', async ({ req, res }: RouteContext) => {
    const session = authorize(ctx, req, 'responder');
    const body = asObject(await readJsonBody(req), 'Body');
    const items = parseBulkItems(body.items);
    sendJson(res, 200, { results: bulkAck(ctx, actorOf(session), items) });
  });

  router.add('GET', '/api/incidents/:id', ({ req, res, params }: RouteContext) => {
    authorize(ctx, req, 'viewer');
    const id = parseId(params.id ?? '');
    const detail = getIncidentDetail(ctx, id);
    if (detail === null) {
      throw new HttpError(404, 'not_found', `Incident ${id} not found`);
    }
    sendJson(res, 200, { ...detail, serverTime: now() }, { ETag: etagOf(detail.incident.version) });
  });

  for (const { path, action } of ACTIONS) {
    router.add('POST', `/api/incidents/:id/${path}`, ({ req, res, params }: RouteContext) => {
      const session = authorize(ctx, req, 'responder');
      const id = parseId(params.id ?? '');
      requireExistingIncident(ctx, id);
      const version = requireIfMatch(req);
      const incident = applyAction(ctx, id, action, actorOf(session), version);
      sendJson(res, 200, incident, { ETag: etagOf(incident.version) });
    });
  }

  router.add('PATCH', '/api/incidents/:id', async ({ req, res, params }: RouteContext) => {
    const session = authorize(ctx, req, 'responder');
    const id = parseId(params.id ?? '');
    requireExistingIncident(ctx, id);
    const version = requireIfMatch(req);
    const body = asObject(await readJsonBody(req), 'Body');
    const assigneeId = body.assigneeId;
    const assigneeOk =
      assigneeId === null || (typeof assigneeId === 'string' && assigneeId.length >= 1 && assigneeId.length <= 200);
    if (!assigneeOk) {
      throw new HttpError(400, 'validation_failed', 'assigneeId must be a user id or null');
    }
    const incident = applyAction(ctx, id, 'assign', actorOf(session), version, assigneeId as string | null);
    sendJson(res, 200, incident, { ETag: etagOf(incident.version) });
  });

  // --- Audit and live stream ---

  router.add('GET', '/api/audit', ({ req, res, url }: RouteContext) => {
    authorize(ctx, req, 'viewer');
    const before = parseCursor(queryValue(url, 'before'), 'before');
    const limit = parseLimit(queryValue(url, 'limit'), 50);
    sendJson(res, 200, { entries: auditFeed(ctx, before ?? null, limit), serverTime: now() });
  });

  router.add('GET', '/api/stream', ({ req, res, url }: RouteContext) => {
    authorize(ctx, req, 'viewer');
    openStream(ctx, req, res, url, readCookie(req.headers.cookie, SESSION_COOKIE) ?? '');
  });

  // --- Ingest ---

  router.add('POST', '/ingest', async ({ req, res }: RouteContext) => {
    requireIngestToken(ctx, req);
    const body = await readJsonBody(req);
    const alert = parseAlert(body as Record<string, unknown>, now());
    const key = req.headers['idempotency-key'];
    const outcome = ingestAlert(ctx, alert, typeof key === 'string' ? key : undefined);
    sendJson(res, outcome.status, outcome.body, outcome.replayed ? { 'Idempotent-Replayed': 'true' } : {});
  });

  return router;
}
