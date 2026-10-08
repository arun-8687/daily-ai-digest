// Seeds a database with two days of realistic history.
//
// This is a discrete-event simulation. Every alert goes through the REAL parseAlert + ingestAlert, and every human
// action through the REAL applyAction, under a manual clock that is set to each event's time in order. Breaches come
// from the REAL sweepSla. Nothing is written to the database directly, so the grouping, versions, audit and SLA
// rules all apply exactly as they do in the server.
//
// CLI: node --disable-warning=ExperimentalWarning --import tsx tools/seed.ts [--db PATH] [--count N] [--seed S] [--reset] [--force]
//   --db PATH   database file (default: TRIAGE_DB, else data/triage.db)
//   --count N   number of incidents to create (default 10000)
//   --seed S    PRNG seed, so the same seed gives the same history (default 42)
//   --reset     delete the database file (and its -wal and -shm files) first
//   --force     seed even when users already exist (used by the e2e setup, which seeds a database a server has opened)
// Without --force it is a no-op when users already exist, so running it twice is safe.
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLA_CRITICAL_MS } from '../shared/rules';
import { SEVERITIES, type Severity } from '../shared/types';
import type { Actor } from '../server/src/audit';
import { manualClock, type ManualClock } from '../server/src/clock';
import { loadConfig, type AppConfig } from '../server/src/config';
import { createContext, type AppContext } from '../server/src/context';
import { HttpError } from '../server/src/errors';
import { applyAction, loadIncidentRow } from '../server/src/incidents';
import { ingestAlert, parseAlert } from '../server/src/ingest';
import { runMaintenance, sweepSla } from '../server/src/sla';
import { DEMO_PASSWORD, ensureDemoUsers, listUsers } from '../server/src/users';
import { createRng } from './random';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The history covers this much time, ending at endAt. */
export const SIMULATED_SPAN_MS = 2 * DAY_MS;
export const DEFAULT_INCIDENT_COUNT = 10_000;
export const DEFAULT_SEED = 42;

const SERVICES = [
  'payments-api',
  'checkout-web',
  'search-indexer',
  'auth-gateway',
  'ledger-sync',
  'notify-worker',
  'inventory-db',
  'edge-cdn',
  'ml-inference',
  'billing-cron',
  'catalog-api',
  'session-store',
];

const CHECKS = [
  'p99 latency above SLO',
  'error rate above 2%',
  'queue depth growing',
  'disk usage above 90%',
  'pod restart loop',
  'TLS certificate expires soon',
  'replica lag above 30s',
  'health check failing',
  'CPU saturated',
  'memory pressure',
  'consumer lag rising',
  'cache hit ratio dropped',
];

const REGIONS = ['eu-west-1', 'us-east-1', 'us-west-2', 'ap-southeast-2'];
/** Relative weights for SEVERITIES (info, warning, critical). */
const SEVERITY_WEIGHTS = [25, 45, 30];

// Behaviour rates from the spec (section 7).
const FOLLOW_UP_RATE = 0.25;
const ACK_RATE = 0.55;
const RESOLVE_GIVEN_ACK_RATE = 0.6;
const ASSIGN_RATE = 0.3;

export interface SeedOptions {
  dbPath?: string;
  incidents?: number;
  /** The end of the simulated history. Defaults to now. */
  endAt?: number;
  seed?: number | string;
  reset?: boolean;
  force?: boolean;
}

export interface SeedStats {
  incidents: number;
  /** Ingest outcomes by action (created, folded, attached, reopened, duplicate). */
  outcomes: Record<string, number>;
  acks: number;
  resolves: number;
  assigns: number;
  /** Actions the server rejected. Should be 0 for a consistent history. */
  rejected: number;
  breaches: number;
  events: number;
}

export type SeedResult =
  | { seeded: true; dbPath: string; elapsedMs: number; stats: SeedStats; logins: string }
  | { seeded: false; dbPath: string; reason: string; logins: string };

interface Plan {
  service: string;
  check: string;
  title: string;
  fingerprint: string;
  severity: Severity;
  host: string;
  region: string;
  t0: number;
  folds: Array<{ ts: number; severity: Severity; title: string }>;
  ackAt: number | null;
  resolveAt: number | null;
  assignAt: number | null;
  assigneeId: string | null;
}

interface Task {
  at: number;
  order: number;
  run: () => void;
}

function removeDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function countUsers(ctx: AppContext): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
}

/** Describes the demo logins. Printed by the CLI and by a no-op run. */
export function demoLoginsText(ctx: AppContext): string {
  return listUsers(ctx)
    .map((u) => `${u.username} / ${DEMO_PASSWORD} (${u.role})`)
    .join(', ');
}

