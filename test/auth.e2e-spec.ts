import { UserRole, UserState } from '@prisma/client';
import { Problems } from '../src/common/problem/problem.catalog';
import { createE2eApp, type E2eApp } from './support/app';
import {
  MALFORMED_ACCESS_TOKEN,
  expiredAccessToken,
  signIn,
  signUpVerified,
  someCredentials,
} from './support/fixtures';
import { MailKind } from './support/mail-recorder';

const AUTH = '/api/v1/auth';

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

  it('signs up, confirms the email from the recorded token and signs in: 201, 204 and 200 with an access token and a refresh cookie', async () => {
    const credentials = someCredentials();
    const signedUp = await e2e
      .request()
      .post(`${AUTH}/sign-up`)
      .send(credentials);

    expect(signedUp.status).toBe(201);
    expect(signedUp.body).toEqual({
      email: credentials.email,
      verificationRequired: true,
    });
    expect(
      await e2e.prisma.user.findUnique({
        where: { liveEmail: credentials.email },
      }),
    ).toMatchObject({
      email: credentials.email,
      passwordHash: null,
      emailVerifiedAt: null,
      state: UserState.GUEST,
    });

    const token = e2e.mail.lastTokenFor(
      credentials.email,
      MailKind.Verification,
    );
    expect(token).toEqual(expect.any(String));
    const confirmed = await e2e
      .request()
      .post(`${AUTH}/email-verifications/confirm`)
      .send({ token });

    expect(confirmed.status).toBe(204);
    expect(
      await e2e.prisma.user.findUnique({
        where: { liveEmail: credentials.email },
      }),
    ).toMatchObject({
      email: credentials.email,
      passwordHash: expect.stringMatching(/^\$argon2id\$/) as string,
      emailVerifiedAt: expect.any(Date) as Date,
      state: UserState.ACTIVE,
    });

    const signedIn = await e2e
      .request()
      .post(`${AUTH}/sign-in`)
      .send(credentials);

    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual(
      expect.objectContaining({
        accessToken: expect.any(String) as string,
        tokenType: 'Bearer',
        user: expect.objectContaining({
          email: credentials.email,
          role: UserRole.CLIENT,
        }) as { email: string; role: UserRole },
      }),
    );
    expect(signedIn.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^refreshToken=/)]),
    );
  });

  it('lets a verified client reach PATCH /auth/password with its access token', async () => {
    const credentials = await signUpVerified(e2e);
    const session = await signIn(e2e, credentials);
    const before = await e2e.prisma.user.findUnique({
      where: { id: session.user.id },
    });
    const newPassword = 'changed-e2e-password';

    const changed = await e2e
      .request()
      .patch(`${AUTH}/password`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: credentials.password, newPassword });

    expect(changed.status).toBe(204);
    const after = await e2e.prisma.user.findUnique({
      where: { id: session.user.id },
    });
    expect(after).toMatchObject({
      passwordHash: expect.any(String) as string,
      emailVerifiedAt: expect.any(Date) as Date,
      state: UserState.ACTIVE,
    });
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
  });

  it('rejects the same route without a token with 401', async () => {
    const response = await e2e.request().patch(`${AUTH}/password`).send({
      currentPassword: 'long-e2e-password',
      newPassword: 'new-password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects the same route with a malformed token with 401', async () => {
    const response = await e2e
      .request()
      .patch(`${AUTH}/password`)
      .set('Authorization', `Bearer ${MALFORMED_ACCESS_TOKEN}`)
      .send({
        currentPassword: 'long-e2e-password',
        newPassword: 'new-password',
      });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
    expect(response.headers['www-authenticate']).toContain('invalid_token');
  });

  it('rejects the same route with an expired token with 401', async () => {
    const credentials = await signUpVerified(e2e);
    const session = await signIn(e2e, credentials);
    const response = await e2e
      .request()
      .patch(`${AUTH}/password`)
      .set('Authorization', `Bearer ${expiredAccessToken(e2e, session.user)}`)
      .send({
        currentPassword: credentials.password,
        newPassword: 'new-password',
      });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
    expect(response.headers['www-authenticate']).toContain('invalid_token');
  });

  it('refuses sign-in before the email is confirmed with 403 email-not-verified', async () => {
    const credentials = someCredentials();
    await e2e.request().post(`${AUTH}/sign-up`).send(credentials);

    const signedIn = await e2e
      .request()
      .post(`${AUTH}/sign-in`)
      .send(credentials);

    expect(signedIn.status).toBe(403);
    expect(signedIn.body).toMatchObject({
      type: Problems.emailNotVerified.type,
    });
    expect(
      await e2e.prisma.user.findUnique({
        where: { liveEmail: credentials.email },
      }),
    ).toMatchObject({
      passwordHash: null,
      emailVerifiedAt: null,
      state: UserState.GUEST,
    });
  });
});
