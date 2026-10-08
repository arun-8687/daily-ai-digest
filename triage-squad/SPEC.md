# Triage: build spec (planner-owned)

A real-time incident board. TypeScript end to end: React + Vite front, Node back, SQLite. One command (`npm start`) installs, builds, seeds and runs. No paid services. Node >= 22.13, database is the built-in `node:sqlite` (`DatabaseSync`), so there are no native modules.

`shared/types.ts` and `shared/rules.ts` are **contracts**. Import them; do not edit them. If a contract seems wrong, say so in your final report instead of changing it.

Dependencies are already installed (`node_modules`). Do not add packages. Run TypeScript through `tsx` (`node --disable-warning=ExperimentalWarning --import tsx file.ts`). Imports use extensionless relative paths (bundler resolution).

---

## 1. Decisions (already made, implement exactly)

**D1 Grouping** (pure function, `server/src/grouping.ts`). For alert with event time `ts` and fingerprint `fp`:
1. Candidates = incidents with `fp` and status `open` or `acked`, where `|ts - last_seen| <= GROUP_WINDOW_MS` (inclusive). Fold into the one with max `last_seen` (tie: max id).
2. Else take the most recently resolved incident with `fp` (max `resolved_at`, tie max id). If `|ts - resolved_at| <= FLAP_WINDOW_MS` → **reopen** it and fold the alert in.
3. Else if `ts < resolved_at - FLAP_WINDOW_MS` and `|ts - last_seen| <= GROUP_WINDOW_MS` → **attach** the alert to that resolved incident without changing status.
4. Else **create** a new incident.
- `last_seen = max(last_seen, ts)` (never backwards), `first_seen = min(first_seen, ts)`. Title and source follow the alert with the newest `ts` (`ts >= last_seen`).
- Severity escalates to `maxSeverity` on fold/reopen (not on attach). It never de-escalates.
- An older open incident is never auto-resolved (documented gap).

**D2 Dedupe and idempotency.** Content hash = sha256 of stable (sorted-key) JSON of `{source,fingerprint,severity,title,payload,ts}`. An alert whose `(fingerprint, content_hash)` already exists → action `duplicate`, nothing changes. `Idempotency-Key` header (1-255 chars): checked first, inside the same transaction. Same key + same hash → replay the stored status and body with header `Idempotent-Replayed: true`. Same key + different hash → 422 `idempotency_key_reused`. Stored response is written in the same transaction as the effects. Keys expire after 24h.

**D3 State machine** = `transition()` in `shared/rules.ts`. Illegal → 409 `illegal_transition` with `current`.

**D4 Two counters** (fixes a flaw in the previous build).
- `version`: concurrency token for If-Match. +1 ONLY on ack, resolve, reopen (manual or flap), and assignee change.
- `rev`: +1 on EVERY write (folds, attach, escalation, SLA breach, plus everything that bumps version).
- Mutations check `If-Match` against `version`. Clients merge live updates by `rev` (ignore anything with `rev <=` local).
- So an alert folding into an incident while a responder is acking it does NOT cause a 409.

**D5 Optimistic concurrency.** Mutations require `If-Match: "<version>"` (also accept `3` and `W/"3"`). Missing → 428 `precondition_required`. Malformed → 400 `bad_if_match`. Check order: auth (401/403), exists (404), version (409 `version_conflict` + `current`), legality (409 `illegal_transition` + `current`). Success responses carry `ETag: "<version>"`.

**D6 SLA.** A critical incident that is `open` (unacked) for 5 minutes is breached. The clock (`sla_started_at`) starts at **server receipt time** when the incident becomes critical-and-open: on create, on escalation to critical while open, on reopen if critical. Ack and resolve clear `sla_started_at`. The breach is stamped at the **deadline** (`sla_started_at + SLA_CRITICAL_MS`), not the sweep time. `sla_breached_at` resets on reopen. A sweep (`sweepSla`) runs every second plus once at startup; state lives in SQLite so restarts resume. Each breach writes audit `incident.sla_breached` (actor `system:sla`, name `SLA monitor`) and emits event `incident.sla_breached`. A breach bumps `rev`, not `version`. `slaDueAt` in the DTO = `sla_started_at + SLA_CRITICAL_MS` when started and not breached, else null.