/** Builds the event plan for every incident. Every choice comes from one seeded PRNG, so the plan is reproducible. */
function buildPlans(count: number, start: number, endAt: number, rng: ReturnType<typeof createRng>, assigneeIds: string[]): Plan[] {
  const plans: Plan[] = [];
  for (let i = 0; i < count; i += 1) {
    const service = rng.pick(SERVICES);
    const checkIndex = rng.int(0, CHECKS.length - 1);
    const check = CHECKS[checkIndex] as string;
    const t0 = start + rng.int(0, SIMULATED_SPAN_MS - 1);
    const severity = rng.weighted(SEVERITIES, SEVERITY_WEIGHTS);
    const plan: Plan = {
      service,
      check,
      title: `${service}: ${check}`,
      // Unique per incident, so each follow-up folds into exactly its own incident.
      fingerprint: `${service}/check-${checkIndex}/${i.toString(36)}`,
      severity,
      host: `${service}-${rng.int(1, 40)}`,
      region: rng.pick(REGIONS),
      t0,
      folds: [],
      ackAt: null,
      resolveAt: null,
      assignAt: null,
      assigneeId: null,
    };

    let lastSeen = t0;
    if (rng.chance(FOLLOW_UP_RATE)) {
      // Inside the 10 minute fold window, and before any ack, so folds never land on a resolved incident.
      const ts = t0 + rng.int(MINUTE_MS, 9 * MINUTE_MS);
      plan.folds.push({ ts, severity: rng.weighted(SEVERITIES, SEVERITY_WEIGHTS), title: `${plan.title} (still firing)` });
      lastSeen = ts;
    }

    if (rng.chance(ACK_RATE)) {
      plan.ackAt = lastSeen + rng.int(MINUTE_MS, 30 * MINUTE_MS);
      if (rng.chance(RESOLVE_GIVEN_ACK_RATE)) {
        plan.resolveAt = plan.ackAt + rng.int(2 * MINUTE_MS, 60 * MINUTE_MS);
      }
    }

    if (rng.chance(ASSIGN_RATE)) {
      // Assign before the ack (or within 20 minutes when never acked), so it is always legal.
      const horizon = (plan.ackAt ?? lastSeen + 20 * MINUTE_MS) - t0;
      plan.assignAt = t0 + rng.int(30_000, Math.max(30_000, horizon - 1));
      plan.assigneeId = rng.pick(assigneeIds);
    }

    // Anything after endAt has not happened yet: schedule() drops it, so the incident stays in flight.
    if (plan.ackAt !== null && plan.ackAt > endAt) plan.ackAt = null;
    if (plan.ackAt === null) plan.resolveAt = null;
    if (plan.resolveAt !== null && plan.resolveAt > endAt) plan.resolveAt = null;
    if (plan.assignAt !== null && plan.assignAt > endAt) plan.assignAt = null;
    plans.push(plan);
  }
  return plans;
}

/**
 * Replays the history into an existing context. The clock must be the manual clock passed in.
 * Users must already exist (ensureDemoUsers). Returns the counts.
 */
