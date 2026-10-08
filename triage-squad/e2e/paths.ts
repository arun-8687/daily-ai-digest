// Constants shared by the Playwright config, the global setup and the spec.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const E2E_PORT = 5180;
export const E2E_HOST = '127.0.0.1';
export const E2E_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;

/**
 * The database the e2e server uses. playwright.config.ts exports TRIAGE_E2E_DB in the runner before any worker starts,
 * so the runner, the workers and the server all agree on one file.
 */
export const E2E_DB_PATH = process.env.TRIAGE_E2E_DB || join(ROOT, 'data', 'e2e', 'triage-e2e.db');

/** Incidents the global setup seeds before the tests run. */
export const E2E_INCIDENT_COUNT = 300;

export const INGEST_TOKEN = process.env.TRIAGE_INGEST_TOKEN || 'dev-ingest-token';
/** Demo password for alice, bob and carol (see server/src/users.ts). */
export const DEMO_PASSWORD = 'triage-demo';