**D7 Audit** (append-only, SQLite triggers abort UPDATE and DELETE on `audit_log`). Columns: id, incident_id (nullable), actor, actor_name, action, before_state JSON, after_state JSON, created_at. Snapshot = `{status, severity, assigneeId, version, rev, alertCount, lastSeen, slaBreachedAt}`. Actions: `incident.created`, `incident.acked`, `incident.resolved`, `incident.reopened`, `incident.assigned`, `incident.escalated`, `incident.sla_breached`, `alert.attached`, `user.role_changed`, `auth.login`. Routine folds are NOT audited (the alerts table records them). System actors: `system:ingest` / `Ingest`, `system:sla` / `SLA monitor`.

**D8 Events and transactions.** Every write runs in `BEGIN IMMEDIATE` … `COMMIT`. Events are inserted into `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type, data, created_at)` **inside** the transaction and published to live subscribers **only after COMMIT**. Event data = `IncidentEventData` (`{incident, audit: [entries written in that tx]}`). Retention: keep the newest 100,000 events.

**D9 Auth.** Users table with scrypt hashes (`scrypt$N$r$p$salt$hash`). Session = 32 random bytes base64url. Store only sha256 in `sessions`, with a 12h expiry (`TRIAGE_SESSION_HOURS`). Cookie `triage_session`, `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` if `TRIAGE_COOKIE_SECURE=1`. Roles are read from the users table on every request. viewer: read and stream. responder: ack, resolve, reopen, assign, bulk ack. admin: responder plus `PATCH /api/users/:id` (last admin cannot be demoted → 409 `last_admin`). Login: an unknown user still runs one scrypt (timing). Unsafe methods (POST/PATCH/PUT/DELETE) with an `Origin` header whose host ≠ `Host` → 403 `cross_origin`. Demo users: `u_alice`/alice/Alice Chen/admin, `u_bob`/bob/Bob Okafor/responder, `u_carol`/carol/Carol Diaz/viewer. Password `triage-demo`. `ensureDemoUsers` is idempotent.

**D10 Ingest auth** = `Authorization: Bearer <TRIAGE_INGEST_TOKEN>` (default `dev-ingest-token`), constant-time compare, 401 `bad_ingest_token`. No session needed.

**D11 List.** `ORDER BY id DESC`, exclusive keyset cursor `id < cursor`, so it is stable under concurrent inserts. `limit` 1-200 (default 50). Filters: `status`, `severity`, `assignee` (user id or `none`), `q` (title LIKE substring, escape `\ % _`, max 200 chars). `total` only when no cursor.

**D12 Live stream** `GET /api/stream` (SSE, viewer+).
- Headers: `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`. Write `retry: 2000` first.
- Then `event: hello` (no id) with `{serverTime, head}`.
- Last id comes from the `Last-Event-ID` header, else `?lastEventId=`. Absent → start at head, no replay.
- If last id is invalid, greater than head, or older than the oldest retained event, or more than 5000 events would be replayed → send `id: <head>\nevent: resync\ndata: {"head":N}`. Otherwise replay every event with `seq > lastId` in order.
- Replay and `hub.add(subscriber)` happen in **one synchronous block** (no await between), so nothing is missed or duplicated.
- Every 15s: re-check the session (close the stream if invalid), then send `event: ping` (no id) with `{serverTime}`.
- A subscriber whose `res.writableLength` exceeds 1 MB is closed. It resumes from its last id.

**D13 Validation.** The ingest body must be JSON (415 otherwise), max 64 KB (413). `source` 1-64, `fingerprint` 1-256, `title` 1-200 chars (trimmed). `severity` in the enum. `ts` is epoch ms number or ISO string. `ts > now + FUTURE_SKEW_MS` → 400. `payload` optional, must be an object. All problems are listed in one 400 `validation_failed` message.

**D14 Time.** Every time read goes through an injectable `Clock { now(): number }`. Tests use a manual clock.

---

## 2. HTTP API (exact)

Errors: `{error:{code,message}, current?}`. JSON endpoints require `Content-Type: application/json` for bodies (415). All responses carry `X-Content-Type-Options: nosniff`.

