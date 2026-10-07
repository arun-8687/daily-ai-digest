// Seeds a demo database: 3 users and N incidents (default 10,000). The data is produced by
// running the real ingest and lifecycle code under a simulated clock, so audit history,
// SLA state, and versions come out consistent. Nothing is written to the tables directly.
//
//   npm run seed                 # no-op if the database already has users
//   npm run seed -- --reset      # delete the database files and seed again
//   npm run seed -- --count 500  # smaller dataset
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from '../server/src/config';
import { manualClock } from '../server/src/clock';
import { Database } from '../server/src/db';
import { createContext, type AppContext } from '../server/src/context';
import { applyAction, loadIncident } from '../server/src/incidents';
import { ingestAlert, type AlertInput } from '../server/src/ingest';
import { sweepSla } from '../server/src/sla';
import { DEMO_PASSWORD, DEMO_USERS, ensureDemoUsers } from '../server/src/users';
import type { Severity } from '../shared/types';
import { Rng } from './random';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const SERVICES = [
  'checkout-api', 'payments-gateway', 'search-indexer', 'auth-service', 'inventory-sync',
  'recommendations', 'notifications', 'media-transcoder', 'ledger-writer', 'session-cache',
  'edge-router', 'billing-cron', 'email-relay', 'profile-api', 'feature-flags', 'ingest-queue',
  'reporting-etl', 'geo-resolver', 'webhooks-dispatch', 'image-cdn',
];

const SYMPTOMS: { title: string; severity: Severity }[] = [
  { title: 'p99 latency above 2s', severity: 'warning' },
  { title: 'error rate above 5%', severity: 'critical' },
  { title: 'pod restarts climbing', severity: 'warning' },
  { title: 'disk usage above 85%', severity: 'info' },
  { title: 'queue depth growing', severity: 'warning' },
  { title: 'TLS certificate expires in 7 days', severity: 'info' },
  { title: 'database connections exhausted', severity: 'critical' },
  { title: 'healthcheck failing in one region', severity: 'critical' },
  { title: 'cache hit ratio below 60%', severity: 'info' },
  { title: 'replication lag above 30s', severity: 'warning' },
];

const SOURCES = ['prometheus', 'datadog', 'cloudwatch', 'sentry', 'pagerduty-events'];
const REGIONS = ['eu-west-1', 'eu-central-1', 'us-east-1', 'us-west-2', 'ap-south-1'];

interface Scheduled {
  at: number;
  seq: number;
  run: () => void;
}

/** Min-heap of future actions. Ties are broken by insertion order, so runs are deterministic. */
class Agenda {
  private readonly heap: Scheduled[] = [];
  private counter = 0;

