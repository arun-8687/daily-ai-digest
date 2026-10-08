# Triage

A real-time incident board. Alerts come in over HTTP, get grouped into incidents, and responders
ack, resolve, reopen and assign them while every open browser sees the change live. TypeScript end to
end: React and Vite in the browser, Node on the server, SQLite for storage through the built-in
`node:sqlite` (`DatabaseSync`). There are no native modules and no paid services.

Requirements: Node 22.13 or later. The decision numbers below (D1 to D14) refer to `SPEC.md`, which is
the build spec. `shared/types.ts` and `shared/rules.ts` are the wire and rules contracts shared by the
server and the browser.

## Run

```sh
npm start                 # install if needed, build, seed if the DB is missing, serve on PORT (8080)
PORT=9000 npm start       # another port
TRIAGE_DB=/path/x.db npm start   # another database file (default data/triage.db)
```

Demo logins (password for all: `triage-demo`):

| Username | Role | Can |
| --- | --- | --- |
| `alice` | admin | everything, including role changes |
| `bob` | responder | ack, resolve, reopen, assign |
| `carol` | viewer | read and stream only |

Other commands:

```sh
npm run dev                          # tsx watch for the API, Vite dev server on 5173 (proxies /api, /ingest, /healthz)
npm run seed -- --reset --count 500  # rebuild a database with 500 base alerts (default 10000)
npm run simulate -- --bursts 3       # send alert bursts to a running server on 8080
npm run typecheck                    # tsc for the server and shared code, then the web code
npm test                             # vitest: server and web unit tests
TRIAGE_CHROMIUM=/path/to/chromium npm run test:e2e   # Playwright end-to-end test
```

Ingest an alert by hand:

```sh
curl -sS -X POST http://127.0.0.1:8080/ingest \
  -H 'Authorization: Bearer dev-ingest-token' -H 'Content-Type: application/json' \
  -d '{"source":"demo","fingerprint":"api/5xx","severity":"critical","title":"5xx spike on api","ts":'"$(date +%s%3N)"'}'
```

Environment variables: `PORT`, `TRIAGE_HOST` (default 127.0.0.1), `TRIAGE_DB`, `TRIAGE_INGEST_TOKEN`
(default `dev-ingest-token`), `TRIAGE_SESSION_HOURS` (default 12), `TRIAGE_COOKIE_SECURE=1`,
`TRIAGE_WEB_DIR` (`none` to disable serving the SPA), `TRIAGE_CHROMIUM` (e2e only).

## Architecture

```
shared/types.ts, shared/rules.ts   contracts: DTOs, enums, transition(), grouping windows, matchesFilters()
server/src/
  clock.ts          Clock interface (D14); manualClock for tests and the seed simulation
  config.ts         loadConfig(env) for the TRIAGE_* variables
  db.ts             Database: cached prepare, BEGIN IMMEDIATE transactions, WAL
  schema.ts         tables; triggers that make audit_log append-only (D7)
  context.ts        AppContext; transact() runs a write, then publishes events after COMMIT (D8)
  grouping.ts       decideGrouping(): fold, reopen, attach or create (D1)
  ingest.ts         parseAlert (D13), ingestAlert: idempotency (D2), dedupe, grouping, SLA start
  incidents.ts      list (D11), detail, applyAction (D4, D5), bulkAck
  sla.ts            sweepSla (D6), runMaintenance
  users.ts, auth.ts, passwords.ts   demo users, scrypt, sessions in sha256 form (D9)
  hub.ts, sse.ts    live subscribers, SSE with replay and resync (D12)
  routes.ts, http.ts, static.ts, app.ts, index.ts   HTTP surface, SPA fallback, lifecycle
web/src/
  api.ts, store.ts, realtime.ts, session.ts, router.ts, clock.ts, format.ts, messages.ts
                    client data layer: store merges by rev, mutate() is optimistic with rollback
  components/*.tsx  the board, drawer, dialogs, keyboard, login
tools/
  prng.ts           mulberry32 PRNG shared by the seed and simulator
  seed.ts           discrete-event simulation through the real ingest and action code
  simulate.ts       alert bursts against /ingest
scripts/
  lib.mjs, start.mjs, dev.mjs
e2e/
  playwright.config.ts, triage.spec.ts
```

The server holds all state in one SQLite file. Each write is one `BEGIN IMMEDIATE` transaction that
updates the incident, appends alerts and audit rows, and inserts events into the `events` table. Events
reach live subscribers only after COMMIT. The stream is resumable: a client reconnecting with
`Last-Event-ID` gets exactly the events it missed, or a `resync` when that is no longer possible.

## Behaviour

- **Ingest** (`POST /ingest`, Bearer token, D10). Alerts are validated as a whole (D13). Each one is either
  a duplicate (same fingerprint and content hash, D2), a fold into an unresolved incident seen within 10
  minutes (D1), a reopen of an incident resolved within 5 minutes, an attach to a recently resolved
  incident, or a new incident. Severity only ever escalates. `Idempotency-Key` retries replay the stored
  response, and a reused key with different content gets a 422.
