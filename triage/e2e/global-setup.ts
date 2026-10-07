import { rmSync } from 'node:fs';
import { seedDatabase } from '../tools/seed';
import { E2E_DB } from './paths';

export default async function globalSetup(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) rmSync(E2E_DB + suffix, { force: true });
  await seedDatabase({ dbPath: E2E_DB, incidents: 300 });
}
