import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import {
  aOneTimeToken,
  aRefreshToken,
  aUser,
  anUnverifiedUser,
} from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

/**
 * The expectations come from contract `1.0.2` and the ERD notes, not from
 * reading the implementation. The three sources cited:
 *
 * - `POST /auth/sign-up`: *"the response is the same whether or not the address
 *   already has an account"* and *"a registered address receives a sign-in
 *   reminder instead of a verification link"*.
 * - `users`: *"sign-in and account lookup require ACTIVE, email_verified_at IS
 *   NOT NULL, and deleted_at IS NULL"*.
 * - `email_verification_tokens`: *"pending_password_hash holds the credential
 *   until confirmation: it moves to users.password_hash in the same transaction
 *   that sets email_verified_at and state"*.
 */
const PLAIN = 'long-test-password';

describe('AuthService', () => {
  let h: ServiceHarness<AuthService>;
  let passwords: PasswordService;

  beforeEach(async () => {
    h = await buildService(AuthService);
    resetPrismaMock(h.prisma);
    passwords = new PasswordService();
    h.tokens.mintOneTime.mockReturnValue('plain-token');
    h.tokens.oneTimeDigest.mockReturnValue('token-hash');
  });

  // ------------------------------------------------------------------ signUp

  describe('signUp', () => {
    it('creates the account in GUEST with no credential in users', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);
      h.prisma.user.create.mockResolvedValue(anUnverifiedUser());

      await h.service.signUp('new@example.test', PLAIN);

      const created = h.prisma.user.create.mock.calls[0][0].data as {
        state: string;
        role: string;
      };
      expect(created.state).toBe('GUEST');
      expect(created.role).toBe('CLIENT');
      // The credential is parked in the token until confirmation: writing it
      // here would leave an account with a password nobody has verified.
      expect(created).not.toHaveProperty('passwordHash');
      expect(h.mail.sendVerificationLink).toHaveBeenCalledWith(
        'new@example.test',
        'plain-token',
      );
    });

    /**
     * The enumeration oracle, closed: an already-verified address produces no
     * write at all and gets a different email. From the outside, the two
     * responses are identical.
     */
    it('writes nothing and sends a reminder for an already verified address', async () => {
      h.prisma.user.findFirst.mockResolvedValue(aUser());

      await h.service.signUp('maria@example.test', PLAIN);

      expect(h.mail.sendSignInReminder).toHaveBeenCalledWith(
        'maria@example.test',
      );
      expect(h.mail.sendVerificationLink).not.toHaveBeenCalled();
      expect(h.prisma.user.create).not.toHaveBeenCalled();
      expect(h.prisma.emailVerificationToken.create).not.toHaveBeenCalled();
    });

    /**
     * The partial unique index on `email_verification_tokens` allows only one
     * live token per user, so reissuing forces the previous one to be
     * consumed first. Without that, the INSERT collides with the index.
     */
    it('consumes the live token before issuing a new one', async () => {
      h.prisma.user.findFirst.mockResolvedValue(anUnverifiedUser());

      await h.service.signUp('unverified@example.test', PLAIN);

      expect(h.prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ consumedAt: null }) as never,
        }) as never,
      );
      expect(h.prisma.emailVerificationToken.create).toHaveBeenCalled();
    });

    /**
     * The way out of the lockout: someone who signed up, never confirmed and
     * forgot their password signs up again, and the pending credential is
     * replaced with the new one. This is decision H26, closed together with
     * the oracle.
     */
    it('replaces the pending credential with the newly supplied one', async () => {
      const user = anUnverifiedUser();
      h.prisma.user.findFirst.mockResolvedValue(user);

      await h.service.signUp(user.email, 'a-new-long-password');

      const issued = h.prisma.emailVerificationToken.create.mock.calls[0][0]
        .data as { pendingPasswordHash: string; userId: string };
      expect(issued.userId).toBe(user.id);
      await expect(
        passwords.verify(issued.pendingPasswordHash, 'a-new-long-password'),
      ).resolves.toBe(true);
    });
  });

  // ------------------------------------------------------- verification

  describe('confirmEmailVerification', () => {
    /**
     * Confirming moves the parked credential to `users`, marks verification
     * and promotes to ACTIVE. The three writes go together because the
     * model's CHECKs relate them: a verified account always has a password,
     * and a GUEST is never verified.
     */
    it('moves the pending credential, verifies and promotes to ACTIVE', async () => {
      const user = anUnverifiedUser();
      const token = aOneTimeToken(user.id, {
        pendingPasswordHash: '$argon2id$parked',
      });
      h.prisma.emailVerificationToken.findUnique.mockResolvedValue(token);

      await h.service.confirmEmailVerification('plain-token');

      expect(h.prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: {
          passwordHash: '$argon2id$parked',
          emailVerifiedAt: expect.any(Date) as Date,
          state: 'ACTIVE',
        },
      });
      expect(h.prisma.emailVerificationToken.update).toHaveBeenCalledWith({
        where: { id: token.id },
        data: {
          consumedAt: expect.any(Date) as Date,
          pendingPasswordHash: null,
        },
      });
    });

    it.each([
      ['unknown', null],
      ['already consumed', { consumedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])('returns 404 for a token that is %s', async (_case, overrides) => {
      h.prisma.emailVerificationToken.findUnique.mockResolvedValue(
        overrides === null ? null : aOneTimeToken('user-1', overrides),
      );

      await expect(
        h.service.confirmEmailVerification('plain-token'),
      ).rejects.toMatchObject({
        kind: Problems.emailVerificationTokenNotFound,
      });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ signIn

  describe('signIn', () => {
    const withCredential = async (overrides = {}) =>
      aUser({ passwordHash: await passwords.hash(PLAIN), ...overrides });

    it('opens a session for a verified account with the right password', async () => {
      h.prisma.user.findFirst.mockResolvedValue(await withCredential());
      h.tokens.signAccessToken.mockReturnValue('jwt');
      h.tokens.startFamily.mockResolvedValue({
        token: 'refresh',
        expiresAt: new Date(),
      });

      await expect(
        h.service.signIn('ana@example.test', PLAIN),
      ).resolves.toMatchObject({ accessToken: 'jwt' });
    });

    it('returns 401 for a wrong password', async () => {
      h.prisma.user.findFirst.mockResolvedValue(await withCredential());

      await expect(
        h.service.signIn('ana@example.test', 'another-long-password'),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
    });

    it('returns 401 for an address with no account', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        h.service.signIn('nobody@example.test', PLAIN),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
    });

    /**
     * **The order of checks is what decides what leaks.** With the wrong
     * password on an unverified account, the response has to be 401 and not
     * 403: if it were 403, anyone could find out which addresses are
     * registered just by trying a made-up password, which is exactly what
     * sign-up and forgot-password go out of their way not to say.
     */
    it('returns 401, never 403, when the password is wrong on an unverified account', async () => {
      const user = anUnverifiedUser();
      h.prisma.user.findFirst.mockResolvedValue(user);
      h.prisma.emailVerificationToken.findFirst.mockResolvedValue({
        pendingPasswordHash: await passwords.hash(PLAIN),
      } as never);

      await expect(
        h.service.signIn(user.email, 'wrong-long-password'),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
    });

    it('returns 403 only when the password is right and the email is unverified', async () => {
      const user = anUnverifiedUser();
      h.prisma.user.findFirst.mockResolvedValue(user);
      h.prisma.emailVerificationToken.findFirst.mockResolvedValue({
        pendingPasswordHash: await passwords.hash(PLAIN),
      } as never);

      await expect(h.service.signIn(user.email, PLAIN)).rejects.toMatchObject({
        kind: Problems.emailNotVerified,
      });
    });

    /** The ERD's three guards, deliberately not merged. */
    it('refuses a verified account that is not ACTIVE', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        await withCredential({ state: 'GUEST' }),
      );

      await expect(
        h.service.signIn('ana@example.test', PLAIN),
      ).rejects.toMatchObject({ kind: Problems.emailNotVerified });
    });

    /**
     * `email` isn't unique in Prisma because the model's unique index is
     * partial: `UNIQUE (email) WHERE deleted_at IS NULL`. Forgetting the
     * `deletedAt: null` would return a deleted account as if it were live.
     */
    it('scopes the lookup to accounts that are not deleted', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        h.service.signIn('ana@example.test', PLAIN),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
      expect(h.prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'ana@example.test', deletedAt: null },
      });
    });
  });

  // ------------------------------------------------------------ password

  describe('forgotPassword', () => {
    it('issues a reset token for an eligible account', async () => {
      const user = aUser();
      h.prisma.user.findFirst.mockResolvedValue(user);

      await h.service.forgotPassword(user.email);

      expect(h.prisma.passwordResetToken.create).toHaveBeenCalled();
      expect(h.mail.sendPasswordReset).toHaveBeenCalledWith(
        user.email,
        'plain-token',
      );
    });

    /** 202 always: it can't be told apart from the outside. */
    it.each([
      ['unknown', null],
      ['unverified', anUnverifiedUser()],
    ])(
      'writes nothing and sends nothing for an address that is %s',
      async (_case, user) => {
        h.prisma.user.findFirst.mockResolvedValue(user);

        await expect(
          h.service.forgotPassword('whoever@example.test'),
        ).resolves.toBeUndefined();
        expect(h.prisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(h.mail.sendPasswordReset).not.toHaveBeenCalled();
      },
    );
  });

  describe('resetPassword', () => {
    it('sets the new credential and revokes every family', async () => {
      const token = aOneTimeToken('user-1');
      h.prisma.passwordResetToken.findUnique.mockResolvedValue(token);

      await h.service.resetPassword('plain-token', 'new-long-password');

      const written = h.prisma.user.update.mock.calls[0][0].data as {
        passwordHash: string;
      };
      await expect(
        passwords.verify(written.passwordHash, 'new-long-password'),
      ).resolves.toBe(true);
      expect(h.tokens.revokeAllForUser).toHaveBeenCalledWith('user-1');
    });

    it.each([
      ['unknown', null],
      ['already consumed', { consumedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])('returns 404 for a token that is %s', async (_case, overrides) => {
      h.prisma.passwordResetToken.findUnique.mockResolvedValue(
        overrides === null ? null : aOneTimeToken('user-1', overrides),
      );

      await expect(
        h.service.resetPassword('plain-token', 'new-long-password'),
      ).rejects.toMatchObject({ kind: Problems.notFound });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
      expect(h.tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('revokes every family and sends the notification the brief requires', async () => {
      const user = aUser({ passwordHash: await passwords.hash(PLAIN) });
      h.prisma.user.findUnique.mockResolvedValue(user);

      await h.service.changePassword(user.id, PLAIN, 'new-long-password');

      expect(h.tokens.revokeAllForUser).toHaveBeenCalledWith(user.id);
      expect(h.mail.sendPasswordChanged).toHaveBeenCalledWith(user.email);
    });

    it('returns 401 when the current password does not match', async () => {
      const user = aUser({ passwordHash: await passwords.hash(PLAIN) });
      h.prisma.user.findUnique.mockResolvedValue(user);

      await expect(
        h.service.changePassword(
          user.id,
          'wrong-current-long-password',
          'another-long-password',
        ),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
      expect(h.tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('signOut', () => {
    it('revokes the family the presented cookie belongs to', async () => {
      h.prisma.refreshToken.findUnique.mockResolvedValue(
        aRefreshToken('user-1'),
      );

      await h.service.signOut('plain-refresh-token');

      expect(h.tokens.revokeFamilyOf).toHaveBeenCalledWith(
        'plain-refresh-token',
      );
    });

    it('does nothing without a cookie', async () => {
      await h.service.signOut(undefined);

      expect(h.tokens.revokeFamilyOf).not.toHaveBeenCalled();
    });
  });
});
