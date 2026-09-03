import { Problems } from '../src/common/problem/problem.catalog';
import { createE2eApp, type E2eApp } from './support/app';
import { someCredentials } from './support/fixtures';

const AUTH = '/api/v1/auth';

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

  it('answers 429 rate-limited to the sixth sign-up from the same address within a minute', async () => {
    const credentials = someCredentials();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await e2e
        .request()
        .post(`${AUTH}/sign-up`)
        .send(credentials);
      expect(response.status).toBe(201);
    }

    const limited = await e2e
      .request()
      .post(`${AUTH}/sign-up`)
      .send(credentials);

    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ type: Problems.rateLimited.type });
    const user = await e2e.prisma.user.findUnique({
      where: { liveEmail: credentials.email },
    });
    if (!user) throw new Error('sign-up: expected the registered user');
    expect(
      await e2e.prisma.emailVerificationToken.count({
        where: { userId: user.id },
      }),
    ).toBe(5);
  });
});
