// Jest `setupFiles`: runs in the test process before each e2e file loads,
// so the application under test finds its whole configuration here.
//
// DATABASE_URL is overwritten on purpose, not defaulted: a developer shell
// or a local configuration file pointing at the development database must
// never be what the suite truncates. Redis is resolved the same way, because
// block 4 turned it from a placeholder nobody checked into a connection the
// application opens at boot. S3 and SMTP stay placeholders: the harness
// replaces both.
// reflect-metadata first: env.validation.ts declares a decorated class, and
// a decorator that runs before the polyfill loads records no `design:type`,
// which is what class-transformer needs to turn "3010" into a number. Nest
// loads the polyfill itself in the application; here this file is the
// first thing the test process imports.
import 'reflect-metadata';
import { NodeEnv } from '../../src/config/env.validation';
import { e2eDatabaseUrl } from './e2e-database-url';
import { e2eRedisHost, e2eRedisPort } from './e2e-redis';

const E2E_ENV: Record<string, string> = {
  NODE_ENV: NodeEnv.Test,
  PORT: '3010',
  DATABASE_URL: e2eDatabaseUrl(),
  REDIS_HOST: e2eRedisHost(),
  REDIS_PORT: e2eRedisPort(),
  // Its own namespace on a shared Redis. Without this a suite run and a
  // developer's worker would consume each other's jobs, and the failure
  // would look like a flaky test rather than what it is.
  QUEUE_PREFIX: 'tshirt-e2e',
  JWT_ACCESS_SECRET: 'e2e-access-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret',
  JWT_REFRESH_TTL: '7d',
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'tshirt-store-e2e',
  AWS_S3_ENDPOINT: 'http://localhost:9000',
  AWS_ACCESS_KEY_ID: 'e2e',
  AWS_SECRET_ACCESS_KEY: 'e2e-secret',
  // The suite reaches no real SMTP server — MailService is replaced in the
  // harness — so these only have to satisfy the validation schema. MAIL_FROM
  // carries an address because that schema now checks for one.
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'e2e',
  SMTP_PASSWORD: 'e2e-secret',
  MAIL_FROM: 'T-Shirt Store <store@example.test>',
  // Same reasoning as SMTP: StripeService is replaced in the harness, so the
  // suite never reaches Stripe and these only have to satisfy validation.
  STRIPE_SECRET_KEY: 'e2e-stripe-key',
  STRIPE_WEBHOOK_SECRET: 'e2e-stripe-webhook',
  STRIPE_CURRENCY: 'usd',
};

for (const [key, value] of Object.entries(E2E_ENV)) {
  process.env[key] = value;
}
