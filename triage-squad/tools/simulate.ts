// Sends bursts of alerts to a running server's POST /ingest, the way a monitoring system does during an incident.
//
// Each burst is shuffled, so timestamps arrive out of order (up to 8 minutes old). About 25% of alerts are sent a
// second time as an exact duplicate. About 10% carry an Idempotency-Key and are sent twice, so the retry should
// come back as a replay. Prints the outcome counts at the end.
//
// CLI: node --disable-warning=ExperimentalWarning --import tsx tools/simulate.ts [--url URL] [--bursts N] [--gap MS] [--services N] [--seed S]
//   --url URL      server to send to (default http://127.0.0.1:$PORT, PORT default 8080)
//   --bursts N     number of bursts (default 20)
//   --gap MS       pause between bursts in milliseconds (default 500)
//   --services N   number of services in the alert pool (default 6, each with 4 checks)
//   --seed S       PRNG seed (default 42)
// Env: TRIAGE_INGEST_TOKEN is the ingest bearer token (default dev-ingest-token).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DEFAULT_INGEST_TOKEN } from '../server/src/config';
import { SEVERITIES, type IngestResponse, type Severity } from '../shared/types';
import { createRng, type Rng } from './random';

const MAX_AGE_MS = 8 * 60_000;
const CHECKS_PER_SERVICE = 4;
const OBSERVATIONS_PER_SERVICE = 4;
const DUPLICATE_RATE = 0.25;
const IDEMPOTENT_RATE = 0.1;
const CONCURRENCY = 8;
const SERVICE_NAMES = [
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
const CHECK_NAMES = ['latency above SLO', 'error rate elevated', 'queue backlog', 'health check failing'];
const SEVERITY_WEIGHTS = [20, 50, 30];

export interface SimOptions {
  url: string;
  bursts: number;
  gapMs: number;
  services: number;
  seed: string;
}

interface Observation {
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

interface Pool {
  service: string;
  check: string;
}

/** Tally of what the server answered. Keys are an ingest action, "replayed", or "http <status> <code>". */
type Tally = Map<string, number>;

function bump(tally: Tally, key: string): void {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

function buildPool(services: number): Pool[] {
  const pool: Pool[] = [];
  for (let s = 0; s < services; s += 1) {
    // Names repeat after the list runs out, with a numeric suffix, so every service name stays unique.
    const base = SERVICE_NAMES[s % SERVICE_NAMES.length] as string;
    const round = Math.floor(s / SERVICE_NAMES.length);
    const service = round === 0 ? base : `${base}-${round + 1}`;
    for (let c = 0; c < CHECKS_PER_SERVICE; c += 1) {
      pool.push({ service, check: CHECK_NAMES[c % CHECK_NAMES.length] as string });
    }
  }
  return pool;
}

/** Builds one burst's observations: shuffled, with duplicates and idempotency retries mixed in. */
function buildBurst(rng: Rng, pool: Pool[], burst: number, services: number, now: number): Observation[] {
  const observations: Observation[] = [];
  const count = services * OBSERVATIONS_PER_SERVICE;
  for (let k = 0; k < count; k += 1) {
    const slot = pool[rng.int(0, pool.length - 1)] as Pool;
    const severity: Severity = rng.weighted(SEVERITIES, SEVERITY_WEIGHTS);
    const ts = now - rng.int(0, MAX_AGE_MS);
    const body: Record<string, unknown> = {
      source: slot.service,
      fingerprint: `${slot.service}/${slot.check.replace(/\s+/g, '-')}`,
      severity,
      title: `${slot.service}: ${slot.check}`,
      // Half the alerts send epoch milliseconds and half send ISO 8601, so both forms are exercised.
      ts: rng.chance(0.5) ? ts : new Date(ts).toISOString(),
      payload: { burst, host: `${slot.service}-${rng.int(1, 9)}` },
    };
    const idempotencyKey = rng.chance(IDEMPOTENT_RATE) ? `sim-${burst}-${k}-${rng.int(1000, 9999)}` : null;
    observations.push({ body, idempotencyKey });
    if (idempotencyKey === null && rng.chance(DUPLICATE_RATE)) {
      observations.push({ body, idempotencyKey: null });
    }
  }
  return rng.shuffle(observations);
}

async function post(url: string, token: string, body: Record<string, unknown>, idempotencyKey: string | null): Promise<{ status: number; action?: string; replayed: boolean; code?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
  try {
    const res = await fetch(`${url}/ingest`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Partial<IngestResponse> & { error?: { code?: string } }) : {};
    return {
      status: res.status,
      action: res.ok ? json.action : undefined,
      replayed: res.headers.get('idempotent-replayed') === 'true',
      code: res.ok ? undefined : json.error?.code ?? 'unknown',
    };
  } catch {
    return { status: 0, replayed: false, code: 'network' };
  }
}

function record(tally: Tally, result: Awaited<ReturnType<typeof post>>): void {
  if (result.status === 202 && result.action) {
    bump(tally, result.action);
    if (result.replayed) bump(tally, 'replayed');
    return;
  }
  bump(tally, `http ${result.status} ${result.code ?? ''}`.trim());
}

/** Runs the tasks with at most `limit` in flight at once. */
async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (task) await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function simulateBursts(options: SimOptions, token: string): Promise<{ sent: number; tally: Tally }> {
  const rng = createRng(options.seed);
  const pool = buildPool(options.services);
  const tally: Tally = new Map();
  let sent = 0;

  for (let burst = 1; burst <= options.bursts; burst += 1) {
    const observations = buildBurst(rng, pool, burst, options.services, Date.now());
    const tasks = observations.map((obs) => async (): Promise<void> => {
      if (obs.idempotencyKey !== null) {
        // The first send and its retry use the same key and body. The retry should be a replay.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          sent += 1;
          record(tally, await post(options.url, token, obs.body, obs.idempotencyKey));
        }
        return;
      }
      sent += 1;
      record(tally, await post(options.url, token, obs.body, null));
    });
    await runLimited(tasks, CONCURRENCY);
    console.log(`burst ${burst}/${options.bursts}: ${observations.length} alerts`);
    if (burst < options.bursts) await sleep(options.gapMs);
  }
  return { sent, tally };
}

function parseArgs(argv: string[]): SimOptions & { help: boolean } {
  const defaults: SimOptions & { help: boolean } = {
    url: `http://127.0.0.1:${process.env.PORT || '8080'}`,
    bursts: 20,
    gapMs: 500,
    services: 6,
    seed: '42',
    help: false,
  };
  const options = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    const integer = (min: number, max: number): number => {
      const value = Number(next());
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${arg} must be an integer from ${min} to ${max}`);
      }
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--url') options.url = next().replace(/\/+$/, '');
    else if (arg === '--bursts') options.bursts = integer(1, 10_000);
    else if (arg === '--gap') options.gapMs = integer(0, 60_000);
    else if (arg === '--services') options.services = integer(1, 1_000);
    else if (arg === '--seed') options.seed = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: tools/simulate.ts [--url URL] [--bursts N] [--gap MS] [--services N] [--seed S]');
    return;
  }
  const token = process.env.TRIAGE_INGEST_TOKEN || DEFAULT_INGEST_TOKEN;

  try {
    const health = await fetch(`${options.url}/healthz`);
    if (!health.ok) throw new Error(`healthz returned ${health.status}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`no Triage server answering at ${options.url} (${reason}). Start it with npm start first.`);
  }

  const started = Date.now();
  const { sent, tally } = await simulateBursts(options, token);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Sent ${sent} requests to ${options.url}/ingest in ${seconds}s`);
  for (const key of [...tally.keys()].sort()) {
    // Replays are also counted under their action, so they are shown as a subset.
    const label = key === 'replayed' ? 'replayed (included above)' : key;
    console.log(`  ${label.padEnd(28)} ${tally.get(key)}`);
  }
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