  push(at: number, run: () => void): void {
    const h = this.heap;
    h.push({ at, seq: this.counter++, run });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i], h[parent])) break;
      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }

  peek(): Scheduled | undefined {
    return this.heap[0];
  }

  pop(): Scheduled | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (last !== undefined && h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l], h[m])) m = l;
        if (r < h.length && before(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

function before(a: Scheduled, b: Scheduled): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

export interface SeedOptions {
  dbPath: string;
  incidents?: number;
  /** Simulated time at which seeding ends. Defaults to now. */
  endAt?: number;
  seed?: number;
}

export interface SeedSummary {
  incidents: number;
  alerts: number;
  auditEntries: number;
  users: number;
  slaBreaches: number;
  ms: number;
}

/**
 * Discrete-event simulation. Incidents arrive over the two days before `endAt`. Follow-up
 * alerts (folds), acks, assignments and resolves go on an agenda and run in time order,
 * with the clock set to each action's time just before it runs.
 */
export async function seedDatabase(opts: SeedOptions): Promise<SeedSummary> {
  const started = Date.now();
  const total = opts.incidents ?? 10_000;
  const endAt = opts.endAt ?? Date.now();
  const rng = new Rng(opts.seed ?? 20260101);
  const clock = manualClock(endAt - 2 * DAY);
  const config: AppConfig = { ...loadConfig(), dbPath: resolve(opts.dbPath) };
  const ctx: AppContext = createContext(config, clock);
  await ensureDemoUsers(ctx, DEMO_PASSWORD);

  const responders = DEMO_USERS.filter((u) => u.role !== 'viewer');
  const agenda = new Agenda();
  const flushUntil = (t: number): void => {
    for (let next = agenda.peek(); next !== undefined && next.at <= t; next = agenda.peek()) {
      agenda.pop();
      clock.set(Math.max(clock.now(), next.at));
      next.run();
    }
  };

  let alerts = 0;
  const send = (alert: AlertInput) => {
    alerts++;
    return ingestAlert(ctx, alert);
  };

  // Average gap of about 4 seconds between incidents, so 10k incidents span roughly 11 hours.
  let t = clock.now();
  for (let i = 0; i < total; i++) {
    t = Math.min(endAt, t + rng.int(1, 8_000));
    flushUntil(t);
    clock.set(t);

    const service = rng.pick(SERVICES);
    const symptom = rng.pick(SYMPTOMS);
    const severity: Severity = rng.chance(0.12) && symptom.severity !== 'info' ? 'critical' : symptom.severity;
    const base = {
      source: rng.pick(SOURCES),
      fingerprint: `${service}/${symptom.title.replace(/\s+/g, '-')}/${i}`,
      title: `${service}: ${symptom.title}`,
      payload: { service, region: rng.pick(REGIONS), instance: `i-${rng.int(1000, 9999)}` },
    };
    const { body } = send({ ...base, severity, ts: clock.now() });
    const incidentId = body.incidentId as number;

    // A quarter of incidents get a follow-up alert inside the 10-minute grouping window.
    if (rng.chance(0.25)) {
      agenda.push(clock.now() + rng.int(1, 6) * MINUTE, () => {
        send({ ...base, severity, payload: { ...base.payload, retry: true }, ts: clock.now() });
      });
    }

    if (rng.chance(0.55)) {
      const actor = rng.pick(responders);
      agenda.push(clock.now() + rng.int(1, 30) * MINUTE, () => {
        const row = loadIncident(ctx, incidentId);
        if (!row || row.status !== 'open') return;
        applyAction(ctx, incidentId, 'ack', { id: actor.id, name: actor.displayName }, row.version);
        if (rng.chance(0.6)) {
          agenda.push(clock.now() + rng.int(5, 120) * MINUTE, () => {
            const fresh = loadIncident(ctx, incidentId);
            if (fresh && fresh.status === 'acked') {
              applyAction(ctx, incidentId, 'resolve', { id: actor.id, name: actor.displayName }, fresh.version);
            }
          });
        }
      });
    }

    if (rng.chance(0.3)) {
      const actor = rng.pick(responders);
      const assignee = rng.pick(DEMO_USERS);
      agenda.push(clock.now() + rng.int(1, 45) * MINUTE, () => {
        const row = loadIncident(ctx, incidentId);
        if (row && row.status !== 'resolved') {
          applyAction(ctx, incidentId, 'assign', { id: actor.id, name: actor.displayName }, row.version, assignee.id);
        }
      });
    }
  }
  flushUntil(endAt);
  clock.set(endAt);
  // Leave the database in the state a running server would hold at endAt.
  const slaBreaches = sweepSla(ctx);

  const counts = ctx.db.get<{ incidents: number; audit: number; users: number }>(
    `SELECT (SELECT COUNT(*) FROM incidents) AS incidents,
            (SELECT COUNT(*) FROM audit_log) AS audit,
            (SELECT COUNT(*) FROM users) AS users`,
  ) as { incidents: number; audit: number; users: number };
  ctx.db.close();
  return {
    incidents: counts.incidents,
    alerts,
    auditEntries: counts.audit,
    users: counts.users,
    slaBreaches,
    ms: Date.now() - started,
  };
}

function parseArgs(argv: string[]): { reset: boolean; count: number; dbPath: string } {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const count = Number(value('--count') ?? 10_000);
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
  return {
    reset: argv.includes('--reset'),
    count,
    dbPath: resolve(value('--db') ?? loadConfig().dbPath),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { reset, count, dbPath } = parseArgs(argv);

  if (reset) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  } else if (existsSync(dbPath)) {
    const db = new Database(dbPath);
    const { n } = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users') as { n: number };
    db.close();
    if (n > 0) {
      console.log(`[triage] ${dbPath} is already seeded. Pass --reset to rebuild it.`);
      return;
    }
  }

  console.log(`[triage] seeding ${count.toLocaleString()} incidents into ${dbPath} ...`);
  const s = await seedDatabase({ dbPath, incidents: count });
  console.log(
    `[triage] done in ${(s.ms / 1000).toFixed(1)}s: ${s.incidents.toLocaleString()} incidents, ` +
      `${s.alerts.toLocaleString()} alerts, ${s.auditEntries.toLocaleString()} audit rows, ` +
      `${s.users} users, ${s.slaBreaches} SLA breaches applied.`,
  );
  console.log(`[triage] demo logins: alice (admin), bob (responder), carol (viewer). Password: ${DEMO_PASSWORD}`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
