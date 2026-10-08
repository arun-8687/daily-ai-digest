import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root: this file lives in <root>/server/src. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_INGEST_TOKEN = 'dev-ingest-token';

export interface AppConfig {
  dbPath: string;
  ingestToken: string;
  sessionTtlMs: number;
  webDir: string | null;
  cookieSecure: boolean;
  sseHeartbeatMs: number;
  sweepIntervalMs: number;
}

const DEFAULT_SESSION_HOURS = 12;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const hours = Number(env.TRIAGE_SESSION_HOURS);
  const sessionHours = env.TRIAGE_SESSION_HOURS !== undefined && Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_SESSION_HOURS;
  const webEnv = env.TRIAGE_WEB_DIR;
  return {
    dbPath: env.TRIAGE_DB || path.join(ROOT, 'data', 'triage.db'),
    ingestToken: env.TRIAGE_INGEST_TOKEN || DEFAULT_INGEST_TOKEN,
    sessionTtlMs: sessionHours * 3_600_000,
    webDir: webEnv === 'none' ? null : webEnv || path.join(ROOT, 'web', 'dist'),
    cookieSecure: env.TRIAGE_COOKIE_SECURE === '1',
    sseHeartbeatMs: 15_000,
    sweepIntervalMs: 1_000,
  };
}
