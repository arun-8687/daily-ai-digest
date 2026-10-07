# Triage: a real-time incident board

Alerts come in over HTTP, fold into incidents, and show up live in every open browser. People ack, assign, and resolve them. Every change is audited, and critical incidents breach their SLA even across a server restart.

TypeScript end to end: React and Vite on the front, Node and SQLite on the back. No paid services, and no native modules to compile.

## Run it

Requires **Node 22.13 or newer**. The database is the built-in `node:sqlite`.

```bash
npm start
```

That one command installs dependencies (first run only), builds the web app, seeds a demo database (10,000 incidents, 3 users, about 7 seconds), and serves everything on <http://127.0.0.1:8080>. Set `PORT` to change the port.

| Login | Role | Can do |
| --- | --- | --- |
| `alice` | admin | everything, including changing other users' roles |
| `bob` | responder | ack, resolve, reopen, assign, bulk ack |
| `carol` | viewer | read only |

Password for all three: `triage-demo`.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | API with auto-restart, plus Vite with hot reload on <http://localhost:5173> (`/api` is proxied) |
| `npm run simulate` | Fires bursts of alerts at a running server. They include duplicates, out-of-order timestamps, and retries that reuse an `Idempotency-Key`. Options: `--bursts`, `--gap`, `--services`, `--url`. |
| `npm run seed -- --reset` | Rebuilds the demo database (`--count N` for a different size) |
| `npm test` | Unit and API tests (62) |
| `npm run test:e2e` | Playwright, two browser sessions (1) |
| `npm run check` | Typecheck, then unit, API, and e2e tests |

The e2e suite uses Playwright's Chromium. To reuse an installed one, set `TRIAGE_CHROMIUM=/path/to/chrome`.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `TRIAGE_HOST` | `127.0.0.1` | Bind address. Binding wider than localhost needs a reverse proxy with TLS. |
| `TRIAGE_DB` | `data/triage.db` | SQLite file |
| `TRIAGE_INGEST_TOKEN` | `dev-ingest-token` | Bearer token for `POST /ingest`. **Set this before you expose the server.** |
| `TRIAGE_SESSION_HOURS` | `12` | Session lifetime |
| `TRIAGE_COOKIE_SECURE` | unset | Set to `1` behind HTTPS so the session cookie gets the `Secure` flag |

## Architecture

```
  monitors ──POST /ingest (bearer)──▶ ingest pipeline ──┐
                                                         ▼
                       transact(): BEGIN IMMEDIATE ─ domain writes + audit + events ─ COMMIT
                                                         │ publish only after COMMIT
  browsers ◀── SSE /api/stream ◀── hub ◀─────────────────┘
     │   (Last-Event-ID replay)        events table = the replay log
     └── REST /api/incidents ──(If-Match)──▶ incident services ──▶ SQLite (WAL)
```

```
shared/          wire types and pure rules (state machine, filter matching, thresholds)
                 imported by both sides, so the client's affordances match server enforcement
server/src/
  grouping.ts    pure fold / reopen / attach / create decision
  ingest.ts      validation, content dedupe, Idempotency-Key, grouping apply
  incidents.ts   reads, cursor list, transitions with If-Match, bulk ack
  sla.ts         breach sweep (state lives in SQLite) and housekeeping
  audit.ts       append-only log (triggers block UPDATE and DELETE)
  auth.ts, users.ts, passwords.ts   sessions (hashed tokens), roles, scrypt
  sse.ts, hub.ts                    replay + live stream with the same sync block
  routes.ts      route table. Every role check lives here.
web/src/
  store.ts       incident store: monotonic versions, per-row subscriptions, optimistic mutations
  realtime.ts    EventSource manager: watchdog, backoff, resync on return
  components/    virtualized listbox, drawer, dialogs, keyboard map
tools/           seed (drives the real domain code under a simulated clock), simulator
e2e/             Playwright two-session test
```

**Core invariant.** The server is single-threaded, and every write runs inside `BEGIN IMMEDIATE`. So state versions, event sequence numbers, and audit ids are assigned in commit order. An event is written to the `events` table inside the same transaction as the change, and it is published to live subscribers only after `COMMIT`. A client can never see an event for a change that was rolled back.

## Behaviour

**Grouping** (`server/src/grouping.ts`). Each alert has a source timestamp `ts`. Grouping compares `ts`, not arrival time.

1. Fold into an unresolved incident (open or acked) with the same fingerprint when `|ts − last_seen| ≤ 10 min`. This is symmetric, so late alerts fold too. If several match, the most recent one wins.
2. Otherwise, if the latest resolved incident was resolved within 5 minutes of `ts`, reopen it. Both sides count, so a late delivery of a flap also reopens.
3. Otherwise, if `ts` is more than 5 minutes before that resolve and within 10 minutes of its last alert, attach it as a late alert. Its state does not change.
4. Otherwise, create a new incident. A later alert always starts a new one.