export function simulateHistory(
  ctx: AppContext,
  clock: ManualClock,
  options: { incidents: number; endAt: number; seed: number | string },
): SeedStats {
  const { incidents, endAt, seed } = options;
  const start = endAt - SIMULATED_SPAN_MS;
  const rng = createRng(seed);

  const users = listUsers(ctx);
  const responders = users.filter((u) => u.role !== 'viewer');
  const actorById = new Map<string, Actor>(users.map((u) => [u.id, { id: u.id, name: u.displayName }]));
  const assigneeIds = users.map((u) => u.id);
  if (responders.length === 0) throw new Error('simulateHistory needs at least one responder user');

  const plans = buildPlans(incidents, start, endAt, rng, assigneeIds);
  const ids: number[] = new Array<number>(incidents).fill(0);
  const stats: SeedStats = {
    incidents: 0,
    outcomes: {},
    acks: 0,
    resolves: 0,
    assigns: 0,
    rejected: 0,
    breaches: 0,
    events: 0,
  };

  const tasks: Task[] = [];
  let order = 0;
  const schedule = (at: number, run: () => void): void => {
    if (at <= endAt) tasks.push({ at, order: order++, run });
  };

  /** Applies one human action. A breach whose deadline has passed is stamped first, as the 1s server sweep would have done. */
  const act = (index: number, action: 'ack' | 'resolve' | 'assign', actor: Actor, assigneeId: string | null = null): void => {
    const id = ids[index] as number;
    let row = loadIncidentRow(ctx.db, id);
    if (!row) throw new Error(`simulation lost incident ${id}`);
    if (row.sla_started_at !== null && row.sla_breached_at === null && row.sla_started_at + SLA_CRITICAL_MS <= clock.now()) {
      stats.breaches += sweepSla(ctx);
      row = loadIncidentRow(ctx.db, id) as typeof row;
    }
    try {
      applyAction(ctx, id, action, actor, row.version, action === 'assign' ? assigneeId : undefined);
      if (action === 'ack') stats.acks += 1;
      if (action === 'resolve') stats.resolves += 1;
      if (action === 'assign') stats.assigns += 1;
    } catch (err) {
      if (err instanceof HttpError) {
        stats.rejected += 1;
      } else {
        throw err;
      }
    }
  };

  plans.forEach((plan, index) => {
    const { fingerprint, service, check, severity, host, region } = plan;
    schedule(plan.t0, () => {
      const alert = parseAlert(
        { source: service, fingerprint, severity, title: plan.title, ts: plan.t0, payload: { host, region, check } },
        clock.now(),
      );
      const outcome = ingestAlert(ctx, alert);
      ids[index] = outcome.body.incidentId;
      stats.outcomes[outcome.body.action] = (stats.outcomes[outcome.body.action] ?? 0) + 1;
    });

    for (const fold of plan.folds) {
      schedule(fold.ts, () => {
        const alert = parseAlert(
          { source: service, fingerprint, severity: fold.severity, title: fold.title, ts: fold.ts, payload: { host, region, check } },
          clock.now(),
        );
        const outcome = ingestAlert(ctx, alert);
        stats.outcomes[outcome.body.action] = (stats.outcomes[outcome.body.action] ?? 0) + 1;
      });
    }

    if (plan.assignAt !== null && plan.assigneeId !== null) {
      const assignee = plan.assigneeId;
      schedule(plan.assignAt, () => act(index, 'assign', responderFor(index), assignee));
    }
    if (plan.ackAt !== null) {
      schedule(plan.ackAt, () => act(index, 'ack', responderFor(index)));
    }
    if (plan.resolveAt !== null) {
      schedule(plan.resolveAt, () => act(index, 'resolve', responderFor(index)));
    }
  });

  /** Acks and resolves are made by the responders (alice and bob), chosen per incident. */
  function responderFor(index: number): Actor {
    const pick = responders[index % responders.length] as (typeof responders)[number];
    return actorById.get(pick.id) as Actor;
  }

  // The server sweeps every second. Here a sweep runs every simulated minute, and act() stamps any breach that is due.
  for (let t = start + MINUTE_MS; t <= endAt; t += MINUTE_MS) {
    schedule(t, () => {
      stats.breaches += sweepSla(ctx);
    });
  }

  tasks.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const task of tasks) {
    clock.set(task.at);
    task.run();
    stats.events += 1;
  }

  stats.incidents = ids.filter((id) => id > 0).length;
  clock.set(endAt);
  stats.breaches += sweepSla(ctx);
  runMaintenance(ctx);
  return stats;
}

/** Seeds a database. Opens its own context under a manual clock that starts at endAt minus two days. */
export async function seedDatabase(options: SeedOptions = {}): Promise<SeedResult> {
  const base: AppConfig = loadConfig();
  const dbPath = options.dbPath ?? base.dbPath;
  if (options.reset) removeDatabaseFiles(dbPath);

  const endAt = options.endAt ?? Date.now();
  const incidents = options.incidents ?? DEFAULT_INCIDENT_COUNT;
  const seed = options.seed ?? DEFAULT_SEED;
  const clock = manualClock(endAt - SIMULATED_SPAN_MS);
  const ctx = createContext({ ...base, dbPath }, clock);
  try {
    if (countUsers(ctx) > 0 && !options.force) {
      return { seeded: false, dbPath, reason: 'users already exist', logins: demoLoginsText(ctx) };
    }
    const started = performance.now();
    await ensureDemoUsers(ctx);
    const stats = simulateHistory(ctx, clock, { incidents, endAt, seed });
    return {
      seeded: true,
      dbPath,
      elapsedMs: performance.now() - started,
      stats,
      logins: demoLoginsText(ctx),
    };
  } finally {
    ctx.db.close();
  }
}

function parseArgs(argv: string[]): SeedOptions & { help: boolean } {
  const options: SeedOptions & { help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--db') options.dbPath = resolve(next());
    else if (arg === '--count') {
      const count = Number(next());
      if (!Number.isInteger(count) || count < 1 || count > 1_000_000) throw new Error('--count must be an integer from 1 to 1000000');
      options.incidents = count;
    } else if (arg === '--seed') options.seed = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: tools/seed.ts [--db PATH] [--count N] [--seed S] [--reset] [--force]');
    return;
  }
  const result = await seedDatabase(options);
  if (!result.seeded) {
    console.log(`Nothing to do: ${result.reason} in ${result.dbPath}. Use --reset to start again.`);
    console.log(`Demo logins: ${result.logins}`);
    return;
  }
  const { stats } = result;
  const outcomes = Object.entries(stats.outcomes)
    .map(([action, n]) => `${action} ${n}`)
    .join(', ');
  console.log(`Seeded ${stats.incidents} incidents into ${result.dbPath} in ${(result.elapsedMs / 1000).toFixed(2)}s`);
  console.log(`  ingest: ${outcomes}`);
  console.log(`  actions: ${stats.acks} acks, ${stats.resolves} resolves, ${stats.assigns} assigns, ${stats.breaches} SLA breaches, ${stats.rejected} rejected`);
  console.log(`Demo logins: ${result.logins}`);
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
