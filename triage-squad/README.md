# Triage

A real-time incident board. Alerts arrive over HTTP, get grouped into incidents, and responders ack, resolve, reopen and assign them. Every open browser sees each change live. TypeScript end to end: React and Vite on the front, Node on the back, SQLite for storage. There are no paid services and no native modules.

## Run

Requires Node 22.13 or newer. The database is the built-in `node:sqlite`.

```sh
npm start
```

`npm start` installs dependencies if `node_modules` is missing, builds the web app, seeds `data/triage.db` with 10,000 incidents of demo history if that file is missing, then runs the server on <http://127.0.0.1:8080>. Set `PORT` to change the port. An existing database is never touched.

Demo logins (password `triage-demo`):

| User | Role | Can |
| --- | --- | --- |
| `alice` | admin | everything, plus change roles |
| `bob` | responder | ack, resolve, reopen, assign |
| `carol` | viewer | read and stream only |

Development, with the API under `tsx watch` and Vite on <http://127.0.0.1:5173> (Vite proxies `/api`, `/ingest` and `/healthz`):

```sh
npm run dev
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run seed -- --reset --count 10000` | Rebuilds the database. Flags: `--db PATH`, `--count N`, `--seed S`, `--reset`, `--force`. Without `--force` it is a no-op when users exist. |
| `npm run simulate -- --url http://127.0.0.1:8080 --bursts 20` | Sends alert bursts to a running server. Flags: `--url`, `--bursts`, `--gap MS`, `--services N`, `--seed S`. |
| `npm run typecheck` | Typechecks the server, shared, tools and e2e (`tsconfig.json`), then the web app (`web/tsconfig.json`). |
| `npm test` | Vitest: grouping, state machine, domain, HTTP API and SSE, and the web store. 153 tests. |
| `npm run test:e2e` | The Playwright race test. Set `TRIAGE_CHROMIUM` to use a preinstalled Chromium. |
| `npm run check` | All three of the above. |

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `TRIAGE_HOST` | `127.0.0.1` | Bind address. |
| `TRIAGE_DB` | `data/triage.db` | SQLite file. Created with its parent directory if missing. |
| `TRIAGE_INGEST_TOKEN` | `dev-ingest-token` | Bearer token for `POST /ingest`. Change it outside development. |
| `TRIAGE_SESSION_HOURS` | `12` | Session lifetime (D9). |
| `TRIAGE_COOKIE_SECURE` | unset | Set to `1` to add `Secure` to the session cookie. |
| `TRIAGE_WEB_DIR` | `web/dist` | Built SPA directory. `none` turns static serving off. |
| `TRIAGE_API` | `http://127.0.0.1:8080` | Where the Vite dev proxy sends API calls. |
| `TRIAGE_CHROMIUM` | unset | Chromium executable for the e2e run. |

## Architecture

```
shared/types.ts   wire types (contract)
shared/rules.ts   pure rules: state machine, grouping windows, roles, filters (contract)
server/src/       Node HTTP server, SQLite domain logic, SSE hub
web/src/          React client: store (rev/version merge), realtime, session, UI
tools/            seed (discrete-event history), simulate (HTTP alert bursts), random (seeded PRNG)
scripts/          start.mjs (npm start), dev.mjs (npm run dev), lib.mjs (shared helpers)
e2e/              Playwright race test, its global setup and config
```

Server modules, one responsibility each: `db` (node:sqlite wrapper, `BEGIN IMMEDIATE`), `schema` (tables and append-only audit triggers), `context` and `Unit` (a write and its events, published after COMMIT), `grouping` (pure D1 decision), `ingest` (validation D13, content dedupe and idempotency D2, grouping), `incidents` (list, detail, `applyAction` with optimistic concurrency D4/D5, bulk ack), `sla` (breach sweep D6, maintenance), `auth` and `users` (scrypt, sessions, roles D9), `sse` and `hub` (live stream D12), `routes` and `http` (endpoints, Origin check, If-Match), `app` and `index` (wiring, timers, shutdown).

Every write runs in one `BEGIN IMMEDIATE` transaction. Its audit rows and its events are written inside that transaction. Events are published to live subscribers only after COMMIT (D8).

## Behaviour

