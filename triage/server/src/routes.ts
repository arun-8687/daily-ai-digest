import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hasRole, type Action } from '../../shared/rules';
import {
  ROLES,
  SEVERITIES,
  STATUSES,
  type BulkAckItem,
  type IncidentDTO,
  type Role,
  type Severity,
  type Status,
} from '../../shared/types';
import { auditFeed } from './audit';
import {
  clearSessionCookie,
  findSession,
  hashedDummy,
  revokeSession,
  sessionCookie,
  SESSION_COOKIE,
  startSession,
  type AuthSession,
} from './auth';
import type { AppContext } from './context';
import { HttpError } from './errors';
import { ingestAlert, parseAlert } from './ingest';
import { applyAction, bulkAck, getIncidentDetail, listIncidents } from './incidents';
import { Router, sendEmpty, sendJson, type RequestContext } from './http';
import { openStream } from './sse';
import { listUsers, findUserRowByUsername, setUserRole, toUserDTO } from './users';
import { verifyPassword } from './passwords';
import { parseCookies } from './util';

const JSON_LIMIT = 64 * 1024;
const BULK_LIMIT = 500;

function requireSession(c: RequestContext): AuthSession {
  if (!c.session) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  return c.session;
}

/** Role checks live here, on the server. The client hides buttons, but this is the enforcement. */
function requireRole(c: RequestContext, role: Role): AuthSession {
  const session = requireSession(c);
  if (!hasRole(session.user.role, role)) {
    throw new HttpError(403, 'forbidden', `This action needs the ${role} role`);
  }
  return session;
}

function actorOf(session: AuthSession) {
  return { id: session.user.id, name: session.user.displayName };
}

function incidentId(c: RequestContext): number {
  const id = Number(c.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'not_found', 'Incident not found');
  return id;
}

/** Mutations must say which version they are changing. This is the optimistic-concurrency guard. */
function expectedVersion(req: IncomingMessage): number {
  const raw = req.headers['if-match'];
  if (raw === undefined) {
    throw new HttpError(428, 'precondition_required', 'Send If-Match with the incident version you are changing');
  }
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(String(raw).trim());
  if (!m) throw new HttpError(400, 'bad_if_match', 'If-Match must be the incident version, for example "3"');
  return Number(m[1]);
}

function sendIncident(res: ServerResponse, status: number, incident: IncidentDTO): void {
  sendJson(res, status, incident, { ETag: `"${incident.version}"` });
}

