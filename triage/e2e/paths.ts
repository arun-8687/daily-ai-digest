import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The database the e2e server runs against. Seeded fresh on every run. */
export const E2E_DB = process.env.TRIAGE_E2E_DB ?? join(tmpdir(), `triage-e2e-${process.pid}.db`);
export const E2E_PORT = Number(process.env.TRIAGE_E2E_PORT ?? 5179);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
