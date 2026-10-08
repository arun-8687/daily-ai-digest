// Seeds a Triage database by running the real ingest and action code under a manual clock.
//
// A discrete-event simulation over two days (SPEC section 7): base alerts arrive at random times,
// 25% of them get a follow-up alert with the same fingerprint (a fold), 55% of created incidents are
// acked, 60% of those are resolved, and 30% are assigned. Events run in time order from a priority
// queue; every write goes through ingestAlert / applyAction, so the audit trail, versions, revs and
// SLA state are exactly what the server would have produced. sweepSla runs every simulated minute
// and once at the end.
//
// Idempotent: a database that already has users is left alone unless reset is set. The database is built
// at <db>.seeding and renamed into place when complete, so an interrupted run never leaves a partial
// database that a later run would accept.
//
// CLI: node --disable-warning=ExperimentalWarning --import tsx tools/seed.ts [--reset] [--count N] [--db PATH] [--seed N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Actor } from '../server/src/audit';
import { loadConfig } from '../server/src/config';
import { type ManualClock, manualClock, systemClock } from '../server/src/clock';
import { type AppContext, closeContext, createContext } from '../server/src/context';
import { HttpError } from '../server/src/errors';
import { type AlertInput, ingestAlert } from '../server/src/ingest';
import { applyAction, loadIncidentRow } from '../server/src/incidents';
import { sweepSla } from '../server/src/sla';
import { DEMO_PASSWORD, DEMO_USERS, ensureDemoUsers } from '../server/src/users';
import { type IngestResponse, type Severity } from '../shared/types';
import { createRng, type Rng } from './prng';

export interface SeedOptions {
  dbPath: string;
  /** Base alert arrivals to simulate. Default 10000. */
  incidents?: number;
  /** End of the two-day window (epoch ms). Default: now. */
  endAt?: number;
  /** PRNG seed. The same seed and window give the same data. Default 1. */
  seed?: number;
  /** Delete the database files before seeding. Default false. */
  reset?: boolean;
}

export interface SimStats {
  /** Alerts ingested (base arrivals plus follow-ups). */
  alerts: number;
  created: number;
  folded: number;
  reopened: number;
  attached: number;
  followUps: number;
  acked: number;
  resolved: number;
  assigned: number;
  /** Scheduled actions that were no longer legal when they ran (for example, already resolved). */
  skipped: number;
  /** SLA breaches stamped by sweepSla. */
  breaches: number;
}

