import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface AppConfig {
  dbPath: string;
  ingestToken: string;
  sessionTtlMs: number;
  /** Directory with the built web app. Null disables static serving (API only). */
  webDir: string | null;
  cookieSecure: boolean;
  sseHeartbeatMs: number;
  sweepIntervalMs: number;
}

export const DEFAULT_INGEST_TOKEN = 'dev-ingest-token';
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const hours = Number(env.TRIAGE_SESSION_HOURS ?? 12);
  return {
    dbPath: resolve(env.TRIAGE_DB ?? 'data/triage.db'),
    ingestToken: env.TRIAGE_INGEST_TOKEN || DEFAULT_INGEST_TOKEN,
    sessionTtlMs: (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000,
    webDir: env.TRIAGE_WEB_DIR === 'none' ? null : resolve(env.TRIAGE_WEB_DIR ?? DEFAULT_WEB_DIR),
    cookieSecure: env.TRIAGE_COOKIE_SECURE === '1',
    sseHeartbeatMs: 15_000,
    sweepIntervalMs: 1_000,
  };
}
