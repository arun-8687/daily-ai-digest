// One command to run Triage: install (if needed), build, seed (if the database is missing), then serve.
// Usage: npm start    (PORT defaults to 8080; TRIAGE_DB picks the database file)
import { spawn } from 'node:child_process';
import { ROOT, NODE_TS_FLAGS, ensureDependencies, ensureSeeded, npmRun } from './lib.mjs';

ensureDependencies();
npmRun('build');
const dbPath = ensureSeeded();

const port = process.env.PORT || '8080';
console.log(`\nStarting Triage on port ${port} with database ${dbPath}`);
const child = spawn(process.execPath, [...NODE_TS_FLAGS, 'server/src/index.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

// Forward termination to the server, which closes its streams and database before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  // A signal we forwarded is a clean stop; anything else is passed through as the exit status.
  process.exit(signal ? 0 : (code ?? 0));
});
