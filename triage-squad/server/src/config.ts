import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  dbPath: string;
  ingestToken: string;
  sessionTtlMs: number;
  webDir: string | null;
  cookieSecure: boolean;
  sseHeartbeatMs: number;
  sweepIntervalMs: number;
}

export const DEFAULT_INGEST_TOKEN = 'dev-ingest-token';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Reads configuration from the environment.
 * TRIAGE_DB (default data/triage.db), TRIAGE_WEB_DIR ('none' disables static serving, default web/dist),
 * TRIAGE_INGEST_TOKEN, TRIAGE_SESSION_HOURS (default 12), TRIAGE_COOKIE_SECURE=1.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const hours = Number(env.TRIAGE_SESSION_HOURS);
  const sessionHours = env.TRIAGE_SESSION_HOURS && Number.isFinite(hours) && hours > 0 ? hours : 12;
  const webEnv = env.TRIAGE_WEB_DIR;

  return {
    dbPath: env.TRIAGE_DB || resolve(PROJECT_ROOT, 'data/triage.db'),
    ingestToken: env.TRIAGE_INGEST_TOKEN || DEFAULT_INGEST_TOKEN,
    sessionTtlMs: sessionHours * 3_600_000,
    webDir: webEnv === 'none' ? null : webEnv ? resolve(webEnv) : resolve(PROJECT_ROOT, 'web/dist'),
    cookieSecure: env.TRIAGE_COOKIE_SECURE === '1',
    sseHeartbeatMs: 15_000,
    sweepIntervalMs: 1_000,
  };
}
