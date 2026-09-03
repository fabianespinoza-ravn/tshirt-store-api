import { createE2eApp, type E2eApp } from './support/app';

/**
 * The one file that keeps the rate limiter's counters between requests:
 * `resetData` empties the tables and the recorded mail but leaves the
 * throttler alone, so the sixth hit on a route limited to five a minute is
 * the one that has to answer 429. Everywhere else `reset` clears the
 * counters too.
 */
describe('Rate limiting (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  beforeEach(async () => {
    await e2e.resetData();
  });

  it.todo(
    'answers 429 rate-limited to the sixth sign-up from the same address within a minute',
  );
});
