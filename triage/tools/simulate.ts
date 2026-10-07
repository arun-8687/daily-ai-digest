// Fires bursts of alerts at POST /ingest to exercise the live board. Each burst mixes
// the things real monitoring pipelines do: several alerts per fingerprint, timestamps
// that arrive out of order, exact duplicates, and retries that reuse an Idempotency-Key.
//
//   npm run simulate                                  # 40 bursts, ~1.2s apart
//   npm run simulate -- --bursts 200 --gap 500        # heavier
import { loadConfig } from '../server/src/config';
import { Rng, shuffleInPlace } from './random';

interface Options {
  url: string;
  token: string;
  bursts: number;
  gapMs: number;
  services: number;
  seed: number;
}

const SERVICES = [
  'checkout-api', 'payments-gateway', 'search-indexer', 'auth-service', 'inventory-sync',
  'recommendations', 'notifications', 'ledger-writer', 'session-cache', 'edge-router',
];
const SYMPTOMS = [
  'p99 latency above 2s', 'error rate above 5%', 'pod restarts climbing',
  'queue depth growing', 'healthcheck failing in one region', 'replication lag above 30s',
];
const SEVERITIES = ['info', 'info', 'info', 'warning', 'warning', 'warning', 'warning', 'critical'] as const;

type Body = Record<string, unknown>;

async function post(url: string, token: string, body: Body, key?: string): Promise<{ status: number; json: any; replayed: boolean }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(`${url}/ingest`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json(), replayed: res.headers.get('idempotent-replayed') === 'true' };
}

export async function simulate(opts: Options, log: (line: string) => void = console.log): Promise<Record<string, number>> {
  const rng = new Rng(opts.seed);
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  for (let burst = 1; burst <= opts.bursts; burst++) {
    const now = Date.now();
    const fingerprints = Array.from({ length: opts.services }, () => {
      const service = rng.pick(SERVICES);
      return { service, symptom: rng.pick(SYMPTOMS), id: `${service}/${rng.int(0, 2)}` };
    });

    const batch: { body: Body; key?: string }[] = [];
    for (const f of fingerprints) {
      if (!rng.chance(0.6)) continue;
      const alertCount = rng.int(1, 6);
      for (let k = 0; k < alertCount; k++) {
        const body: Body = {
          source: 'simulator',
          fingerprint: f.id,
          severity: rng.pick(SEVERITIES),
          title: `${f.service}: ${f.symptom}`,
          payload: { burst, sample: k, host: `${f.service}-${rng.int(1, 4)}` },
          // Up to 8 minutes in the past. Arrival order below is shuffled as well.
          ts: now - rng.int(0, 8 * 60_000),
        };
        batch.push({ body });
        if (rng.chance(0.25)) batch.push({ body }); // exact duplicate
      }
    }
    shuffleInPlace(batch, rng);

    for (const item of batch) {
      if (rng.chance(0.1)) {
        // A client retry: same Idempotency-Key, same body, sent twice.
        const key = `sim-${burst}-${rng.int(0, 1e9)}`;
        const first = await post(opts.url, opts.token, item.body, key);
        const retry = await post(opts.url, opts.token, item.body, key);
        bump(`${first.json.action ?? `http-${first.status}`}`);
        bump(retry.replayed ? 'idempotent-replay' : `retry-${retry.json.action ?? retry.status}`);
        continue;
      }
      const res = await post(opts.url, opts.token, item.body);
      bump(res.status === 202 ? String(res.json.action) : `http-${res.status}`);
    }

    log(`burst ${burst}/${opts.bursts}: ${batch.length} alerts`);
    await new Promise((r) => setTimeout(r, opts.gapMs));
  }
  return counts;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const config = loadConfig();
  const port = process.env.PORT ?? '8080';
  return {
    url: value('--url', `http://127.0.0.1:${port}`),
    token: value('--token', process.env.TRIAGE_INGEST_TOKEN ?? config.ingestToken),
    bursts: Number(value('--bursts', '40')),
    gapMs: Number(value('--gap', '1200')),
    services: Number(value('--services', '6')),
    seed: Number(value('--seed', String(Date.now() % 100000))),
  };
}

const invokedDirectly = process.argv[1]?.endsWith('simulate.ts');
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[simulate] ${opts.bursts} bursts against ${opts.url}`);
  simulate(opts)
    .then((counts) => {
      console.log('[simulate] outcomes:', counts);
    })
    .catch((err: unknown) => {
      console.error('[simulate] failed. Is the server running?', err);
      process.exit(1);
    });
}