function queryEnum<T extends string>(value: string | null, allowed: readonly T[], name: string): T | undefined {
  if (value === null || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, 'bad_query', `${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function tokenFromRequest(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function buildRouter(): Router {
  const r = new Router();

  r.on('GET', '/healthz', (c) => {
    sendJson(c.res, 200, { ok: true, serverTime: c.ctx.clock.now() });
  });

  // ---- auth ----------------------------------------------------------------

  r.on('POST', '/api/auth/login', async (c) => {
    const body = await c.json();
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const row = username ? findUserRowByUsername(c.ctx, username) : undefined;
    // Always run one password check, so response time does not reveal whether the user exists.
    const ok = await verifyPassword(password, row?.password_hash ?? (await hashedDummy()));
    if (!row || !ok) throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');

    const user = toUserDTO(row);
    const { token, expiresAt } = startSession(c.ctx, user);
    sendJson(
      c.res,
      200,
      { user, serverTime: c.ctx.clock.now() },
      { 'Set-Cookie': sessionCookie(token, expiresAt, c.ctx.config.cookieSecure, c.ctx.clock.now()) },
    );
  });

  r.on('POST', '/api/auth/logout', (c) => {
    const token = tokenFromRequest(c.req);
    if (token) revokeSession(c.ctx, token);
    sendEmpty(c.res, 204, { 'Set-Cookie': clearSessionCookie(c.ctx.config.cookieSecure) });
  });

  r.on('GET', '/api/auth/me', (c) => {
    const session = requireSession(c);
    sendJson(c.res, 200, { user: session.user, serverTime: c.ctx.clock.now() });
  });

  // ---- users ---------------------------------------------------------------

  r.on('GET', '/api/users', (c) => {
    requireSession(c);
    sendJson(c.res, 200, { users: listUsers(c.ctx) });
  });

  r.on('PATCH', '/api/users/:id', async (c) => {
    const session = requireRole(c, 'admin');
    const body = await c.json();
    const role = queryEnum(typeof body.role === 'string' ? body.role : null, ROLES, 'role');
    if (!role) throw new HttpError(400, 'validation_failed', 'role is required');
    const user = setUserRole(c.ctx, actorOf(session), c.params.id, role);
    sendJson(c.res, 200, { user });
  });

  // ---- incidents -----------------------------------------------------------

  r.on('GET', '/api/incidents', (c) => {
    requireRole(c, 'viewer');
    const q = c.url.searchParams;
    const cursorRaw = q.get('cursor');
    let cursor: number | undefined;
    if (cursorRaw !== null && cursorRaw !== '') {
      cursor = Number(cursorRaw);
      if (!Number.isInteger(cursor) || cursor <= 0) throw new HttpError(400, 'bad_query', 'cursor is invalid');
    }
    const limitRaw = q.get('limit');
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new HttpError(400, 'bad_query', 'limit must be an integer from 1 to 200');
    }
    const assignee = q.get('assignee') ?? undefined;
    if (assignee !== undefined && assignee.length > 64) throw new HttpError(400, 'bad_query', 'assignee is too long');
    const search = (q.get('q') ?? '').trim();
    if (search.length > 200) throw new HttpError(400, 'bad_query', 'q is too long');

    const page = listIncidents(c.ctx, {
      status: queryEnum(q.get('status'), STATUSES, 'status') as Status | undefined,
      severity: queryEnum(q.get('severity'), SEVERITIES, 'severity') as Severity | undefined,
      assignee: assignee || undefined,
      q: search || undefined,
      cursor,
      limit,
    });
    sendJson(c.res, 200, { ...page, serverTime: c.ctx.clock.now() });
  });

  r.on('POST', '/api/incidents/bulk-ack', async (c) => {
    const session = requireRole(c, 'responder');
    const body = await c.json();
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > BULK_LIMIT) {
      throw new HttpError(400, 'validation_failed', `items must be an array of 1 to ${BULK_LIMIT} entries`);
    }
    const items: BulkAckItem[] = body.items.map((raw: unknown, i: number) => {
      const item = raw as { id?: unknown; version?: unknown };
      if (!Number.isInteger(item.id) || !Number.isInteger(item.version)) {
        throw new HttpError(400, 'validation_failed', `items[${i}] needs integer id and version`);
      }
      return { id: item.id as number, version: item.version as number };
    });
    const results = bulkAck(c.ctx, actorOf(session), items);
    sendJson(c.res, 200, { results });
  });

  r.on('GET', '/api/incidents/:id', (c) => {
    requireRole(c, 'viewer');
    const detail = getIncidentDetail(c.ctx, incidentId(c));
    if (!detail) throw new HttpError(404, 'not_found', 'Incident not found');
    sendJson(c.res, 200, { ...detail, serverTime: c.ctx.clock.now() }, { ETag: `"${detail.incident.version}"` });
  });

  const transitionRoute = (path: string, action: Action): void => {
    r.on('POST', path, (c) => {
      const session = requireRole(c, 'responder');
      const id = incidentId(c);
      const version = expectedVersion(c.req);
      sendIncident(c.res, 200, applyAction(c.ctx, id, action, actorOf(session), version));
    });
  };
  transitionRoute('/api/incidents/:id/ack', 'ack');
  transitionRoute('/api/incidents/:id/resolve', 'resolve');
  transitionRoute('/api/incidents/:id/reopen', 'reopen');

  r.on('PATCH', '/api/incidents/:id', async (c) => {
    const session = requireRole(c, 'responder');
    const id = incidentId(c);
    const version = expectedVersion(c.req);
    const body = await c.json();
    if (body.assigneeId !== null && typeof body.assigneeId !== 'string') {
      throw new HttpError(400, 'validation_failed', 'assigneeId must be a user id or null');
    }
    sendIncident(c.res, 200, applyAction(c.ctx, id, 'assign', actorOf(session), version, body.assigneeId as string | null));
  });

  // ---- audit ---------------------------------------------------------------

  r.on('GET', '/api/audit', (c) => {
    requireRole(c, 'viewer');
    const beforeRaw = c.url.searchParams.get('before');
    const before = beforeRaw === null ? null : Number(beforeRaw);
    if (before !== null && (!Number.isInteger(before) || before <= 0)) {
      throw new HttpError(400, 'bad_query', 'before is invalid');
    }
    const limit = Math.min(Math.max(Number(c.url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    sendJson(c.res, 200, { entries: auditFeed(c.ctx, before, limit), serverTime: c.ctx.clock.now() });
  });

  // ---- live stream ---------------------------------------------------------

  r.on('GET', '/api/stream', (c) => {
    const session = requireRole(c, 'viewer');
    const token = tokenFromRequest(c.req) as string;
    const header = c.req.headers['last-event-id'];
    const lastEventId = typeof header === 'string' ? header : c.url.searchParams.get('lastEventId');
    openStream(c.ctx, c.req, c.res, token, session, lastEventId);
  });

  // ---- ingest (machine clients) --------------------------------------------

  r.on('POST', '/ingest', async (c) => {
    requireIngestToken(c.ctx, c.req);
    const body = await c.json(JSON_LIMIT);
    const alert = parseAlert(body, c.ctx.clock.now());
    const key = c.req.headers['idempotency-key'];
    if (key !== undefined && (String(key).length === 0 || String(key).length > 255)) {
      throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 1 to 255 characters');
    }
    const result = ingestAlert(c.ctx, alert, key === undefined ? undefined : String(key));
    sendJson(c.res, result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
  });

  return r;
}

function requireIngestToken(ctx: AppContext, req: IncomingMessage): void {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(ctx.config.ingestToken);
  const got = Buffer.from(presented);
  const valid = got.length === expected.length && timingSafeEqual(got, expected);
  if (!valid) throw new HttpError(401, 'bad_ingest_token', 'Send Authorization: Bearer <ingest token>');
}

/** Exported so the app can attach the caller's session before dispatching. */
export function sessionFor(ctx: AppContext, req: IncomingMessage): AuthSession | null {
  return findSession(ctx, tokenFromRequest(req));
}
