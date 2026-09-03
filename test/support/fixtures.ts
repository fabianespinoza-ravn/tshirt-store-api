import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import type { AccessTokenPayload } from '../../src/auth/token.service';
import type { E2eApp } from './app';
import { MailKind } from './mail-recorder';

const AUTH = '/api/v1/auth';
const REFRESH_COOKIE = 'refreshToken';

export interface Credentials {
  email: string;
  password: string;
}

export interface Session {
  accessToken: string;
  /** The raw `Set-Cookie` header carrying the refresh token, for `refresh` and `sign-out`. */
  refreshCookie: string;
  user: { id: string; email: string; role: UserRole };
}

let counter = 0;

/** A fresh, valid address and password for one test. */
export function someCredentials(): Credentials {
  counter += 1;
  return {
    email: `e2e-${counter}-${Date.now()}@example.test`,
    password: 'long-e2e-password',
  };
}

// Fixtures fail loudly when the application does not answer what the flow
// needs, because a test built on a half-made account would assert the wrong
// thing. That is setup integrity, not an assertion about behaviour: the
// assertions live in the *.e2e-spec.ts files and are the student's.
function expectStatus(step: string, actual: number, wanted: number): void {
  if (actual !== wanted) {
    throw new Error(`${step}: expected HTTP ${wanted}, got ${actual}`);
  }
}

/**
 * Signs up over HTTP, reads the verification token the flow sent, and
 * confirms it: the account ends ACTIVE with a password, exactly the way a
 * real client gets there. Returns the credentials to sign in with.
 */
export async function signUpVerified(
  e2e: E2eApp,
  credentials: Credentials = someCredentials(),
): Promise<Credentials> {
  const signedUp = await e2e
    .request()
    .post(`${AUTH}/sign-up`)
    .send(credentials);
  expectStatus('sign-up', signedUp.status, 201);

  const token = e2e.mail.lastTokenFor(credentials.email, MailKind.Verification);
  if (!token) {
    throw new Error('sign-up: no verification token was recorded');
  }

  const confirmed = await e2e
    .request()
    .post(`${AUTH}/email-verifications/confirm`)
    .send({ token });
  expectStatus('email-verifications/confirm', confirmed.status, 204);

  return credentials;
}

/** Signs in and returns the access token, the refresh cookie and the session user. */
export async function signIn(
  e2e: E2eApp,
  credentials: Credentials,
): Promise<Session> {
  const response = await e2e
    .request()
    .post(`${AUTH}/sign-in`)
    .send(credentials);
  expectStatus('sign-in', response.status, 200);

  const body = response.body as {
    accessToken: string;
    user: Session['user'];
  };
  const cookies = response.headers['set-cookie'] as unknown as
    string[] | undefined;
  const refreshCookie = cookies?.find((cookie) =>
    cookie.startsWith(`${REFRESH_COOKIE}=`),
  );
  if (!refreshCookie) {
    throw new Error('sign-in: no refresh cookie was set');
  }

  return { accessToken: body.accessToken, refreshCookie, user: body.user };
}

/**
 * A manager is not something the API can create — sign-up only makes
 * clients — so the role is set on the row directly. Fixture, not API.
 */
export async function promoteToManager(
  e2e: E2eApp,
  email: string,
): Promise<void> {
  await e2e.prisma.user.update({
    where: { liveEmail: email },
    data: { role: UserRole.MANAGER },
  });
}

/**
 * An access token signed with the application's own secret and already
 * expired: what the guard sees from a client that kept a stale token.
 */
export function expiredAccessToken(e2e: E2eApp, user: Session['user']): string {
  const payload: AccessTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };
  return e2e.app.get(JwtService).sign(payload, { expiresIn: -1 });
}

/** Not a JWT at all, for the "malformed token" case. */
export const MALFORMED_ACCESS_TOKEN = 'not.a.jwt';
