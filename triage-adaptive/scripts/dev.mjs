// Development: the API under tsx watch, and the Vite dev server (which proxies /api, /ingest and /healthz to the API).
// Usage: npm run dev   (API on PORT, default 8080; Vite on 5173)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, ensureDependencies, ensureSeeded } from './lib.mjs';

ensureDependencies();
ensureSeeded();

const apiPort = process.env.PORT || '8080';
const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const viteCli = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const children = [];
let exiting = false;

function start(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code, signal) => {
    if (exiting) return;
    console.log(`${label} exited (${signal ?? `code ${code}`}); stopping the others.`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300).unref();
}

start('API', ['--disable-warning=ExperimentalWarning', tsxCli, 'watch', 'server/src/index.ts'], { PORT: apiPort });
start('Vite', [viteCli], { TRIAGE_API: `http://127.0.0.1:${apiPort}` });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
process.on('exit', () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});