- **Grouping (D1).** An alert with the same fingerprint folds into an open or acked incident whose `last_seen` is within 10 minutes. It reopens the most recent resolved incident if it lands within 5 minutes of that resolve. It attaches to a resolved incident without changing status if it is older than the resolve by more than 5 minutes. Otherwise it creates an incident.
- **Two counters (D4).** `version` moves only on ack, resolve, reopen and assignment. It is the If-Match token. `rev` moves on every write and is what clients merge by. So a fold that lands while a responder acks does not cause a 409.
- **Optimistic concurrency (D5).** Mutations need `If-Match`. Order of checks: auth, existence, version, legality. A stale version gets a 409 `version_conflict` with the current incident in the body.
- **SLA (D6).** A critical incident that stays open for 5 minutes is breached. The breach is stamped at the deadline, not at the sweep time. The sweep runs every second and once at startup, and its state is in SQLite, so restarts resume correctly.
- **Idempotency (D2).** `Idempotency-Key` replays the stored response for 24 hours when the body matches, and returns 422 when it does not. Identical content for the same fingerprint is a `duplicate` and changes nothing.
- **Live stream (D12).** `GET /api/stream` replays from `Last-Event-ID`, or sends `resync` when the id is too old or too far ahead. Replay and subscription happen in one synchronous block, so nothing is missed or duplicated.
- **Client (C1, C2).** The store merges by `rev`. Ack, resolve and assign are optimistic and roll back to the server's `current` on a 409. The resolve dialog pins the version it opened with, so a stale confirm is rejected rather than silently overwriting someone else's ack. A live event that arrives while an ack is in flight keeps the ack on the row. A reconnect that carries `Last-Event-ID` relies on the server's replay and does not refetch the list.

## Ambiguities resolved

These are the calls I made where the spec left room. All of them follow from the numbered decisions.

- **Seed is a real simulation (7).** Every alert goes through `parseAlert` and `ingestAlert`, and every human action through `applyAction`, under a manual clock set to each event's time. Nothing writes SQL directly, so the seeded history obeys the same rules as live traffic. Events scheduled after the end of the window are dropped, so those incidents stay in flight.
- **Breach stamping in the seed.** The seed sweeps once per simulated minute, and any action on an incident whose deadline has passed sweeps first. That matches a 1-second sweep, because breaches are stamped at the deadline (D6).
- **Seed assignees and actors.** Acks and resolves are made by responders (`alice`, `bob`). Assignees can be any user. Assignment always happens before the ack, so it is always legal.
- **e2e seeding runs after the server starts.** Playwright starts `webServer` before `globalSetup`. The server therefore creates the demo users first, and a normal seed would exit as a no-op. `global-setup.ts` runs `tools/seed.ts --force` against the database the server already has open. WAL mode lets the two share the file.
- **Fresh e2e database per run.** `playwright.config.ts` clears `data/e2e/` in the runner and exports `TRIAGE_E2E_DB`. Workers inherit it, so the server, the seed and the tests all use one file.
- **The simulator does not add an auth flag.** It reads `TRIAGE_INGEST_TOKEN`, the same variable the server reads. A flag would add a second place to set the secret.
- **Titles follow the newest alert.** The seed's follow-up alerts carry a `(still firing)` suffix, so the title change on fold is visible in the data (D1).
- **Source and fingerprint are not trimmed.** Only the title is trimmed (D13), because the fingerprint is the grouping identity.

## Trade-offs

- **`node:sqlite` is experimental.** It prints a warning on every start. The scripts pass `--disable-warning=ExperimentalWarning`. In exchange there are no native modules, so `npm install` works everywhere Node does.
- **Single writer.** SQLite serializes writes with `BEGIN IMMEDIATE` and a 5-second busy timeout. Measured here: the 10,000-incident seed runs in about 6 seconds, and the 643-request simulator burst takes about 4 seconds. This design does not scale across machines.
- **SSE, not WebSockets.** A one-way event stream is enough, reconnects with `Last-Event-ID` are simple, and it runs through a plain HTTP server with no extra dependency.
- **Two counters instead of one.** `version` gives responders a precise conflict signal. `rev` keeps live merging cheap and prevents machine noise from invalidating human writes. The cost is that clients must understand both.
- **Events are retained, not compacted.** The newest 100,000 events are kept for replay (D8). A client that falls further behind gets `resync` and refetches.
- **Virtualized list with fixed 76 px rows.** It keeps the DOM small at 10,000 incidents. Variable-height rows would need a different measurement strategy.
- **One extra first-page request after login.** The stream opens after the initial list request, so events in between would be missed. One resync closes that gap, 500 ms after the stream opens (requests inside that window share one call). Reconnects that carry an id skip it, because the server replays what they missed.

