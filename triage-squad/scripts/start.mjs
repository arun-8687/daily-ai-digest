#!/usr/bin/env node
// npm start: install if needed, build the web app, seed the database if it is missing, then run the server.
// SIGINT and SIGTERM are forwarded to the server, which shuts down cleanly.
import { spawn } from 'node:child_process';
import { ROOT, NPM, TSX_FLAGS, databasePath, ensureInstalled, ensureSeeded, runStep } from './lib.mjs';

ensureInstalled();
runStep('build web app', NPM, ['run', 'build']);

const dbPath = databasePath();
ensureSeeded(dbPath);

const port = process.env.PORT || '8080';
console.log(`\n==> starting Triage on http://127.0.0.1:${port} (database ${dbPath})`);

const server = spawn(process.execPath, [...TSX_FLAGS, 'server/src/index.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: port, TRIAGE_DB: dbPath },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (server.exitCode === null && server.signalCode === null) server.kill(signal);
  });
}

server.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 0 : 1));
});
