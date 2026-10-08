// Seeds the e2e database with 300 incidents of history.
//
// Playwright starts the webServer before globalSetup runs, so the server has already opened the database and created
// the demo users. The seed therefore runs with --force, which skips its "users already exist" guard. The database is
// in WAL mode, so the seed and the server can share it. The seed runs in a child process, so this file does not load
// the server modules into the Playwright runner.
import { spawnSync } from 'node:child_process';
import type { FullConfig } from '@playwright/test';
import { E2E_DB_PATH, E2E_INCIDENT_COUNT, ROOT } from './paths';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      'tools/seed.ts',
      '--db',
      E2E_DB_PATH,
      '--count',
      String(E2E_INCIDENT_COUNT),
      '--force',
    ],
    { cwd: ROOT, stdio: 'inherit', env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`e2e seed failed (exit ${result.status ?? result.signal})`);
  }
}