| Method + path | Role | Body / query | Success |
| --- | --- | --- | --- |
| GET /healthz | none | | 200 `{ok:true, serverTime}` |
| POST /api/auth/login | none | `{username,password}` | 200 `{user, serverTime}` + Set-Cookie. 401 `invalid_credentials` |
| POST /api/auth/logout | none | | 204, clears cookie, deletes session |
| GET /api/auth/me | any session | | 200 `{user, serverTime}`. 401 `unauthenticated` |
| GET /api/users | viewer | | 200 `{users: UserDTO[]}` |
| PATCH /api/users/:id | admin | `{role}` | 200 `{user}` |
| GET /api/incidents | viewer | `status,severity,assignee,q,cursor,limit` | 200 `ListResponse` |
| GET /api/incidents/:id | viewer | | 200 `DetailResponse` (alerts newest ts first, max 50; audit newest first, max 200), ETag |
| POST /api/incidents/:id/ack | responder | If-Match | 200 `IncidentDTO`, ETag |
| POST /api/incidents/:id/resolve | responder | If-Match | 200 `IncidentDTO` |
| POST /api/incidents/:id/reopen | responder | If-Match | 200 `IncidentDTO` |
| PATCH /api/incidents/:id | responder | If-Match, `{assigneeId: string\|null}` | 200 `IncidentDTO`. 400 `unknown_assignee`. No-op if unchanged (no bump). |
| POST /api/incidents/bulk-ack | responder | `{items: BulkAckItem[]}` (1-500) | 200 `{results: BulkAckResult[]}`. Each item is its own transaction. |
| GET /api/audit | viewer | `before` (id cursor), `limit` (1-200) | 200 `{entries: AuditDTO[], serverTime}` newest first |
| GET /api/stream | viewer | `lastEventId` | SSE (D12) |
| POST /ingest | ingest token | alert JSON, optional `Idempotency-Key` | 202 `IngestResponse` |

Unknown non-API GET paths serve the built SPA from `web/dist` (index.html fallback, path traversal guarded). CSP: `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`. `/api/*`, `/ingest` and `/healthz` never fall back to the SPA.

---

## 3. Server module contracts

Package A (server-domain) exports these from `server/src/`. Package B builds on exactly these:

