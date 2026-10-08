import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Action } from '../../shared/rules';
import {
  type BulkAckItem,
  ROLES,
  type Role,
  SEVERITIES,
  type Severity,
  STATUSES,
  type Status,
} from '../../shared/types';
import {
  actorOf,
  type AuthSession,
  clearSessionCookie,
  findSession,
  login,
  requireRole,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
} from './auth';
import { auditFeed } from './audit';
import type { AppConfig } from './config';
import type { AppContext } from './context';
import { HttpError } from './errors';
import { ingestAlert, parseAlert } from './ingest';
import { applyAction, bulkAck, getIncidentDetail, listIncidents, MAX_QUERY_LENGTH } from './incidents';
import {
  asObject,
  bearerToken,
  badRequest,
  etagFor,
  headerValue,
  isCrossOrigin,
  isRecord,
  notFound,
  parseIfMatch,
  readCookie,
  readJson,
  sameSecret,
  sendEmpty,
  sendJson,
  validationFailed,
} from './http';
import { listUsers, setUserRole } from './users';
import { type StreamHandle, openStream } from './sse';
import { serveStatic } from './static';

export interface RouteEnv {
  ctx: AppContext;
  config: AppConfig;
  streams: Set<StreamHandle>;
}

type Handler = (
  env: RouteEnv,
  req: IncomingMessage,
  res: ServerResponse,
  params: string[],
  url: URL,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Base for resolving request targets. Only requests whose origin is this base are routable. */
const TARGET_BASE = 'http://localhost';

/**
 * API paths never fall back to the SPA. Trailing slashes count as the same path, so `/healthz/`
 * and `/ingest/` get the JSON 404 instead of index.html.
 */
function isApiPath(path: string): boolean {
  return /^\/(healthz|ingest)\/*$/.test(path) || /^\/api(\/|$)/.test(path);
}

/**
 * Parses the request target. A malformed target, or one that resolves to another origin (such as
 * `//evil.example/api/users` or `/\evil.example/`, which WHATWG parsing reads as a host), is a 400
 * bad_request. It is never routed by its host part and never logged as a server fault.
 */
function parseTarget(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw ?? '/', TARGET_BASE);
  } catch {
    throw badRequest('Malformed request target');
  }
  if (url.origin !== TARGET_BASE) throw badRequest('Malformed request target');
  return url;
}

/** The session for this request, or null. The role is read from the users table on each call. */
function sessionOf(env: RouteEnv, req: IncomingMessage): AuthSession | null {
  return findSession(env.ctx, readCookie(req.headers.cookie, SESSION_COOKIE));
}

/** 401 unauthenticated without a session, 403 forbidden below the required role. */
function requireSession(env: RouteEnv, req: IncomingMessage, role: Role): AuthSession {
  const session = sessionOf(env, req);
  if (!session) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  requireRole(session.user, role);
  return session;
}

/** Incident ids are positive integers. Anything else is simply not found. */
function parseIncidentId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw notFound('Incident not found');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound('Incident not found');
  return id;
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw notFound('Not found');
  }
}

function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