## Known gaps

- **Older open incidents are never auto-resolved (D1).** A fingerprint that stops alerting leaves its incident open until a responder resolves it.
- **Sessions are bearer cookies, not tokens bound to the device.** The Origin check covers cross-site unsafe requests. There is no CSRF token, and no rate limiting on login beyond the scrypt cost.
- **Demo passwords are fixed.** `triage-demo` is for local use only. Change the users before any shared deployment.
- **One process.** SSE subscribers and the SLA sweep live in one Node process. Running two processes against one file would give each its own hub, so clients would miss events published by the other.
- **The seed's sweep granularity is one simulated minute.** The breach times are exact, but the audit ordering within a simulated minute is approximate.
- **e2e needs a Chromium.** Set `TRIAGE_CHROMIUM`, or let Playwright use its own browser.
- **`npm start` rebuilds the web app every time.** The build takes about 2 seconds, which is simpler than tracking staleness.
- **Resync keeps only the first 1,000 rows (SPEC 4).** After a long scroll, a resync returns the list to that window, and selected rows below it are cleared. The rows reload when the user scrolls back down. Keeping the older rows would need a cursor carried across resyncs.
- **A head response can drop an older row.** When a first-page or resync response lands after a live event for an incident older than its first row, the row can drop out of the list until the next resync. The window is the length of that one request.
- **Clock offset from stream frames has no round-trip correction.** `hello` and `ping` use their arrival time for both ends of the sample, so the estimate carries one-way latency as a small bias. JSON API responses are midpoint-corrected.

## Verification

Run on Node 22.22.0 in this repository, after the integration pass that fixed the final review's findings. Exact results:

- `npm run typecheck`: exit 0 for both `tsconfig.json` and `web/tsconfig.json`.
- `npm test`: 5 files, 153 tests passed. One test was added in this pass: a live fold no longer hides an ack that is still in flight.
- `TRIAGE_CHROMIUM=/opt/pw-browsers/chromium npx playwright test -c e2e/playwright.config.ts`: 1 test passed in each of three runs on the final code. The live ack reached Alice 57, 34 and 38 ms after Bob's ack response, against a 1000 ms budget. The test now also waits for Bob's stream to show Live before his ack.
- Reconnects, measured with a Playwright probe against a scratch server on port 5391 (the probe is not in the repository):
  - Six offline/online flaps: 0 list requests and 6 stream reconnects, each with `lastEventId`. The final review measured 36 list requests for the same pattern on the previous build. An incident created while the browser was offline appeared after reconnect.
  - Server stopped and started again while the page was open: the status read `Reconnecting…` while it was down, then Live. The page made one stream request with `lastEventId` and no list request. An incident created after the restart appeared.
  - Login makes two first-page requests: the initial load, then the one resync that closes the gap before the stream opened.
- Server results carried over from the previous run. No server code changed in this pass: seed of 10,000 incidents into a scratch database in 5.76 s, with 10,000 created, 2,487 folded, 5,467 acked, 3,213 resolved, 3,099 assigned, 3,299 SLA breaches and 0 rejected. Re-running without `--reset` is a no-op with the demo logins printed.
- Simulator against a running server (20 bursts): 643 requests in 4.3 s, no transport or HTTP errors. Created 24, folded 503 (including 47 replays), duplicate 116. The database passed `PRAGMA integrity_check`, with 480 alerts and 47 idempotency keys, which matches the outcome counts.
- `npm start` with `TRIAGE_DB` pointing at a missing scratch path and `PORT=8097`: `/healthz` answered after about 8 seconds, including the 1.7 s build and the 5.1 s seed. Stopping the `start.mjs` process by PID stopped the server too, and left no processes behind.
- `npm run dev`: the Vite proxy answered `/healthz` in about 1 second, and the index page returned 200. Stopping it by PID left no processes behind.
