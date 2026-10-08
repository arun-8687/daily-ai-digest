// Playwright config for the end-to-end race test. The server runs from source on port 5180 against a fresh temp DB.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E_BASE_URL, E2E_DB_PATH, E2E_HOST, E2E_PORT, ROOT } from './paths';

// The runner loads this file, and each worker loads it again. Only the runner has no TRIAGE_E2E_DB yet. It clears the
// previous run's database and exports the path, and workers inherit it, so all processes use one file.
if (process.env.TRIAGE_E2E_DB === undefined) {
  rmSync(dirname(E2E_DB_PATH), { recursive: true, force: true });
  mkdirSync(dirname(E2E_DB_PATH), { recursive: true });
  process.env.TRIAGE_E2E_DB = E2E_DB_PATH;
}

export default defineConfig({
  testDir: '.',
  testMatch: 'triage.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    // TRIAGE_CHROMIUM points at a preinstalled Chromium. Unset, Playwright uses its own browser.
    launchOptions: { executablePath: process.env.TRIAGE_CHROMIUM || undefined },
  },
  webServer: {
    command: 'npm run build && node --disable-warning=ExperimentalWarning --import tsx server/src/index.ts',
    cwd: ROOT,
    url: `${E2E_BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...(process.env as Record<string, string>),
      PORT: String(E2E_PORT),
      TRIAGE_HOST: E2E_HOST,
      TRIAGE_DB: E2E_DB_PATH,
    },
  },
});
