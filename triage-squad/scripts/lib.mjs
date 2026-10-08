// Helpers shared by scripts/start.mjs and scripts/dev.mjs. Plain Node, no dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
/** Node flags that run TypeScript through tsx and silence the node:sqlite experimental warning. */
export const TSX_FLAGS = ['--disable-warning=ExperimentalWarning', '--import', 'tsx'];

/** TRIAGE_DB as given, or data/triage.db under the project root. Relative paths are relative to the project root. */
export function databasePath() {
  return process.env.TRIAGE_DB || join(ROOT, 'data', 'triage.db');
}

/** Runs a command in the project root and exits this process if it fails. */
export function runStep(label, cmd, args) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${result.status ?? result.signal}).`);
    process.exit(result.status ?? 1);
  }
}

/** Installs dependencies when node_modules is missing. */
export function ensureInstalled() {
  if (!existsSync(join(ROOT, 'node_modules'))) {
    runStep('install dependencies', NPM, ['install']);
  }
}

/** Seeds the database when the file is missing. An existing database is never touched. */
export function ensureSeeded(dbPath) {
  if (existsSync(resolve(ROOT, dbPath))) return;
  console.log(`\nNo database at ${dbPath}. Seeding 10,000 incidents of demo history.`);
  runStep('seed database', process.execPath, [...TSX_FLAGS, 'tools/seed.ts', '--db', dbPath]);
}
