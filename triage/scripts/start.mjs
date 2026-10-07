#!/usr/bin/env node
// One command to install, build, seed, and run Triage:
//
//   npm start
//
// Steps are skipped when their output already exists, so later runs start in seconds.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const dbPath = process.env.TRIAGE_DB ? resolve(root, process.env.TRIAGE_DB) : join(root, 'data', 'triage.db');
const port = process.env.PORT ?? '8080';
const nodeFlags = ['--disable-warning=ExperimentalWarning', '--import', 'tsx'];

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    console.error(`\n[triage] "${[cmd, ...args].join(' ')}" failed (exit ${result.status ?? 'signal'}).`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(join(root, 'node_modules'))) {
  console.log('[triage] installing dependencies (first run only)...');
  run(npm, ['install', '--no-audit', '--no-fund']);
}

console.log('[triage] building the web app...');
run(npm, ['run', 'build', '--silent']);

if (!existsSync(dbPath)) {
  console.log('[triage] seeding the demo database (10,000 incidents, 3 users)...');
  run(process.execPath, [...nodeFlags, 'tools/seed.ts']);
}

console.log(`[triage] starting on http://127.0.0.1:${port}`);
const child = spawn(process.execPath, [...nodeFlags, 'server/src/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
