// End-to-end config. Playwright starts the real server on a seeded temp database and drives two browsers.
//
// Seeding happens in the webServer command, not in a globalSetup: Playwright 1.56 starts webServer
// plugins before globalSetup hooks, so a globalSetup seed would run after the server had already
// created its demo users, and the seed would be a no-op. Seeding first keeps the database ready when
// the server opens it.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 5181;
/** A fixed path, deleted and rebuilt by the seed step on every run. Override with TRIAGE_E2E_DB. */
const dbPath = process.env.TRIAGE_E2E_DB || path.join(os.tmpdir(), 'triage-e2e', 'e2e.db');
const NODE = 'node --disable-warning=ExperimentalWarning --import tsx';

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: process.env.TRIAGE_CHROMIUM || undefined,
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: [
      'npm run build',
      `${NODE} tools/seed.ts --reset --count 300 --db ${JSON.stringify(dbPath)}`,
      `${NODE} server/src/index.ts`,
    ].join(' && '),
    cwd: root,
    env: { PORT: String(PORT), TRIAGE_DB: dbPath },
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
