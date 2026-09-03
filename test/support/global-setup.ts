// Jest `globalSetup`: runs once per e2e run, before any file. It makes sure
// the test database exists and matches schema.prisma, with the same
// plan-refuse-apply step a deploy uses, so a suite never runs against a
// schema that drifted from the one the code was written for.
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { e2eDatabaseUrl } from './e2e-database-url';

const MAINTENANCE_DATABASE = 'postgres';
const SAFE_DATABASE_NAME = /^[a-z_][a-z0-9_]*$/;

async function ensureDatabaseExists(target: URL): Promise<void> {
  const database = target.pathname.slice(1);
  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error(`e2e: refusing to create a database named "${database}"`);
  }

  const maintenance = new URL(target.href);
  maintenance.pathname = `/${MAINTENANCE_DATABASE}`;
  const client = new PrismaClient({ datasourceUrl: maintenance.href });

  try {
    const rows = await client.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${database}) AS "exists"
    `;
    if (!rows[0]?.exists) {
      await client.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await client.$disconnect();
  }
}

function syncSchema(target: URL): void {
  // One command string through the shell, so `npm` resolves to npm.cmd on
  // Windows too; nothing user-controlled is interpolated into it.
  const result = spawnSync('npm run prisma:sync --silent', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: target.href },
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error('e2e: prisma:sync failed against the test database');
  }
}

export default async function globalSetup(): Promise<void> {
  const target = new URL(e2eDatabaseUrl());
  await ensureDatabaseExists(target);
  syncSchema(target);
}
