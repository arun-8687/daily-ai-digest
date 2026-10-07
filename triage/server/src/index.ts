import { createTriageApp } from './app';
import { DEFAULT_INGEST_TOKEN, loadConfig } from './config';
import { sweepSla } from './sla';
import { ensureDemoUsers } from './users';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createTriageApp(config);

  await ensureDemoUsers(app.ctx);
  // Catch up on SLA breaches that came due while the server was down.
  const caughtUp = sweepSla(app.ctx);
  if (caughtUp > 0) console.log(`[triage] marked ${caughtUp} overdue incident(s) as SLA-breached on startup`);

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.TRIAGE_HOST ?? '127.0.0.1';
  const bound = await app.start(port, host);
  console.log(`[triage] listening on http://${host}:${bound}`);
  console.log(`[triage] database: ${config.dbPath}`);
  if (config.ingestToken === DEFAULT_INGEST_TOKEN) {
    console.warn('[triage] using the default ingest token. Set TRIAGE_INGEST_TOKEN before exposing this server.');
  }

  const shutdown = (signal: string) => {
    console.log(`[triage] ${signal} received, shutting down`);
    app
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[triage] failed to start', err);
  process.exit(1);
});