/** An unsigned integer query value inside [min, max], or the fallback when absent. */
function boundedInt(raw: string | null, name: string, min: number, max: number, fallback: number): number {
  const value = nonEmpty(raw);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw badRequest(`${name}: must be an integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw badRequest(`${name}: must be between ${min} and ${max}`);
  }
  return n;
}

function optionalEnum<T extends string>(raw: string | null, allowed: readonly T[], name: string): T | undefined {
  const value = nonEmpty(raw);
  if (value === null) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${name}: must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function isInt(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function parseBulkItems(value: unknown): BulkAckItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw validationFailed('items: must be an array of 1-500 entries');
  }
  const problems: string[] = [];
  const items: BulkAckItem[] = [];
  value.forEach((entry: unknown, i: number) => {
    if (!isRecord(entry)) {
      problems.push(`items[${i}]: must be an object`);
      return;
    }
    const { id, version } = entry;
    if (!isInt(id, 1)) problems.push(`items[${i}].id: must be a positive integer`);
    if (!isInt(version, 0)) problems.push(`items[${i}].version: must be a non-negative integer`);
    if (isInt(id, 1) && isInt(version, 0)) items.push({ id, version });
  });
  if (problems.length > 0) throw validationFailed(problems.join('; '));
  return items;
}

// ---------------------------------------------------------------- health and auth

function healthz(env: RouteEnv, _req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { ok: true, serverTime: env.ctx.clock.now() });
}

async function loginRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asObject(await readJson(req));
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string' || username === '' || password === '') {
    throw validationFailed('username and password are required');
  }
  const result = await login(env.ctx, username, password);
  if (!result) throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');
  const now = env.ctx.clock.now();
  sendJson(
    res,
    200,
    { user: result.user, serverTime: now },
    { 'Set-Cookie': sessionCookie(result.token, result.expiresAt, env.config.cookieSecure, now) },
  );
}

function logoutRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse): void {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (token !== null) revokeSession(env.ctx, token);
  sendEmpty(res, 204, { 'Set-Cookie': clearSessionCookie(env.config.cookieSecure) });
}

function meRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse): void {
  const session = requireSession(env, req, 'viewer');
  sendJson(res, 200, { user: session.user, serverTime: env.ctx.clock.now() });
}

// ---------------------------------------------------------------- users

function listUsersRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse): void {
  requireSession(env, req, 'viewer');
  sendJson(res, 200, { users: listUsers(env.ctx), serverTime: env.ctx.clock.now() });
}

async function patchUser(env: RouteEnv, req: IncomingMessage, res: ServerResponse, params: string[]): Promise<void> {
  const session = requireSession(env, req, 'admin');
  const userId = decodeParam(params[0] ?? '');
  const body = asObject(await readJson(req));
  const role = body.role;
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
    throw validationFailed(`role: must be one of ${ROLES.join(', ')}`);
  }
  const user = setUserRole(env.ctx, actorOf(session.user), userId, role as Role);
  sendJson(res, 200, { user });
}

// ---------------------------------------------------------------- incidents

function listRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse, _params: string[], url: URL): void {
  requireSession(env, req, 'viewer');
  const q = url.searchParams;
  const status = optionalEnum<Status>(q.get('status'), STATUSES, 'status');
  const severity = optionalEnum<Severity>(q.get('severity'), SEVERITIES, 'severity');
  const assignee = nonEmpty(q.get('assignee')) ?? undefined;
  if (assignee !== undefined && assignee.length > 200) throw badRequest('assignee: is too long');
  const text = q.get('q') ?? '';
  if (text.length > MAX_QUERY_LENGTH) throw badRequest(`q: must be at most ${MAX_QUERY_LENGTH} characters`);
  const cursorRaw = nonEmpty(q.get('cursor'));
  const cursor = cursorRaw === null ? undefined : boundedInt(cursorRaw, 'cursor', 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = boundedInt(q.get('limit'), 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT);

  const page = listIncidents(env.ctx, {
    status,
    severity,
    assignee,
    q: text.trim() === '' ? undefined : text,
    cursor,
    limit,
  });
  sendJson(res, 200, { ...page, serverTime: env.ctx.clock.now() });
}

function detailRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse, params: string[]): void {
  requireSession(env, req, 'viewer');
  const id = parseIncidentId(params[0] ?? '');
  const detail = getIncidentDetail(env.ctx, id);
  if (!detail) throw notFound('Incident not found');
  sendJson(res, 200, { ...detail, serverTime: env.ctx.clock.now() }, { ETag: etagFor(detail.incident.version) });
}

/** ack, resolve, reopen. Order: auth, 404 id, If-Match (428/400), then the domain (404, 409, 409). */
function actionRoute(action: Exclude<Action, 'assign'>): Handler {
  return (env, req, res, params) => {
    const session = requireSession(env, req, 'responder');
    const id = parseIncidentId(params[0] ?? '');
    const version = parseIfMatch(req.headers['if-match']);
    const incident = applyAction(env.ctx, id, action, actorOf(session.user), version);
    sendJson(res, 200, incident, { ETag: etagFor(incident.version) });
  };
}

/** PATCH assignee. Order: auth, 404 id, If-Match, JSON body, then the domain. */
async function patchIncident(env: RouteEnv, req: IncomingMessage, res: ServerResponse, params: string[]): Promise<void> {
  const session = requireSession(env, req, 'responder');
  const id = parseIncidentId(params[0] ?? '');
  const version = parseIfMatch(req.headers['if-match']);
  const body = asObject(await readJson(req));
  const assigneeId = body.assigneeId;
  if (assigneeId !== null && typeof assigneeId !== 'string') {
    throw validationFailed('assigneeId: must be a user id string or null');
  }
  const incident = applyAction(env.ctx, id, 'assign', actorOf(session.user), version, assigneeId);
  sendJson(res, 200, incident, { ETag: etagFor(incident.version) });
}

async function bulkRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = requireSession(env, req, 'responder');
  const body = asObject(await readJson(req));
  const items = parseBulkItems(body.items);
  const results = bulkAck(env.ctx, actorOf(session.user), items);
  sendJson(res, 200, { results });
}

// ---------------------------------------------------------------- audit, stream

function auditRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse, _params: string[], url: URL): void {
  requireSession(env, req, 'viewer');
  const beforeRaw = nonEmpty(url.searchParams.get('before'));
  const before = beforeRaw === null ? null : boundedInt(beforeRaw, 'before', 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = boundedInt(url.searchParams.get('limit'), 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT);
  const entries = auditFeed(env.ctx, before, limit);
  sendJson(res, 200, { entries, serverTime: env.ctx.clock.now() });
}

function streamRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse, _params: string[], url: URL): void {
  requireSession(env, req, 'viewer');
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const header = nonEmpty(headerValue(req.headers['last-event-id']));
  const lastIdRaw = header ?? nonEmpty(url.searchParams.get('lastEventId'));
  openStream({ ctx: env.ctx, config: env.config, req, res, token, lastIdRaw, streams: env.streams });
}

// ---------------------------------------------------------------- ingest

async function ingestRoute(env: RouteEnv, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const presented = bearerToken(req.headers.authorization);
  if (presented === null || !sameSecret(presented, env.config.ingestToken)) {
    throw new HttpError(401, 'bad_ingest_token', 'Missing or invalid ingest token');
  }
  const body = await readJson(req);
  const alert = parseAlert(body as Record<string, unknown>, env.ctx.clock.now());
  const key = headerValue(req.headers['idempotency-key']) ?? undefined;
  const outcome = ingestAlert(env.ctx, alert, key);
  sendJson(res, outcome.status, outcome.body, outcome.replayed ? { 'Idempotent-Replayed': 'true' } : {});
}

// ---------------------------------------------------------------- table

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/healthz$/, handler: healthz },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, handler: loginRoute },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, handler: logoutRoute },
  { method: 'GET', pattern: /^\/api\/auth\/me$/, handler: meRoute },
  { method: 'GET', pattern: /^\/api\/users$/, handler: listUsersRoute },
  { method: 'PATCH', pattern: /^\/api\/users\/([^/]+)$/, handler: patchUser },
  { method: 'GET', pattern: /^\/api\/incidents$/, handler: listRoute },
  { method: 'POST', pattern: /^\/api\/incidents\/bulk-ack$/, handler: bulkRoute },
  { method: 'GET', pattern: /^\/api\/incidents\/([^/]+)$/, handler: detailRoute },
  { method: 'PATCH', pattern: /^\/api\/incidents\/([^/]+)$/, handler: patchIncident },
  { method: 'POST', pattern: /^\/api\/incidents\/([^/]+)\/ack$/, handler: actionRoute('ack') },
  { method: 'POST', pattern: /^\/api\/incidents\/([^/]+)\/resolve$/, handler: actionRoute('resolve') },
  { method: 'POST', pattern: /^\/api\/incidents\/([^/]+)\/reopen$/, handler: actionRoute('reopen') },
  { method: 'GET', pattern: /^\/api\/audit$/, handler: auditRoute },
  { method: 'GET', pattern: /^\/api\/stream$/, handler: streamRoute },
  { method: 'POST', pattern: /^\/ingest$/, handler: ingestRoute },
];

/**
 * Routes one request. Order: a cross-origin unsafe request is refused first (403), then API
 * paths are matched against the table (anything unmatched is a JSON 404 and never falls back to
 * the SPA), then non-API GET and HEAD go to the static server.
 */
export async function handleRequest(env: RouteEnv, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = parseTarget(req.url);
  const path = url.pathname;

  if (UNSAFE_METHODS.has(method) && isCrossOrigin(req)) {
    throw new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed');
  }

  if (!isApiPath(path)) {
    if (method === 'GET' || method === 'HEAD') {
      await serveStatic(env.config.webDir, req, res, path);
      return;
    }
    throw notFound();
  }

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    await route.handler(env, req, res, match.slice(1), url);
    return;
  }
  throw notFound();
}
