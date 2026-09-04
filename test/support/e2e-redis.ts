// The same shape as `e2e-database-url.ts`, and for the same reason: the
// suite never reads a developer's .env.
//
// The default is the port docker-compose.yml publishes, 6380, because 6379
// was already taken on the machine this was built on. CI publishes a service
// container on the usual 6379 and says so through E2E_REDIS_PORT, so the
// two environments disagree about the port and neither is wrong.
//
// Until block 4 nothing in the suite connected to Redis and this was a
// placeholder nobody checked. BullMQ makes it real: with the wrong port the
// application does not boot.
export const DEFAULT_E2E_REDIS_HOST = 'localhost';
export const DEFAULT_E2E_REDIS_PORT = '6380';

export function e2eRedisHost(): string {
  return process.env.E2E_REDIS_HOST ?? DEFAULT_E2E_REDIS_HOST;
}

export function e2eRedisPort(): string {
  return process.env.E2E_REDIS_PORT ?? DEFAULT_E2E_REDIS_PORT;
}