```ts
// clock.ts
export interface Clock { now(): number }
export const systemClock: Clock
export interface ManualClock extends Clock { set(ms: number): void; advance(ms: number): void }
export function manualClock(start: number): ManualClock

// config.ts
export interface AppConfig { dbPath: string; ingestToken: string; sessionTtlMs: number; webDir: string | null;
  cookieSecure: boolean; sseHeartbeatMs: number; sweepIntervalMs: number }
export const DEFAULT_INGEST_TOKEN = 'dev-ingest-token'
export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig   // TRIAGE_DB (default data/triage.db), TRIAGE_WEB_DIR ('none' → null, default <root>/web/dist)

// errors.ts
export class HttpError extends Error { constructor(status: number, code: string, message: string, current?: IncidentDTO) }

// db.ts — wraps DatabaseSync with a cached prepare. Params: string | number | null.
export class Database { constructor(path: string)   // ':memory:' allowed; creates parent dir; runs schema
  get<T>(sql, ...params): T | undefined; all<T>(sql, ...params): T[];
  run(sql, ...params): { changes: number; lastInsertRowid: number };
  tx<T>(fn: () => T): T;   // BEGIN IMMEDIATE, throws on nesting
  readonly raw: DatabaseSync; close(): void }

// hub.ts
export interface Frame { seq: number; type: string; data: string }
export interface Subscriber { lastSent: number; deliver(frame: Frame): void }
export class Hub { add(s): void; remove(s): void; publish(frame: Frame): void /* skip if seq <= lastSent */; readonly size: number }

// context.ts
export interface AppContext { db: Database; clock: Clock; hub: Hub; config: AppConfig }
export function createContext(config: AppConfig, clock: Clock): AppContext
export class Unit { emit(type: string, payload: unknown): void }   // inserts into events inside the tx
export function transact<T>(ctx: AppContext, fn: (unit: Unit) => T): T   // publishes after COMMIT

// audit.ts
export interface Actor { id: string; name: string }
export const SYSTEM_INGEST: Actor, SYSTEM_SLA: Actor
export function auditFeed(ctx, before: number | null, limit: number): AuditDTO[]

// users.ts / auth.ts
export const DEMO_PASSWORD = 'triage-demo'
export async function ensureDemoUsers(ctx, password?): Promise<void>
export function listUsers(ctx): UserDTO[]
export function setUserRole(ctx, actor: Actor, targetId: string, role: Role): UserDTO
export const SESSION_COOKIE = 'triage_session'
export interface AuthSession { user: UserDTO; tokenHash: string; expiresAt: number }
export async function login(ctx, username: string, password: string): Promise<{ user: UserDTO; token: string; expiresAt: number } | null>  // writes auth.login audit
export function findSession(ctx, token: string | null): AuthSession | null
export function revokeSession(ctx, token: string): void
export function sessionCookie(token: string, expiresAt: number, secure: boolean, now: number): string
export function clearSessionCookie(secure: boolean): string

// grouping.ts (pure)
export interface GroupCandidate { id: number; status: Status; lastSeen: number; resolvedAt: number | null }
export type GroupDecision = { kind: 'fold' | 'reopen' | 'attach'; incidentId: number } | { kind: 'create' }
export function decideGrouping(ts: number, unresolved: GroupCandidate[], latestResolved: GroupCandidate | null): GroupDecision

// ingest.ts
export interface AlertInput { source: string; fingerprint: string; severity: Severity; title: string; payload: Record<string, unknown>; ts: number }
export function parseAlert(body: Record<string, unknown>, now: number): AlertInput   // throws HttpError 400
export function ingestAlert(ctx, alert: AlertInput, idempotencyKey?: string): { status: number; body: IngestResponse; replayed: boolean }

// incidents.ts
export interface ListParams { status?: Status; severity?: Severity; assignee?: string; q?: string; cursor?: number; limit: number }
export function listIncidents(ctx, p: ListParams): { items: IncidentDTO[]; nextCursor: string | null; total: number | null }
export function getIncidentDetail(ctx, id: number): { incident: IncidentDTO; alerts: AlertDTO[]; audit: AuditDTO[] } | null
export function applyAction(ctx, id: number, action: Action, actor: Actor, expectedVersion: number, assigneeId?: string | null): IncidentDTO
export function bulkAck(ctx, actor: Actor, items: BulkAckItem[]): BulkAckResult[]

// sla.ts
export function sweepSla(ctx): number         // loops batches of 500 until done; returns breaches applied
export function runMaintenance(ctx): void     // expired sessions, idempotency > 24h, events beyond retention
```

Package B (server-http) owns `http.ts`, `routes.ts`, `sse.ts`, `static.ts`, `app.ts`, `index.ts`:

```ts
// app.ts
export interface TriageApp { readonly ctx: AppContext; start(port: number, host?: string /* default 127.0.0.1 */): Promise<number>; stop(): Promise<void> }
export function createTriageApp(config: AppConfig, options?: { clock?: Clock; timers?: boolean }): TriageApp
// timers:false disables the 1s SLA sweep and 60s maintenance (tests call sweepSla directly)
// index.ts: loadConfig, ensureDemoUsers, sweepSla once, listen on PORT (8080) / TRIAGE_HOST, SIGINT/SIGTERM → stop
```

---

## 4. Client contracts (`web/src`)

Package C1 (web-data) exports these. Package C2 (web-ui) builds on exactly these:

