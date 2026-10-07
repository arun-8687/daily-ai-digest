#!/usr/bin/env node
// Development mode: API with auto-restart on change, and the Vite dev server with hot reload.
//
//   npm run dev        # web on http://localhost:5173, API on :8080 (proxied)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const dbPath = process.env.TRIAGE_DB ? resolve(root, process.env.TRIAGE_DB) : join(root, 'data', 'triage.db');
const nodeFlags = ['--disable-warning=ExperimentalWarning', '--import', 'tsx'];

if (!existsSync(join(root, 'node_modules'))) {
  const r = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(dbPath)) {
  spawnSync(process.execPath, [...nodeFlags, 'tools/seed.ts'], { cwd: root, stdio: 'inherit' });
}

const api = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'server/src/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TRIAGE_WEB_DIR: 'none', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --disable-warning=ExperimentalWarning`.trim() },
});
const web = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: root,
  stdio: 'inherit',
});

const stop = () => {
  api.kill('SIGTERM');
  web.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  web.kill('SIGTERM');
  process.exit(code ?? 0);
});
web.on('exit', (code) => {
  api.kill('SIGTERM');
  process.exit(code ?? 0);
});
