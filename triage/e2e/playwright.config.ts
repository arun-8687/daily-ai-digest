import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { BASE_URL, E2E_DB, E2E_PORT } from './paths';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: fileURLToPath(new URL('./global-setup.ts', import.meta.url)),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Set TRIAGE_CHROMIUM to reuse a system or preinstalled Chromium instead of Playwright's download.
    launchOptions: { executablePath: process.env.TRIAGE_CHROMIUM || undefined },
  },
  webServer: {
    command: 'npm run build && node --disable-warning=ExperimentalWarning --import tsx server/src/index.ts',
    cwd: root,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: String(E2E_PORT),
      TRIAGE_DB: E2E_DB,
      TRIAGE_WEB_DIR: `${root}web/dist`,
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