- **Concurrency**. Mutations need `If-Match` with the incident's `version` (D5). `version` changes only on
  human actions and assignment. `rev` changes on every write and is what clients merge by (D4). A fold
  that lands while a responder is acking therefore does not cause a 409.
- **SLA**. A critical incident that stays open for five minutes is breached. The deadline is stamped, not
  the sweep time. The sweep runs every second and once at startup, so a restart resumes where it left off (D6).
- **Audit**. Every human action, assignment, escalation, reopen and breach writes an audit row with
  before and after snapshots. Routine folds are not audited (D7).
- **Live board**. Rows update within a round trip. A resolve against a stale version is rejected with the
  current state, and the client rolls the optimistic change back and says why (D5, D12).
- **Seeded demo**. `npm start` on a missing database, or one with no users, seeds 10,000 base alerts over
  two days. The simulation uses the real `ingestAlert`, `applyAction` and `sweepSla` under a manual clock,
  so the audit trail, versions, revs and SLA state are what the server would have produced.

## Ambiguities resolved

| Question | Resolution | Where |
| --- | --- | --- |
| What does `--count` mean in the seed? | The number of base alert arrivals. Follow-ups and folds are on top, so the resulting incident count is a little lower (299 incidents from 300 base alerts in the e2e seed). | `tools/seed.ts` |
| Do the seed's 2 days end now? | Yes. Actions scheduled after `endAt` are dropped, so incidents stay open rather than carrying future timestamps. | seed, D14 |
| When does the SLA sweep run during the seed? | Every simulated minute, plus once at the end. Breach stamps use the deadline, so the sweep cadence does not change the data (D6). | seed, D6 |
| Where is the e2e database seeded? | In the `webServer` command. Playwright 1.56 starts webServer plugins before `globalSetup`, so a seed in `globalSetup` would run after the server had already created its demo users, and would do nothing. | `e2e/playwright.config.ts` |
| Where does the e2e database live? | A fixed path under `os.tmpdir()`, deleted and rebuilt by every run. Override with `TRIAGE_E2E_DB`. | `e2e/playwright.config.ts` |
| How do the e2e users sign in? | `context.request` posts to `/api/auth/login`, and the cookie is stored in the browser context. This is quicker than typing into the form and exercises the same session path. | `e2e/triage.spec.ts` |
| How is the "under 1 second" check measured? | From the moment the `/ack` response arrives. Waiting uses `waitForFunction` (polled every animation frame), not `expect`, whose polling backoff would inflate the number. | `e2e/triage.spec.ts` |
| Which copy of a keyed retry is the "replay"? | Whichever arrives second. Bursts are shuffled, so the replay can be either send. The simulator counts whichever response carries `Idempotent-Replayed: true`. | `tools/simulate.ts`, D2 |
| Do simulator runs collide on Idempotency-Key? | No. Each run adds a random id to its keys, so a later run never reuses a key that the server still holds (keys live 24 hours). Before this, a second run got 422 `idempotency_key_reused` for every keyed alert. | `tools/simulate.ts`, D2 |
| Does the simulator report server errors? | Yes. Any transport error, 4xx or 5xx makes it exit 1. Its alerts are all valid, so a 4xx always means a fault in the tool or the server. | `tools/simulate.ts` |
| Does `start` re-seed a database that exists but has no users? | Yes, it seeds when the file is missing or has no users (an empty file, for example). A database with users is left alone, even one left by an older interrupted seed; pass `--reset` to rebuild it. The seed is built at `<db>.seeding` and renamed into place only when complete, so a file at the database path is always a finished seed. | `scripts/lib.mjs`, `tools/seed.ts` |
| Where do relative `TRIAGE_DB` paths resolve? | Against the project root for `npm start` and `npm run dev`. The server itself resolves them against its working directory, which is the root under npm. | `scripts/lib.mjs` |

## Trade-offs

- **Seeding goes through the real code path.** It is slower than inserting rows directly: 10,000 base
  alerts take about 8 seconds, and 300 take well under a second. In return, the audit trail, version
  and rev counters, and SLA state are exactly what the server would have written.
- **WAL with `synchronous = NORMAL` during seeding only.** Seeding makes about 30,000 small transactions.
  This setting skips an fsync per commit. Only the seeding connection uses it. The server keeps SQLite's
  default. A crash, Ctrl-C or power cut mid-seed leaves only `<db>.seeding` (and its `-wal` and `-shm`
  files). The next run deletes those and seeds again, so no partial database is ever accepted.
- **Seeded critical incidents are already breached.** About 30% of seeded incidents are critical, and
  many of them were never acked. The first sweep stamps those breaches, so a fresh board shows SLA
  breaches straight away. That is realistic and visibly busy.
- **`npm start` always runs `npm run build`.** It takes about 2 seconds and keeps the served bundle in
  step with the source. The alternative was a stale bundle after a pull.
