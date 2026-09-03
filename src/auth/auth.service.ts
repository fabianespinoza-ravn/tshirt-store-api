import { Injectable } from '@nestjs/common';
import { UserRole, UserState, type Prisma, type User } from '@prisma/client';
import { newId } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService, type IssuedRefreshToken } from './token.service';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

// A live user: not soft-deleted. Same shared-fragment pattern as
// ProductsService.NOT_DELETED, applied here to the User model.
const NOT_DELETED: Prisma.UserWhereInput = { deletedAt: null };

export interface SessionResult {
  accessToken: string;
  user: Pick<User, 'id' | 'email' | 'role'>;
  refresh: IssuedRefreshToken;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
  ) {}

  // email isn't unique to Prisma because the model's index is partial
  // (UNIQUE WHERE deleted_at IS NULL); the condition has to be repeated here
  // or a deleted account would come back as if it were live.
  private findLiveByEmail(email: string) {
    return this.prisma.user.findFirst({ where: { email, ...NOT_DELETED } });
  }

  // ------------------------------------------------------------- registration

  // Responds the same whether or not the address exists, so as not to be an
  // oracle of which emails are registered; if the account exists but isn't
  // verified, it reissues the link and replaces the pending credential,
  // letting someone who forgot their password before confirming recover
  // access.
  async signUp(email: string, password: string): Promise<void> {
    const pendingPasswordHash = await this.passwords.hash(password);
    const existing = await this.findLiveByEmail(email);

    if (existing?.emailVerifiedAt) {
      await this.mail.sendSignInReminder(email);
      return;
    }

    const token = this.tokens.mintOneTime();

    await this.prisma.$transaction(async (tx) => {
      const userId =
        existing?.id ??
        (
          await tx.user.create({
            data: {
              id: newId(),
              email,
              role: UserRole.CLIENT,
              state: UserState.GUEST,
            },
          })
        ).id;

      // The partial unique index allows only one live token per user, so the
      // previous one is consumed before issuing the new one. Without this
      // the INSERT collides.
      if (existing) {
        await tx.emailVerificationToken.updateMany({
          where: { userId, consumedAt: null },
          data: { consumedAt: new Date() },
        });
      }

      await tx.emailVerificationToken.create({
        data: {
          id: newId(),
          userId,
          tokenHash: this.tokens.oneTimeDigest(token),
          pendingPasswordHash,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      });
    });

    await this.mail.sendVerificationLink(email, token);
  }

  // Moving the password to users, marking verification and moving to ACTIVE
  // go in the same transaction because the model's CHECKs relate them: a
  // verified account always has a password, and a GUEST is never verified.
  async confirmEmailVerification(token: string): Promise<void> {
    const row = await loadOrThrow(
      () =>
        this.prisma.emailVerificationToken.findUnique({
          where: { tokenHash: this.tokens.oneTimeDigest(token) },
        }),
      'The token is invalid, expired, or has already been consumed.',
      Problems.emailVerificationTokenNotFound,
      (r) =>
        !r.consumedAt && r.expiresAt > new Date() && !!r.pendingPasswordHash,
    );

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: {
          passwordHash: row.pendingPasswordHash,
          emailVerifiedAt: new Date(),
          state: UserState.ACTIVE,
        },
      }),
      this.prisma.emailVerificationToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date(), pendingPasswordHash: null },
      }),
    ]);
  }

  // Reissues the link without accepting a new credential: it carries over
  // the one that was already pending.
  async resendEmailVerification(email: string): Promise<void> {
    const user = await this.findLiveByEmail(email);
    if (!user || user.emailVerifiedAt) return;

    const live = await this.prisma.emailVerificationToken.findFirst({
      where: { userId: user.id, consumedAt: null },
    });
    if (!live?.pendingPasswordHash) return;

    const token = this.tokens.mintOneTime();

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: live.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          id: newId(),
          userId: user.id,
          tokenHash: this.tokens.oneTimeDigest(token),
          pendingPasswordHash: live.pendingPasswordHash,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      }),
    ]);

    await this.mail.sendVerificationLink(email, token);
  }

  // ------------------------------------------------------------------ session

  // The password is verified before the verification state, so that the 403
  // for "email not verified" can't be used as an oracle of which addresses
  // exist; if the account doesn't have a passwordHash yet, it's compared
  // against the credential parked in its live verification token.
  async signIn(email: string, password: string): Promise<SessionResult> {
    const user = await this.findLiveByEmail(email);

    if (!user) {
      await this.passwords.burnTime(password);
      throw this.invalidCredentials();
    }

    if (user.passwordHash) {
      const ok = await this.passwords.verify(user.passwordHash, password);
      if (!ok) throw this.invalidCredentials();
    } else {
      const pending = await this.prisma.emailVerificationToken.findFirst({
        where: { userId: user.id, consumedAt: null },
        select: { pendingPasswordHash: true },
      });

      const ok = pending?.pendingPasswordHash
        ? await this.passwords.verify(pending.pendingPasswordHash, password)
        : await this.passwords.burnTime(password);

      if (!ok) throw this.invalidCredentials();
    }

    // Three separate guards, deliberately not merged, as the ERD declares.
    if (user.state !== UserState.ACTIVE || !user.emailVerifiedAt) {
      throw new ProblemException(
        Problems.emailNotVerified,
        'Verify the email address before signing in.',
      );
    }

    return this.openSession(user);
  }

  private async openSession(user: User): Promise<SessionResult> {
    return {
      accessToken: this.tokens.signAccessToken(user),
      user: { id: user.id, email: user.email, role: user.role },
      refresh: await this.tokens.startFamily(user.id),
    };
  }

  async refresh(token: string | undefined): Promise<SessionResult> {
    if (!token) throw this.invalidCredentials();

    const outcome = await this.tokens.rotate(token);
    if (!outcome.ok) throw this.invalidCredentials();

    return {
      accessToken: this.tokens.signAccessToken(outcome.user),
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        role: outcome.user.role,
      },
      refresh: outcome.refresh,
    };
  }

  async signOut(token: string | undefined): Promise<void> {
    if (token) await this.tokens.revokeFamilyOf(token);
  }

  // -------------------------------------------------------------- password

  // Always responds 202: the response doesn't say whether the address is
  // registered.
  async forgotPassword(email: string): Promise<void> {
    const user = await this.findLiveByEmail(email);
    if (!user?.emailVerifiedAt || user.state !== UserState.ACTIVE) return;

    const token = this.tokens.mintOneTime();

    await this.prisma.passwordResetToken.create({
      data: {
        id: newId(),
        userId: user.id,
        tokenHash: this.tokens.oneTimeDigest(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });

    await this.mail.sendPasswordReset(email, token);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await loadOrThrow(
      () =>
        this.prisma.passwordResetToken.findUnique({
          where: { tokenHash: this.tokens.oneTimeDigest(token) },
        }),
      'The token is invalid, expired, or has already been consumed.',
      Problems.notFound,
      (r) => !r.consumedAt && r.expiresAt > new Date(),
    );

    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    // A session opened before the reset stops being valid. That's the point
    // of resetting: if someone had access, they lose it.
    await this.tokens.revokeAllForUser(row.userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user?.passwordHash) throw this.invalidCredentials();

    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) throw this.invalidCredentials();

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });

    await this.tokens.revokeAllForUser(userId);
    await this.mail.sendPasswordChanged(user.email);
  }

  private invalidCredentials(): ProblemException {
    return new ProblemException(
      Problems.unauthorized,
      'The supplied credentials are not valid.',
    );
  }
}