```ts
// api.ts
export class ApiError extends Error { readonly status: number; readonly code: string; readonly current?: IncidentDTO }
export function isAbortError(err: unknown): boolean
export function messageOf(err: unknown): string
export function api<T>(path: string, opts?: { method?: string; body?: unknown; ifMatch?: number; signal?: AbortSignal }): Promise<T>
//   network failure → ApiError(0,'network',…). Feeds serverTime from JSON bodies into clock.observeServerTime.

// clock.ts
export function observeServerTime(serverTime: number, sentAt: number, receivedAt: number): void  // smoothed offset
export function serverNow(): number
export function useServerNow(): number   // re-renders once per second via ONE shared ticker

// store.ts
export const PAGE_SIZE = 100
export interface Entry { readonly inc: IncidentDTO; readonly pending: number }
export interface ListState { readonly status: 'loading'|'ready'|'error'; readonly error: string|null; readonly filters: Filters;
  readonly order: readonly number[]; readonly nextCursor: string|null; readonly total: number|null; readonly loadingMore: boolean }
export const store: {
  subscribe(l: () => void): () => void;          // stable function identity (useSyncExternalStore)
  getList(): ListState;                          // identity changes only when list-level state changes
  getEntry(id: number): Entry | undefined;       // identity changes only when that entry changes
  onUpdate(l: (id: number | null, type: string) => void): () => void;  // after each live event (id) or resync (null)
  setFilters(f: Filters): void;                  // no-op if equal; else reset and load first page
  loadMore(): void; retry(): void; resync(): void;
  applyEvent(type: StreamEventType, data: IncidentEventData): void;
  seed(inc: IncidentDTO): void;                  // deep-linked incident outside the list
  mutate(id: number, patch: Partial<IncidentDTO>, request: (version: number) => Promise<IncidentDTO>): Promise<IncidentDTO>;
  bulkAck(ids: number[], actor: { id: string; displayName: string }): Promise<BulkAckResult[]>;
  clear(): void;
}
// realtime.ts
export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'signed-out'
export const realtime: { subscribe(l): () => void; getStatus(): ConnStatus; start(onAuthLost: () => void): void; stop(): void }
// session.ts
export interface SessionState { status: 'loading'|'anon'|'authed'; user: UserDTO|null; users: UserDTO[] }
export const session: { subscribe; getState(): SessionState; init(): Promise<void>; login(u, p): Promise<void>; logout(): Promise<void>; expire(): void }
export function useSession(): SessionState
// router.ts — URL state: ?status&severity&assignee&q&sel
export interface UrlState { filters: Filters; sel: number | null }
export function parseSearch(search: string): UrlState
export function navigate(patch: Record<string, string | null>, mode: 'push' | 'replace'): void
export function useUrlState(): UrlState
// toasts.ts
export type ToastKind = 'info'|'success'|'error'
export function toast(kind: ToastKind, message: string): void
export function dismiss(id: number): void
export function useToasts(): { id: number; kind: ToastKind; message: string }[]
// format.ts
export const SEVERITY_LABEL, STATUS_LABEL; export function incidentRef(id): string /* INC-12 */;
export function timeOfDay(ms); ago(ms, now); countdown(remainingMs); userName(users, id); describeCurrent(inc, users) /* "now Acked by Bob Okafor" */
// messages.ts
export const READ_ONLY: string
export function describeFailure(err: unknown, action: string, users: readonly UserDTO[]): string
//   version_conflict → "Couldn't <action>: it changed while you were looking at it (<describeCurrent>). Your change was rolled back."
```

Store rules (C1):
- Merge by `rev`: ignore an incoming incident with `rev <= local rev` unless forced. Server truth from a 409 `current` is forced.
- `mutate`: apply the patch at once (pending+1), call `request(entry.inc.version)`. On success merge the result. On ApiError with `current` force-set current. On other errors revert to the pre-patch copy only if no newer rev arrived. Rethrow.
- Live membership: insert a matching incident into `order` (desc by id) only if `nextCursor === null` or `id >` lowest loaded id. Remove an incident that stops matching. Track `total` (+1 on created-and-matching, ±1 when a known incident flips match).
- Every list request (first page, loadMore, resync) carries a **generation**. `setFilters`/`resync`/`clear` bump it, and stale responses are dropped (this fixes the resync vs loadMore race).
- `resync()` re-fetches `max(PAGE_SIZE, loaded)` rows, capped at 1000 (no more than 5 requests). It keeps live-inserted ids above the fetched head.
- `bulkAck`: send EVERY selected loaded id with its version. Optimistic ack for open ones, server decides each. Settle per result.

Realtime rules (C1): EventSource on `/api/stream` (`?lastEventId=` on manual reconnect). Track `lastEventId` from events that carry an id. On `resync` → `store.resync()`. Watchdog: no message for 40s while live → reconnect. EventSource CLOSED → GET /api/auth/me. 401 → stop + onAuthLost, else backoff 1s→30s. `online` → reconnect if not live. `offline` → status offline. Tab visible after >20s without activity → reconnect. When status goes non-live → live, call `store.resync()` once (not on every visibility change).

---

## 5. UI requirements (C2)

