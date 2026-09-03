import { createE2eApp, type E2eApp } from './support/app';

/**
 * The first of the three end-to-end flows the program mandates: real HTTP
 * requests against the real application over the e2e database, asserting
 * on the response and on the state the request left behind.
 *
 * Harness only. The fixtures in test/support/fixtures.ts sign up, confirm,
 * sign in and mint an expired token; the assertions are the student's
 * (CLAUDE.md, Tests). The protected route is PATCH /api/v1/auth/password,
 * the only one a client can call today.
 */
describe('Authentication (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    // Optional on purpose: if createE2eApp threw, there is nothing to close
    // and the real error must be the one that surfaces.
    await e2e?.close();
  });

  beforeEach(async () => {
    await e2e.reset();
  });

  it.todo(
    'signs up, confirms the email from the recorded token and signs in: 201, 204 and 200 with an access token and a refresh cookie',
  );
  it.todo(
    'lets a verified client reach PATCH /auth/password with its access token',
  );
  it.todo('rejects the same route without a token with 401');
  it.todo('rejects the same route with a malformed token with 401');
  it.todo('rejects the same route with an expired token with 401');
  it.todo(
    'refuses sign-in before the email is confirmed with 403 email-not-verified',
  );
});
