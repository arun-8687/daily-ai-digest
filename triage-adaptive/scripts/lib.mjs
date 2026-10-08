// Shared helpers for scripts/start.mjs and scripts/dev.mjs. Plain Node, no packages.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_TS_FLAGS = ['--disable-warning=ExperimentalWarning', '--import', 'tsx'];
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Runs a command in the project root with inherited stdio. Exits the process on failure. */
export function runOrExit(cmd, args, label) {
  console.log(`\n> ${label ?? [cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`Command failed with status ${r.status}: ${label ?? cmd}`);
    process.exit(r.status ?? 1);
  }
}

/** npm install when node_modules is missing. */
export function ensureDependencies() {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) return;
  runOrExit(NPM, ['install'], 'npm install (node_modules is missing)');
}

export function npmRun(script) {
  runOrExit(NPM, ['run', script]);
}

/** The database file the server will open: TRIAGE_DB, or data/triage.db under the project root. */
export function databasePath(env = process.env) {
  return env.TRIAGE_DB ? path.resolve(ROOT, env.TRIAGE_DB) : path.join(ROOT, 'data', 'triage.db');
}

/**
 * True when the file holds at least one user. The seed creates users first and renames the finished
 * database into place, so a user is the mark of a complete seed. A missing or unreadable file counts as
 * unseeded. The probe runs in a child process so node:sqlite's experimental warning stays out of the
 * launcher's output.
 */
function hasUsers(dbPath) {
  const probe = `
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try {
      db = new DatabaseSync(process.argv[1], { readOnly: true });
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
      process.exitCode = n > 0 ? 0 : 1;
    } catch {
      process.exitCode = 1;
    } finally {
      db?.close();
    }`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', probe, dbPath], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Seeds the database with the default 10,000-incident simulation when it is missing or has no users.
 * A database that has users is left alone, even if it was made by an older, interrupted seed; pass
 * --reset to tools/seed.ts to rebuild it.
 */
export function ensureSeeded(env = process.env) {
  const dbPath = databasePath(env);
  if (fs.existsSync(dbPath) && hasUsers(dbPath)) return dbPath;
  console.log(`\nNo seeded database at ${dbPath}; seeding a demo database (10,000 incidents, about 10 seconds).`);
  runOrExit(process.execPath, [...NODE_TS_FLAGS, 'tools/seed.ts', '--db', dbPath], 'node tools/seed.ts');
  return dbPath;
}