- **One e2e test.** The spec asks for exactly one. It covers the core promise, a stale resolve rejected
  with a clear rollback and a live update in the other browser. It does not cover login forms, filters or
  keyboard navigation.
- **Simulator duplicates are order-dependent.** An exact duplicate is labelled `duplicate` only when the
  original arrives first. Shuffling is deliberate, because it is what real out-of-order sources do.

## Known gaps

- **An older open incident is never auto-resolved** (D1, documented gap). A fingerprint that stops firing
  leaves its incident open until a human resolves it.
- **Title search folds case only for ASCII** in SQL `LIKE`. The client's live membership check uses Unicode
  case folding, so a non-ASCII title can match on the client but not in the server's list (`incidents.ts`).
- **The seed does not exercise every branch.** `attached` was 0 in every seed run below, and `reopened`
  was 0 in the 300-alert e2e seed (5 in the 10,000-alert default seed). The attach path is covered by the
  domain and API tests, not by the seeded data.
- **The e2e timing assertion runs on loopback.** The measured latency was 18 to 35 ms across the runs
  recorded below. Heavy CPU contention could still make the 1000 ms budget flaky.
- **Chromium is not bundled.** The e2e run needs `TRIAGE_CHROMIUM` set to an installed Chromium, or a
  Playwright browser installed separately.
- **`dev` does not rebuild the bundle.** It runs the API with `tsx watch` and Vite for the browser, so the
  production bundle in `web/dist` can drift until the next `npm run build` or `npm start`.

## Verification

Run from the project root on the final code. Output is copied from the runs. Scratch databases and
logs were kept under the session scratch directory, not in the project.

`npm run typecheck`: exit 0. `tsc -p tsconfig.json` and `tsc -p web/tsconfig.json` are both clean.

`npm test`: exit 0.

```
 ✓ server/test/domain.test.ts (48 tests)
 ✓ server/test/state-machine.test.ts (27 tests)
 ✓ server/test/grouping.test.ts (22 tests)
 ✓ web/test/store.test.ts (44 tests)
 ✓ server/test/api.test.ts (61 tests)
 Test Files  5 passed (5)
      Tests  202 passed (202)
```

`TRIAGE_CHROMIUM=/opt/pw-browsers/chromium npm run test:e2e`: exit 0.

```
[WebServer] > vite build
[WebServer] ✓ built in 1.97s
[WebServer] Seeded 300 base alerts over two days (seed 1) in 0.35s
[WebServer]   incidents created    299
[WebServer] Triage listening on http://127.0.0.1:5181
[e2e] B's row showed Acked 35ms after A's /ack response
  ✓  1 e2e/triage.spec.ts:20:1 › a stale resolve is rolled back when another responder has acked the incident (817ms)
  1 passed (5.7s)
```

Burst simulator, run three times against one server on a spare port (`tools/simulate.ts --bursts 2 --gap 300`).
Before the fix, the second run got 16 responses of `422 idempotency_key_reused` and still exited 0. The first
run's output, copied:

```
Burst 1: 55 sends (10 duplicates, 5 key retries): 202 created x19, 202 folded x21, 202 duplicate x10, 202 replayed x5
Burst 2: 51 sends (7 duplicates, 4 key retries): 202 folded x35, 202 created x5, 202 duplicate x7, 202 replayed x4

Outcomes by HTTP status and action (106 requests in 0.4s)
  202 folded                             56
  202 created                            24
  202 duplicate                          17
  202 replayed                            9
```

All three runs exited 0 with no 4xx, and the second and third runs had no 422s. With `TRIAGE_INGEST_TOKEN=wrong`
the same tool sent 55 requests, got 55 `401 bad_ingest_token`, printed the failure count, and exited 1.

Seed interruption: `tools/seed.ts --count 4000` stopped with SIGINT after about 2.5 s. The target path was never
created; only `<db>.seeding`, `-wal` and `-shm` were left. A rerun removed them and seeded a complete database.
A second run printed `Already seeded (3 users, 299 incidents)` and changed nothing. A zero-byte file at the target
path was replaced by a complete seed.

`npm start` on a fresh database (`TRIAGE_DB` under the scratch directory, `PORT=5210`):

```
No seeded database at …/triage.db; seeding a demo database (10,000 incidents, about 10 seconds).
Seeded 10000 base alerts over two days (seed 1) in 7.70s
  incidents created    9937   folded / attached 2567 / 0   reopened 5
  SLA breaches         3000   skipped (already illegal) 0
Triage listening on http://127.0.0.1:5210
```

`/healthz` and `/` returned 200. SIGTERM to the launcher stopped the server, and the launcher exited 0. The
launcher printed no SQLite ExperimentalWarning. A second `npm start` on the same database skipped seeding and
served normally.

`npm run dev` on spare ports (`PORT=5211`, Vite on 5173): `/healthz`, `/` and the login POST through the Vite
proxy all returned 200. SIGTERM to the parent stopped both children.
