#!/usr/bin/env node
// npm run dev: the API under tsx watch (restarts on change) and the Vite dev server, which proxies /api, /ingest
// and /healthz to the API. Open the Vite URL (http://127.0.0.1:5173). Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, databasePath, ensureInstalled, ensureSeeded } from './lib.mjs';

ensureInstalled();
const dbPath = databasePath();
ensureSeeded(dbPath);

const apiPort = process.env.PORT || '8080';
const apiUrl = process.env.TRIAGE_API || `http://127.0.0.1:${apiPort}`;

const api = spawn(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'server/src/index.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: apiPort, TRIAGE_DB: dbPath },
});

const web = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, TRIAGE_API: apiUrl },
});

const children = [api, web];
const running = (child) => child.exitCode === null && child.signalCode === null;

function stopAll(signal) {
  for (const child of children) {
    if (running(child)) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(signal));
}

// If either process exits, stop the other and exit with the same status.
for (const child of children) {
  child.on('exit', (code, signal) => {
    stopAll('SIGTERM');
    process.exit(code ?? (signal ? 0 : 1));
  });
}
