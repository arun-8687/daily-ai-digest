// Sends alert bursts to a running Triage server's POST /ingest, the way a noisy monitoring source would.
//
// Per burst:
//   - alerts across a small pool of fingerprints, so many fold into the same incident;
//   - out-of-order event times: each ts is 0-8 minutes old, and the list is shuffled;
//   - 25% of alerts are sent a second time as an exact duplicate (same content, no key);
//   - 10% of alerts carry an Idempotency-Key and are sent twice (the retry), so the second send
//     should be a replay.
//
// Idempotency-Key values carry a random per-run id, so a second run never reuses a key from the first
// run (the server keeps keys for 24 hours and rejects a reused key with different content as 422).
//
// Prints outcome counts by HTTP status and action. Exits 1 on a transport failure, a 4xx or a 5xx.
//
// Usage: node --disable-warning=ExperimentalWarning --import tsx tools/simulate.ts
//   [--url http://127.0.0.1:8080] [--bursts 3] [--gap 2000] [--services 6] [--seed 1] [--size 40] [--concurrency 8]
// The token is TRIAGE_INGEST_TOKEN, or the default dev token.

import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/src/config';
import { createRng, type Rng } from './prng';

interface Options {
  url: string;
  bursts: number;
  gap: number;
  services: number;
  seed: number;
  size: number;
  concurrency: number;
}

const SERVICES = ['checkout', 'payments', 'search', 'auth', 'catalog', 'notifications', 'ingest', 'billing', 'reports', 'edge-cdn'];
const CHECKS = [
  { key: 'http-5xx', title: 'HTTP 5xx rate elevated' },
  { key: 'latency-p99', title: 'p99 latency above SLO' },
  { key: 'queue-depth', title: 'Queue depth growing' },
  { key: 'error-logs', title: 'Error log spike' },
];
const SEVERITIES = ['info', 'warning', 'critical'] as const;
const SOURCES = ['prometheus', 'cloudwatch', 'synthetics'];
const MINUTE_MS = 60_000;

interface Alert {
  source: string;
  fingerprint: string;
  severity: (typeof SEVERITIES)[number];
  title: string;
  payload: Record<string, unknown>;
  ts: number;
}

interface Send {
  alert: Alert;
  /** Idempotency-Key, when this send carries one. */
  key: string | null;
  kind: 'alert' | 'retry' | 'duplicate';
  burst: number;
}

/** The parts of an ingest response this tool reads. */
interface ResponseBody {
  action?: string;
  error?: { code?: string };
}

interface SendResult {
  kind: Send['kind'];
  burst: number;
  /** HTTP status, or 0 when the request never got a response. */
  status: number;
  action: string | null;
  replayed: boolean;
  errorCode: string | null;
  transport: string | null;
}

const USAGE = `Usage: simulate.ts [--url URL] [--bursts N] [--gap MS] [--services N] [--seed N] [--size N] [--concurrency N]`;