export interface SeedResult {
  seeded: boolean;
  dbPath: string;
  durationMs: number;
  /** Null when the database already had users and was left alone. */
  stats: SimStats | null;
  incidents: number;
  users: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WINDOW_MS = 2 * DAY_MS;
const SWEEP_EVERY_MS = MINUTE_MS;

/** Target rates from SPEC section 7. */
export const RATES = {
  followUp: 0.25,
  acked: 0.55,
  resolvedAfterAck: 0.6,
  assigned: 0.3,
} as const;

const SERVICES = ['checkout', 'payments', 'search', 'auth', 'catalog', 'notifications', 'ingest', 'billing', 'reports', 'edge-cdn'] as const;
const CHECKS = [
  { key: 'http-5xx', title: 'HTTP 5xx rate elevated' },
  { key: 'latency-p99', title: 'p99 latency above SLO' },
  { key: 'queue-depth', title: 'Queue depth growing' },
  { key: 'error-logs', title: 'Error log spike' },
  { key: 'disk-usage', title: 'Disk usage high' },
  { key: 'cert-expiry', title: 'TLS certificate expiring' },
] as const;
const REGIONS = ['eu-west-1', 'us-east-1', 'ap-south-1'] as const;
const SOURCES = ['prometheus', 'cloudwatch', 'synthetics'] as const;
const RESPONDERS: Actor[] = DEMO_USERS.filter((u) => u.role !== 'viewer').map((u) => ({ id: u.id, name: u.displayName }));

type Check = (typeof CHECKS)[number];

/** Min-heap of scheduled actions, ordered by time, then by insertion so ties are deterministic. */
class EventQueue {
  private readonly heap: { at: number; seq: number; run: () => void }[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(at: number, run: () => void): void {
    const h = this.heap;
    h.push({ at, seq: this.nextSeq++, run });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  pop(): { at: number; run: () => void } | undefined {
    const h = this.heap;
    const top = h[0];
    if (!top) return undefined;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < h.length && before(h[l]!, h[smallest]!)) smallest = l;
        if (r < h.length && before(h[r]!, h[smallest]!)) smallest = r;
        if (smallest === i) break;
        [h[i], h[smallest]] = [h[smallest]!, h[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

function before(a: { at: number; seq: number }, b: { at: number; seq: number }): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

function severityFor(roll: number): Severity {
  if (roll < 0.2) return 'info';
  if (roll < 0.7) return 'warning';
  return 'critical';
}

function countOf(ctx: AppContext, sql: string): number {
  return ctx.db.get<{ n: number }>(sql)?.n ?? 0;
}

function removeDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

/**
 * Runs the discrete-event simulation. Every action goes through the real server code; the clock is set
 * to each event's time before it runs. Returns counts for the report.
 */
function simulate(ctx: AppContext, clock: ManualClock, count: number, endAt: number, rng: Rng): SimStats {
  const start = clock.now();
  const queue = new EventQueue();
  const stats: SimStats = {
    alerts: 0,
    created: 0,
    folded: 0,
    reopened: 0,
    attached: 0,
    followUps: 0,
    acked: 0,
    resolved: 0,
    assigned: 0,
    skipped: 0,
    breaches: 0,
  };

  /** Schedules an action, unless it falls after the end of the window. */
  const at = (t: number, run: () => void): void => {
    if (t <= endAt) queue.push(t, run);
  };

  /** Runs a write; a request the server refuses (an illegal move by now) counts as skipped. */
  const attempt = (run: () => void): void => {
    try {
      run();
    } catch (err) {
      if (err instanceof HttpError) stats.skipped += 1;
      else throw err;
    }
  };

  const ingest = (alert: AlertInput): IngestResponse => {
    const out = ingestAlert(ctx, alert);
    stats.alerts += 1;
    const action = out.body.action;
    if (action === 'created') stats.created += 1;
    else if (action === 'folded') stats.folded += 1;
    else if (action === 'reopened') stats.reopened += 1;
    else if (action === 'attached') stats.attached += 1;
    return out.body;
  };

  /** Ack, resolve and assign for a newly created incident, decided up front from the rates. */
  const planIncident = (id: number, t: number): void => {
    if (rng.chance(RATES.assigned)) {
      at(t + Math.floor(rng.between(30_000, 4 * MINUTE_MS)), () =>
        attempt(() => {
          const row = loadIncidentRow(ctx, id);
          if (!row || row.status === 'resolved') {
            stats.skipped += 1;
            return;
          }
          const actor = rng.pick(RESPONDERS);
          const assignee = rng.pick(RESPONDERS).id;
          applyAction(ctx, id, 'assign', actor, row.version, assignee);
          stats.assigned += 1;
        }),
      );
    }
    if (rng.chance(RATES.acked)) {
      const actor = rng.pick(RESPONDERS);
      const ackAt = t + Math.floor(rng.between(MINUTE_MS, 25 * MINUTE_MS));
      at(ackAt, () =>
        attempt(() => {
          const row = loadIncidentRow(ctx, id);
          if (!row || row.status !== 'open') {
            stats.skipped += 1;
            return;
          }
          applyAction(ctx, id, 'ack', actor, row.version);
          stats.acked += 1;
        }),
      );
      if (rng.chance(RATES.resolvedAfterAck)) {
        at(ackAt + Math.floor(rng.between(5 * MINUTE_MS, 60 * MINUTE_MS)), () =>
          attempt(() => {
            const row = loadIncidentRow(ctx, id);
            if (!row || row.status === 'resolved') {
              stats.skipped += 1;
              return;
            }
            applyAction(ctx, id, 'resolve', actor, row.version);
            stats.resolved += 1;
          }),
        );
      }
    }
  };

  /** One base arrival: a new fingerprint episode, plus a follow-up for 25% of them. */
  const arrive = (t: number): void => {
    const service = rng.pick(SERVICES);
    const check: Check = rng.pick(CHECKS);
    const host = `${rng.pick(REGIONS)}-${1 + rng.int(40)}`;
    const fingerprint = `${service}/${check.key}/${host}`;
    const source = SOURCES[SERVICES.indexOf(service) % SOURCES.length]!;
    const baseSeverity = severityFor(rng.float());
    const alertAt = (ts: number, severity: Severity): AlertInput => ({
      source,
      fingerprint,
      severity,
      title: `${check.title} on ${service} (${host})`,
      payload: { service, host, check: check.key, value: rng.int(1000) / 10 },
      ts,
    });

    const body = ingest(alertAt(t, baseSeverity));
    if (body.action === 'created') planIncident(body.incidentId, t);

    if (rng.chance(RATES.followUp)) {
      const followAt = t + Math.floor(rng.between(30_000, 8 * MINUTE_MS));
      at(followAt, () => {
        stats.followUps += 1;
        ingest(alertAt(followAt, rng.chance(0.2) ? 'critical' : baseSeverity));
      });
    }
  };

  for (let i = 0; i < count; i++) {
    const t = start + rng.int(WINDOW_MS);
    at(t, () => arrive(t));
  }
  for (let t = start + SWEEP_EVERY_MS; t <= endAt; t += SWEEP_EVERY_MS) {
    at(t, () => {
      stats.breaches += sweepSla(ctx);
    });
  }

  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    clock.set(next.at);
    next.run();
  }
  clock.set(endAt);
  stats.breaches += sweepSla(ctx);
  return stats;
}

/** The file a seed is built in. It is renamed to the target only after the simulation has finished. */
export function stagingPath(dbPath: string): string {
  return `${dbPath}.seeding`;
}

function inspectDatabase(dbPath: string): { users: number; incidents: number } {
  const ctx = createContext({ ...loadConfig(), dbPath }, systemClock);
  try {
    return {
      users: countOf(ctx, 'SELECT COUNT(*) AS n FROM users'),
      incidents: countOf(ctx, 'SELECT COUNT(*) AS n FROM incidents'),
    };
  } finally {
    closeContext(ctx);
  }
}

/** Builds a complete database at dbPath (which must not exist yet) and closes it. */
async function buildDatabase(dbPath: string, incidents: number, endAt: number, seed: number): Promise<SimStats> {
  const clock = manualClock(endAt - WINDOW_MS);
  const ctx = createContext({ ...loadConfig(), dbPath }, clock);
  try {
    // Seeding is about 10^4 small transactions. WAL with synchronous=NORMAL avoids an fsync per commit.
    // This only affects this connection; the server keeps its own default.
    ctx.db.raw.exec('PRAGMA synchronous = NORMAL');
    await ensureDemoUsers(ctx, DEMO_PASSWORD);
    const stats = simulate(ctx, clock, incidents, endAt, createRng(seed));
    // Fold the WAL into the main file so the staging file is complete before it is renamed.
    ctx.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return stats;
  } finally {
    closeContext(ctx);
  }
}

/**
 * Seeds dbPath. Returns seeded: false (and touches nothing) when the database already has users, unless
 * reset is set, in which case the files are deleted first.
 *
 * The database is built at `<dbPath>.seeding` and renamed to dbPath only when the simulation has finished.
 * So a file at dbPath always holds a complete seed: an interrupted run leaves only the staging file, which
 * the next run deletes and rebuilds. A database at dbPath with no users (for example, an empty file) is
 * replaced by the rename.
 */
export async function seedDatabase(opts: SeedOptions): Promise<SeedResult> {
  const began = Date.now();
  const dbPath = opts.dbPath;
  const staging = stagingPath(dbPath);
  if (opts.reset) removeDatabaseFiles(dbPath);
  removeDatabaseFiles(staging);

  if (fs.existsSync(dbPath)) {
    const existing = inspectDatabase(dbPath);
    if (existing.users > 0) {
      return {
        seeded: false,
        dbPath,
        durationMs: Date.now() - began,
        stats: null,
        incidents: existing.incidents,
        users: existing.users,
      };
    }
  }

  const endAt = opts.endAt ?? Date.now();
  const incidents = opts.incidents ?? 10_000;
  let stats: SimStats;
  try {
    stats = await buildDatabase(staging, incidents, endAt, opts.seed ?? 1);
  } catch (err) {
    removeDatabaseFiles(staging);
    throw err;
  }

  // Commit: one rename. Remove any sidecar files of an existing zero-user database first, so they cannot
  // be applied to the new file.
  removeDatabaseFiles(dbPath);
  fs.renameSync(staging, dbPath);
  removeDatabaseFiles(staging);

  const done = inspectDatabase(dbPath);
  return {
    seeded: true,
    dbPath,
    durationMs: Date.now() - began,
    stats,
    incidents: done.incidents,
    users: done.users,
  };
}

// ---------------------------------------------------------------- CLI

interface CliOptions {
  reset: boolean;
  count: number;
  db: string;
  seed: number;
}

function parseCli(argv: string[]): CliOptions {
  const out: CliOptions = { reset: false, count: 10_000, db: loadConfig().dbPath, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--reset') out.reset = true;
    else if (arg === '--count') out.count = positiveInt(arg, next());
    else if (arg === '--db') out.db = path.resolve(next());
    else if (arg === '--seed') out.seed = positiveInt(arg, next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  return n;
}

function targetPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const result = await seedDatabase({ dbPath: args.db, incidents: args.count, seed: args.seed, reset: args.reset });

  // Demo users are idempotent; this also covers a database that was seeded without them.
  const ctx = createContext({ ...loadConfig(), dbPath: args.db }, systemClock);
  try {
    await ensureDemoUsers(ctx, DEMO_PASSWORD);
  } finally {
    closeContext(ctx);
  }

  console.log(`Database: ${result.dbPath}`);
  if (!result.seeded) {
    console.log(`Already seeded (${result.users} users, ${result.incidents} incidents). Nothing to do. Use --reset to rebuild.`);
  } else {
    const s = result.stats!;
    console.log(`Seeded ${args.count} base alerts over two days (seed ${args.seed}) in ${(result.durationMs / 1000).toFixed(2)}s`);
    console.log(`  alerts ingested      ${s.alerts}`);
    console.log(`  incidents created    ${s.created}`);
    console.log(`  folded / attached    ${s.folded} / ${s.attached}   reopened ${s.reopened}`);
    console.log(`  follow-up alerts     ${s.followUps} (${pct(s.followUps, args.count)} of base; target ${targetPct(RATES.followUp)})`);
    console.log(`  acked                ${s.acked} (${pct(s.acked, s.created)} of created; target ${targetPct(RATES.acked)})`);
    console.log(`  resolved             ${s.resolved} (${pct(s.resolved, s.acked)} of acked; target ${targetPct(RATES.resolvedAfterAck)})`);
    console.log(`  assigned             ${s.assigned} (${pct(s.assigned, s.created)} of created; target ${targetPct(RATES.assigned)})`);
    console.log(`  SLA breaches         ${s.breaches}   skipped (already illegal) ${s.skipped}`);
    console.log(`  incident rows        ${result.incidents}`);
  }
  console.log('Demo logins (password for all: triage-demo):');
  for (const u of DEMO_USERS) {
    console.log(`  ${u.username.padEnd(6)} ${u.role.padEnd(10)} ${u.displayName}`);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
