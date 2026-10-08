import { createTriageApp } from './app';
import { systemClock } from './clock';
import { loadConfig } from './config';
import { sweepSla } from './sla';
import { ensureDemoUsers } from './users';

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`PORT must be an integer from 0 to 65535, got "${raw}"`);
  return n;
}

async function main(): Promise<void> {
  const env = process.env;
  const config = loadConfig(env);
  const app = createTriageApp(config, { clock: systemClock, timers: true });
  await ensureDemoUsers(app.ctx);
  sweepSla(app.ctx);

  const port = parsePort(env.PORT ?? '8080');
  const host = env.TRIAGE_HOST || '127.0.0.1';
  const bound = await app.start(port, host);
  console.log(`Triage listening on http://${host}:${bound}`);

  const shutdown = (signal: string): void => {
    console.log(`${signal} received, stopping`);
    app.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