function parseOptions(argv: string[]): Options {
  const out: Options = { url: 'http://127.0.0.1:8080', bursts: 3, gap: 2000, services: 6, seed: 1, size: 40, concurrency: 8 };
  const numeric: Record<string, (v: number) => void> = {
    '--bursts': (v) => (out.bursts = v),
    '--gap': (v) => (out.gap = v),
    '--services': (v) => (out.services = v),
    '--seed': (v) => (out.seed = v),
    '--size': (v) => (out.size = v),
    '--concurrency': (v) => (out.concurrency = v),
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const takeValue = (): string => {
      if (eq !== -1) return raw.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (flag === '--url') {
      out.url = takeValue();
      continue;
    }
    const setter = numeric[flag];
    if (!setter) throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
    const raw2 = takeValue();
    const n = Number(raw2);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got "${raw2}"`);
    setter(n);
  }
  if (out.bursts < 1) throw new Error('--bursts must be at least 1');
  if (out.services < 1 || out.services > SERVICES.length) throw new Error(`--services must be 1-${SERVICES.length}`);
  if (out.size < 1) throw new Error('--size must be at least 1');
  if (out.concurrency < 1) throw new Error('--concurrency must be at least 1');
  return out;
}

function makeBurst(burst: number, opts: Options, rng: Rng, keySeq: { n: number }, runId: string): Send[] {
  const now = Date.now();
  const services = SERVICES.slice(0, opts.services);
  const alerts: Alert[] = [];
  for (let i = 0; i < opts.size; i++) {
    const service = rng.pick(services);
    const check = rng.pick(CHECKS);
    alerts.push({
      source: rng.pick(SOURCES),
      fingerprint: `${service}/${check.key}`,
      severity: rng.pick(SEVERITIES),
      title: `${check.title} on ${service}`,
      payload: { burst, seq: i, value: rng.int(100) },
      // Event time 0 to 8 minutes old: the server must accept these and fold them in whatever order they arrive.
      ts: now - rng.int(8 * MINUTE_MS),
    });
  }

  const sends: Send[] = [];
  for (const alert of alerts) {
    if (rng.chance(0.1)) {
      keySeq.n += 1;
      const key = `sim-${runId}-${burst}-${keySeq.n}`;
      sends.push({ alert, key, kind: 'alert', burst });
      sends.push({ alert, key, kind: 'retry', burst });
    } else {
      sends.push({ alert, key: null, kind: 'alert', burst });
    }
    if (rng.chance(0.25)) sends.push({ alert, key: null, kind: 'duplicate', burst });
  }
  return rng.shuffle(sends);
}

async function sendOne(url: string, token: string, send: Send): Promise<SendResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (send.key !== null) headers['Idempotency-Key'] = send.key;
  const base = { kind: send.kind, burst: send.burst };
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(send.alert) });
    const text = await res.text();
    let json: ResponseBody | null = null;
    try {
      json = JSON.parse(text) as ResponseBody;
    } catch {
      json = null;
    }
    return {
      ...base,
      status: res.status,
      action: json?.action ?? null,
      replayed: res.headers.get('idempotent-replayed') === 'true',
      errorCode: json?.error?.code ?? null,
      transport: null,
    };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: 0, action: null, replayed: false, errorCode: null, transport: cause || message };
  }
}

/** Runs fn over items with at most limit calls in flight. Results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function tally(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printTable(title: string, map: Map<string, number>): void {
  console.log(title);
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) console.log('  (none)');
  for (const [key, n] of rows) console.log(`  ${key.padEnd(34)} ${String(n).padStart(6)}`);
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const token = loadConfig().ingestToken;
  const ingestUrl = `${opts.url.replace(/\/+$/, '')}/ingest`;
  const rng = createRng(opts.seed);
  const keySeq = { n: 0 };
  const runId = randomBytes(8).toString('hex');

  // Fail fast with one clear message instead of reporting every request as a transport error.
  const healthUrl = `${opts.url.replace(/\/+$/, '')}/healthz`;
  try {
    const health = await fetch(healthUrl);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new Error(`Cannot reach Triage at ${healthUrl}: ${reason}`);
  }

  const byOutcome = new Map<string, number>();
  const byKind = new Map<string, number>();
  const errors = new Map<string, number>();
  let total = 0;
  let failures = 0;
  const started = Date.now();

  console.log(`Sending ${opts.bursts} burst(s) of ~${opts.size} alerts to ${ingestUrl} (seed ${opts.seed}, gap ${opts.gap}ms)`);
  for (let burst = 1; burst <= opts.bursts; burst++) {
    const sends = makeBurst(burst, opts, rng, keySeq, runId);
    const results = await mapLimit(sends, opts.concurrency, (s) => sendOne(ingestUrl, token, s));
    const burstStatus = new Map<string, number>();
    for (const r of results) {
      total += 1;
      tally(byKind, r.kind);
      if (r.transport !== null) {
        failures += 1;
        tally(errors, `transport: ${r.transport}`);
        continue;
      }
      // Every generated alert is valid, so any 4xx is a bug in the tool or the server. Count it as a failure.
      if (r.status === 0 || r.status >= 400) failures += 1;
      const label = r.replayed
        ? `${r.status} replayed`
        : r.status >= 400
          ? `${r.status} ${r.errorCode ?? 'error'}`
          : `${r.status} ${r.action ?? '?'}`;
      tally(byOutcome, label);
      tally(burstStatus, label);
      if (r.status >= 400) tally(errors, `${r.status} ${r.errorCode ?? 'error'}`);
    }
    const summary = [...burstStatus.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
    console.log(`Burst ${burst}: ${results.length} sends (${sends.filter((s) => s.kind === 'duplicate').length} duplicates, ${sends.filter((s) => s.kind === 'retry').length} key retries): ${summary}`);
    if (burst < opts.bursts && opts.gap > 0) await new Promise((resolve) => setTimeout(resolve, opts.gap));
  }

  console.log('');
  printTable(`Outcomes by HTTP status and action (${total} requests in ${((Date.now() - started) / 1000).toFixed(1)}s)`, byOutcome);
  console.log('');
  printTable('Sends by kind', byKind);
  if (errors.size > 0) {
    console.log('');
    printTable('Errors', errors);
  }
  if (failures > 0) {
    console.error(`\n${failures} request(s) failed with a transport error, a 4xx or a 5xx.`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