`last_seen` only ever moves forward. The title and source follow the newest alert by `ts`, so a late alert cannot overwrite what the board shows for current activity.

**State machine** (`shared/rules.ts`). `open → acked → resolved`, `resolved → open` (reopen). Resolve is also allowed straight from `open`. Assign is metadata and is legal on any unresolved incident. Anything else returns `409 illegal_transition` with the current record.

**Optimistic concurrency.** Every incident has a `version` that increments on every write. Mutations must send `If-Match: "<version>"`. Missing returns `428`. Malformed returns `400`. Stale returns `409 version_conflict` with `current`, the server's copy of the incident. The checks run in this order: exists (404), version (409), transition legal (409). A stale write is rejected even when it would also have been illegal.

**SLA.** A critical incident that is open and unacked for 5 minutes is marked breached. The clock starts when we receive the alert, not at the source timestamp, so a skewed source cannot make an incident look overdue. Escalating to critical starts the clock. Ack or resolve stops it. Reopening restarts it. The breach is stamped at its deadline, not at the moment the sweep noticed it, so a breach discovered late still reports when it was due. The sweep runs every second against a partial index. State lives in SQLite, so after a restart the first sweep applies whatever came due while the server was down. The test suite covers this.

**Audit.** Lifecycle changes, assignments, role changes, logins, and SLA breaches each write a row with actor, action, and before and after snapshots. Routine alert folds are not audited, because the `alerts` table already records them. Triggers make `UPDATE` and `DELETE` on `audit_log` fail at the database level. A test checks this.

**Live stream.** `GET /api/stream` is Server-Sent Events. Every event carries `id: <events.seq>`.

- A reconnect sends `Last-Event-ID` (EventSource does this automatically), or `?lastEventId=` for a manual reconnect. The server replays exactly the events after that id. Replay and subscription happen in one synchronous block, so nothing is missed or duplicated between them.
- If the gap cannot be replayed (pruned, more than 5,000 events, or an id from a different database), the server sends `resync` and the client refetches.
- A `ping` every 15 s keeps the connection honest. The session is re-checked on each ping, so a revoked login ends the stream.
- A client that falls more than 1 MB behind is disconnected and resumes from its last id.

**Lists.** `GET /api/incidents` pages with an exclusive keyset cursor on `id` (newest first). Ids only increase, so inserts land at the top and cannot shift a page the user is reading. The test suite inserts between page requests and checks for no duplicates and no gaps. Filters are status, severity, assignee (or `none`), and title substring, with `%` and `_` escaped. `total` is returned on the first page only.

**Auth.** Passwords use scrypt. Sessions are random 256-bit tokens. The database stores only their SHA-256, and the cookie is `HttpOnly; SameSite=Lax`. Roles are checked on every request, so a role change takes effect on the next call. Cross-origin writes are blocked by an `Origin` check, and the Lax cookie means a cross-site POST carries no session. Machine ingest uses a separate bearer token and never a session.

**Ingest.** `POST /ingest` requires `Content-Type: application/json` and a 64 KB body limit. Validation returns every problem at once. A `ts` more than 60 s in the future is rejected. An `Idempotency-Key` header replays the first response (`Idempotent-Replayed: true`). Reusing the key with a different body returns `422`. The stored response is written in the same transaction as the alert, so a retry can never double-apply.

**Client.**

- *Live list.* A virtualized listbox keeps about 20 rows in the DOM, whatever the size of the list. Each row subscribes to its own entry, so a live update re-renders only that row.
- *Versions.* A version that is not newer than the local one is ignored. Older events and responses cannot overwrite newer state.
- *Optimistic writes.* Ack, assign, and resolve show immediately. On `409` the server's copy replaces the local one and the toast says what changed and who did it. On other failures the change is undone.
- *Resolve confirmation.* The dialog pins the version the reviewer opened, so a change made while they were looking is rejected. This is the stale-write case the brief describes.
- *Bulk ack.* Each item is its own transaction, so one failure never affects the others. A report lists every failure. Failed items stay selected for retry.
- *SLA countdown.* It runs on server time. Each response contributes to a smoothed clock offset.
- *URL state.* Filters and the open drawer live in the query string. Back and forward restore them.
- *Resync.* After a reconnect, when a hidden tab comes back, or when the network returns, the client refetches the loaded window and the open drawer.

Keyboard, when focus is not in a field: `j`/`k` move, `Enter` opens, `a` acks, `r` resolves (with confirmation), `x` or `Space` selects, `Shift+A` bulk-acks the selection, `/` searches, `Esc` closes or clears, `?` lists the keys. The listbox uses `aria-activedescendant`, `aria-selected`, and `aria-multiselectable`. The drawer and dialogs manage focus, and status changes are announced through live regions.

## Trade-offs