- **Login**: labelled `Username`, `Password`, button `Sign in`, errors in `role="alert"`. Hint lists the demo logins.
- **Top bar**: `Triage` h1. Connection badge `.conn` with `role="status"` showing `Live` / `Connecting…` / `Reconnecting…` / `Offline. Live updates are paused.` Display name, role, `Sign out`.
- **Filters** (`form role="search"`): `Search titles` (type=search, debounced 300ms into URL), `Status`, `Severity`, `Assignee` (Anyone / Unassigned / users) selects, `Clear filters`. Every change pushes history; Back/Forward restore. A `.count` line (`aria-live="polite"`): `N matching · M loaded`.
- **List**: `@tanstack/react-virtual`, fixed rows 76px, `role="listbox" aria-label="Incidents" aria-multiselectable="true" id="incidents" tabIndex=0` with `aria-activedescendant`. Rows are `role="option"`, `id="inc-<id>"`, `aria-selected` = in the bulk selection. A row shows INC-id, severity badge, status badge (`Open`/`Acked`/`Resolved`), `Saving…` while pending, SLA countdown (`SLA m:ss` or `SLA breached`), title, assignee · alert count · last seen. Click opens the drawer. Ctrl/Cmd-click toggles selection. Loading skeleton, empty state ("No incidents match these filters." + Clear filters), and error state with "Try again" are rendered OUTSIDE the listbox. Load more within 20 rows of the end.
- **Drawer** (`section role="region" aria-label="INC-<id>: <title>"`, h2 = title, focused on open, focus returns to `#incidents` on close): badges, SLA, actions (`Ack`, `Resolve…`, `Reopen` per status and role; `aria-keyshortcuts`; kbd hints `aria-hidden`), Assignee select (responder, unresolved) else text, facts (first/last seen, alerts, fingerprint, acked, resolved, version), Alerts list (title, source, event and received time, `<details>` payload `<pre>`), Audit timeline (time, actorName, human action label, change summary). Refetch detail (debounced 250ms) on updates for this id. Viewers see "Your role can view incidents but not change them." At ≤900px the drawer is full-screen.
- **Resolve confirmation**: native `<dialog>` named `Resolve INC-<id>?`. It pins the `version` at open and shows a warning if the live version moved since. Confirm `Resolve incident` sends the pinned version. Failure → toast via `describeFailure`. Cancel button.
- **Bulk**: selection bar `N selected`, `Ack selected` (Shift+A), `Clear`, plus a `Select open` shortcut. Report dialog `Bulk ack: X of N acked` lists each failure with its reason. Failed items stay selected.
- **Keyboard** (global keydown, ignored with Ctrl/Meta/Alt, when a `dialog[open]` exists, or when focus is in input/textarea/select/contenteditable):
  - `j`/`k`: move active.
  - `Enter`: open the drawer.
  - `a`: ack active.
  - `r`: resolve dialog.
  - `x`: toggle selection.
  - `Shift+A`: bulk ack.
  - `/`: focus search.
  - `?`: shortcuts dialog.
  - `Esc`: close drawer, else clear selection. Esc in the search box blurs and focuses the list.
  - **Fix from the previous build**: `Enter`, `Space`, and arrow keys are only handled when focus is on the listbox (`#incidents`) or `document.body`. Never hijack them on buttons, links, `summary`, or inside the drawer. `Space` toggles selection only when the listbox has focus.
  - If the active row leaves the list (for example, acked under an Open filter), the next `j` lands on the row that took its place.
- **Optimistic**: ack, assign and resolve via `store.mutate`. 409 → toast (`role="alert"`) from `describeFailure`, rollback is automatic.
- **Toasts** region bottom-right. `role="alert"` for errors, `role="status"` otherwise. Auto-dismiss (5s, errors 9s).
- **SLA breach event** → error toast "SLA breached: INC-<id> …".
- **Theme**: CSS tokens on `:root` with a dark mode via `prefers-color-scheme`. Usable at 380px with no horizontal scroll. Respect `prefers-reduced-motion`. Visible `:focus-visible`.

---

## 6. Tests

