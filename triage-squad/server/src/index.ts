// Entry point: loads config, ensures demo users, runs one SLA sweep, listens, and stops cleanly on SIGINT/SIGTERM.
import { createTriageApp } from './app';
import { loadConfig } from './config';
import { sweepSla } from './sla';
import { ensureDemoUsers } from './users';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createTriageApp(config);
  await ensureDemoUsers(app.ctx);
  sweepSla(app.ctx);

  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got ${process.env.PORT}`);
  }
  const host = process.env.TRIAGE_HOST || '127.0.0.1';
  const bound = await app.start(port, host);
  console.log(
    `Triage listening on http://${host}:${bound} (db ${config.dbPath}, web ${config.webDir ?? 'disabled'})`,
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
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