- **SQLite in one process.** This keeps the system transactional and zero-config, and the whole write path is one serial lane. The cost is that it does not scale horizontally. The `events` table is already a durable log, so multiple instances would need a shared store with polling or change notification in place of the in-process hub.
- **`node:sqlite` over `better-sqlite3`.** There are no native builds and no prebuilt-binary downloads. The module still carries an experimental warning in Node 22, which the scripts silence. If a future Node drops the warning, nothing else changes.
- **Runtime TypeScript via `tsx`.** There is no separate compile step, which keeps `npm start` simple. The cost is a slightly slower cold start.
- **Ordering by creation, not by activity.** Sorting by last activity would make rows jump while you read, and it would break stable cursor pagination. The trade-off is that a busy older incident sits lower in the list. Filters and search are the way to find it.
- **Synchronous database calls.** They keep the code simple and each transaction short. Bulk ack is capped at 500 items and runs as independent transactions, so no call holds the event loop for long.
- **SLA by sweep, not per-incident timers.** The sweep is cheap via the partial index, and it survives restarts with no timer drift.
- **`LIKE` search.** A substring scan is fine at 10k rows. Millions of rows would want FTS5.
- **Event retention of 100k.** Clients that fall further behind resync rather than replay.

## Ambiguities I resolved

1. "Open incident" in the grouping rule means unresolved (open or acked). Acking does not stop an incident from absorbing alerts.
2. Resolve is allowed from `open`. The brief lists `open → acked → resolved`, but auto-recovering alerts should not need a human ack, and the "stale resolve" scenario only makes sense if an incident can be resolved while it is still open.
3. A quiet gap of more than 10 minutes starts a new incident, and the old one stays open. Nothing auto-resolves. Auto-resolve would hide real work.
4. Late alerts fold in either direction within the window, and `last_seen` never moves backwards.
5. The 5-minute flap window is measured from `ts` to the resolve time. Alerts from before a resolved episode attach without reopening it.
6. The SLA clock starts at receipt. It is stamped at its deadline and restarts on reopen or escalation.
7. Ingest auth is a bearer token, not a session. Roles apply to people. The role check on ingest is the token itself.
8. Duplicates without a key are detected by content (same fingerprint, timestamp, and body) and do not inflate counts. An `Idempotency-Key` gives the stronger guarantee that a retry returns the first response.
9. Timestamps are epoch milliseconds or ISO-8601 strings. A `ts` more than 60 s ahead of server time is rejected.
10. Roles: viewers read. Responders act. Admins manage roles, and the last admin cannot be demoted.
11. Bulk ack is per item with independent transactions. It is not all-or-nothing.
12. A new incident goes to the top of the list because of creation order, which is also what keeps pagination stable.

## Known gaps

- No login throttling, lockout, or password change. The demo accounts use a shared password.
- No user management UI. Role changes go through `PATCH /api/users/:id` by admins.
- Single process. The live hub is in memory.
- No TLS termination. Put a reverse proxy in front and set `TRIAGE_COOKIE_SECURE=1`.
- No CSRF tokens. The Lax cookie, the JSON content type, and the `Origin` check cover the same-origin app, but a token would be the belt-and-braces option.
- No outbound notifications (pager, email, chat). Only the in-app board and the SLA toast.
- Audit grows with lifecycle activity, and there is no archival.
- `total` is exact only on the first page, and between resyncs the count is approximate.
- Rows are a fixed 76 px, so long titles are truncated in the list. The drawer shows the full title.
- Keyboard range selection is not implemented. Ctrl/Cmd-click and `x` toggle individual rows.
- Dates use the browser's locale. There is no i18n.
- The e2e suite contains the one required two-session test. Other behaviour is covered by the API tests and by manual checks.
- On first load, the browser logs a 401 for the signed-out session check. That is expected and harmless.

## Verification

Run on Node 22.22 with Chromium 141:

- `npm run typecheck`: clean, both projects.
- `npm test`: 62 passing. Grouping boundaries (inclusive at exactly 10 and 5 minutes, and one millisecond past), every fold order of a window of alerts, the state-machine table, concurrent acks where exactly one wins, idempotency and content dedupe, pagination stable under inserts, filters with escaped wildcards, SSE resume with no duplicates and resync on gaps, SLA breach at exactly 5 minutes, breach through a restart, escalation timing, bulk ack per item, role enforcement, the last-admin guard, and append-only audit triggers.
- `npm run test:e2e`: the two-session scenario passes. A acks. B sees the ack within 1 second. B's stale resolve is rejected with `409`, the optimistic change is rolled back, and the server still shows the incident acked at version 2.

Manual checks, in headless Chromium: a 10,000-row list at 1280 px and at 380 px, with no horizontal scroll. Keyboard flows, including ack-then-navigate and bulk ack with its report. Going offline and back online, where an incident created during the outage appeared after reconnect. The simulator against an open board, where 10 new incidents appeared in the count and no page errors were logged.