- `server/test/grouping.test.ts`: every D1 branch and boundary (exactly 10 min inclusive, +1ms new; flap exactly 5 min, +1ms new; late fold; attach; multiple candidates).
- `server/test/state-machine.test.ts`: the full transition table.
- `server/test/domain.test.ts` (A): direct calls with a manual clock and `:memory:` or a temp file. Covers: fold order independence (several permutations give the same last_seen, first_seen and count); version vs rev (a fold bumps rev not version; ack after a fold with the old version succeeds); SLA (exactly 5:00, ack in time, escalation timing, deadline stamp, restart with a file DB); idempotency replay and 422; content duplicate; audit triggers reject UPDATE and DELETE.
- `server/test/api.test.ts` (B): real server on port 0 via `createTriageApp(config,{clock: manualClock, timers:false})`. Covers:
  - auth 401/403, cookie flags, logout, a role change applying immediately, last_admin;
  - 428/400/409 with `current`; **two concurrent acks: exactly one 200, the other 409** (`Promise.all`);
  - pagination stable under inserts between pages; filters including escaped `%` and `_`;
  - bulk ack per-item results;
  - SSE: hello, live events with ids, resume via Last-Event-ID giving exactly the missed events with no duplicates, resync when ahead or pruned;
  - an SLA breach broadcast on the stream; the audit feed; ingest validation (401, 400 listing problems, 415, future ts).
- `web/test/store.test.ts` (C1): the store against a stubbed global `fetch`. Covers: rev merge ignores stale; optimistic mutate rolls back on 409 to `current`; reverts on network error; stale generation responses are dropped after `setFilters`; membership insert and remove.
- `e2e/triage.spec.ts` (D): exactly one Playwright test. Two browser contexts: A = bob, B = alice.
  1. Create an incident via `/ingest`.
  2. Both deep-link to `/?q=<title>&sel=<id>`. Wait for B's `.conn` to show Live.
  3. B opens Resolve (pins v1).
  4. Start the timer **after A's ack response arrives** (`waitForResponse` on `/ack`). B's row must show `Acked`, and **elapsed must be < 1000ms**.
  5. B confirms → alert containing "changed while you were looking at it" and "rolled back". B's row shows `Acked`, not `Resolved`. The server says acked, version 2.
  - Config: port 5180, a temp DB seeded with 300 incidents in globalSetup, webServer `npm run build && node … server/src/index.ts`, `executablePath` from `TRIAGE_CHROMIUM`.

Commands that must pass: `npm run typecheck`, `npm test`, `TRIAGE_CHROMIUM=/opt/pw-browsers/chromium npm run test:e2e`.

---

## 7. Tooling (D)

- `tools/seed.ts`: `seedDatabase({dbPath, incidents=10000, endAt=now, seed})` runs the REAL ingest and `applyAction` under a manual clock. It is a discrete-event simulation over 2 days: 25% follow-up folds, 55% acked, 60% of those resolved, 30% assigned. It ends with `sweepSla`. CLI: `--reset`, `--count`, `--db`. Exits as a no-op if users already exist. Prints the demo logins.
- `tools/simulate.ts`: bursts to `/ingest` with out-of-order ts (up to 8 min old, shuffled), 25% exact duplicates, 10% Idempotency-Key retries sent twice. Prints outcome counts. Flags `--url --bursts --gap --services --seed`.
- `scripts/start.mjs`: `npm install` if `node_modules` is missing, `npm run build`, seed if the DB is missing, then run the server (PORT default 8080). `scripts/dev.mjs`: tsx watch API + Vite (proxy `/api`, `/ingest`, `/healthz` with `changeOrigin:false`).
- `README.md`: run, architecture, behaviour, trade-offs, ambiguities resolved (reference these decisions), known gaps, verification results.

---

## 8. File ownership

| Package | Owns |
| --- | --- |
| A server-domain | `server/src/{clock,config,errors,util,schema,db,hub,context,audit,passwords,users,auth,grouping,ingest,incidents,sla}.ts`, `server/test/{grouping,state-machine,domain}.test.ts` |
| B server-http | `server/src/{http,routes,sse,static,app,index}.ts`, `server/test/{helpers,api}.test.ts` (helpers may be `helpers.ts`) |
| C1 web-data | `web/src/{api,clock,store,realtime,session,router,toasts,format,messages}.ts`, `web/test/store.test.ts` |
| C2 web-ui | `web/index.html`, `web/src/main.tsx`, `web/src/styles.css`, `web/src/components/*.tsx` |
| D tooling | `tools/*`, `scripts/*`, `e2e/*`, `README.md`, plus cross-package integration fixes |

Do not touch files outside your package except to report a contract problem. Do not run `git commit`.
