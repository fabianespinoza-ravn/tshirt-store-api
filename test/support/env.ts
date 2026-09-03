// Jest `setupFiles`: runs in the test process before each e2e file loads,
// so the application under test finds its whole configuration here.
//
// DATABASE_URL is overwritten on purpose, not defaulted: a developer shell
// or a .env that points at the development database must never be what the
// suite truncates. Everything else is a placeholder the validation schema
// accepts; nothing in the authentication flow connects to Redis or S3.
// reflect-metadata first: env.validation.ts declares a decorated class, and
// a decorator that runs before the polyfill loads records no `design:type`,
// which is what class-transformer needs to turn "3010" into a number. Nest
// loads the polyfill itself in the application; here this file is the
// first thing the test process imports.
import 'reflect-metadata';
import { NodeEnv } from '../../src/config/env.validation';
import { e2eDatabaseUrl } from './e2e-database-url';

const E2E_ENV: Record<string, string> = {
  NODE_ENV: NodeEnv.Test,
  PORT: '3010',
  DATABASE_URL: e2eDatabaseUrl(),
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_ACCESS_SECRET: 'e2e-access-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret',
  JWT_REFRESH_TTL: '7d',
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'tshirt-store-e2e',
  AWS_S3_ENDPOINT: 'http://localhost:9000',
  AWS_ACCESS_KEY_ID: 'e2e',
  AWS_SECRET_ACCESS_KEY: 'e2e-secret',
};

for (const [key, value] of Object.entries(E2E_ENV)) {
  process.env[key] = value;
}
