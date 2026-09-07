import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole, UserState, type User } from '@prisma/client';
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

export interface SessionResult {
  accessToken: string;
  user: Pick<User, 'id' | 'email' | 'role'>;
  refresh: IssuedRefreshToken;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
  ) {}

  // `liveEmail` is null on any soft-deleted row, so a lookup by it can never
  // return a deleted account — no separate `deletedAt` filter needed.
  private findLiveByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { liveEmail: email } });
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
              liveEmail: email,
              role: UserRole.CLIENT,
              state: UserState.GUEST,
            },
          })
        ).id;

      // `liveUserId` allows only one live token per user, so the previous
      // one is consumed — and its slot cleared — before issuing the new
      // one. Without clearing it the INSERT below collides.
      if (existing) {
        await tx.emailVerificationToken.updateMany({
          where: { userId, consumedAt: null },
          data: { consumedAt: new Date(), liveUserId: null },
        });
      }

      await tx.emailVerificationToken.create({
        data: {
          id: newId(),
          userId,
          liveUserId: userId,
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

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: row.userId },
        data: {
          passwordHash: row.pendingPasswordHash,
          emailVerifiedAt: new Date(),
          state: UserState.ACTIVE,
        },
      });

      await tx.emailVerificationToken.update({
        where: { id: row.id },
        data: {
          consumedAt: new Date(),
          pendingPasswordHash: null,
          liveUserId: null,
        },
      });

      await this.claimGuestOrders(tx, user.id, user.email);

      return user;
    });
  }

  /**
   * Moves a payment-link buyer's orders onto the account that just proved it
   * owns the address.
   *
   * A link purchase is owned by a `GUEST` row created from the address the
   * payer typed into Stripe Checkout, and `PaymentLinkCheckoutService`
   * deliberately never attaches one to an existing account: that address is
   * payer-controlled, so honouring it there would let anybody drop an order
   * into a stranger's history.
   *
   * **This is the other half of that decision, and the reason it is safe
   * here and not there.** Verification is the one moment this API proves an
   * address belongs to the person holding the account, so it is the only
   * place the two identities may be joined. The payer proposes; the owner of
   * the mailbox confirms.
   *
   * The guest rows are soft-deleted once emptied. They exist to own an
   * order and nothing else — no password hash, no verified-at, and a null
   * `liveEmail` so they never reserved the address — so once their orders
   * have moved there is nothing left for them to be.
   */
  private async claimGuestOrders(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
  ): Promise<void> {
    const guests = await tx.user.findMany({
      where: {
        email,
        state: UserState.GUEST,
        deletedAt: null,
        id: { not: userId },
      },
      select: { id: true },
    });

    if (guests.length === 0) return;

    const guestIds = guests.map((guest) => guest.id);

    await tx.order.updateMany({
      where: { userId: { in: guestIds } },
      data: { userId },
    });

    await tx.user.updateMany({
      where: { id: { in: guestIds } },
      data: { deletedAt: new Date() },
    });
  }

  // Reissues the link without accepting a new credential: it carries over
  // the one that was already pending.
  async resendEmailVerification(email: string): Promise<void> {
    const user = await this.findLiveByEmail(email);
    if (!user || user.emailVerifiedAt) return;

    const live = await this.prisma.emailVerificationToken.findUnique({
      where: { liveUserId: user.id },
    });
    if (!live?.pendingPasswordHash) return;

    const token = this.tokens.mintOneTime();

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: live.id },
        data: { consumedAt: new Date(), liveUserId: null },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          id: newId(),
          userId: user.id,
          liveUserId: user.id,
          tokenHash: this.tokens.oneTimeDigest(token),
          pendingPasswordHash: live.pendingPasswordHash,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      }),
    ]);

    await this.notify(
      this.mail.sendVerificationLink(email, token),
      'verification resend',
    );
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
      const pending = await this.prisma.emailVerificationToken.findUnique({
        where: { liveUserId: user.id },
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

    await this.notify(
      this.mail.sendPasswordReset(email, token),
      'password reset',
    );
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
    await this.notify(
      this.mail.sendPasswordChanged(user.email),
      'password changed',
    );
  }

  private invalidCredentials(): ProblemException {
    return new ProblemException(
      Problems.unauthorized,
      'The supplied credentials are not valid.',
    );
  }
  /**
   * Sends something whose failure must not reach the caller.
   *
   * Since block 4 these methods enqueue rather than log, so they can reject
   * — and three endpoints here promise a response that does not depend on
   * whether the address exists. Each of them reaches the mail call **only**
   * for an address that is registered, so letting a rejection through would
   * answer 500 for those and 202 for everyone else: a queue hiccup would
   * turn the endpoint into exactly the oracle its uniform response exists to
   * prevent.
   *
   * What is given up is telling the client their message was not sent. That
   * is the smaller harm, and the log is where it goes. `signUp` is
   * deliberately not routed through here: it sends on both of its branches,
   * so a rejection is symmetric and reveals nothing, and an account whose
   * verification was never enqueued is better reported than pretended.
   */
  private async notify(send: Promise<void>, what: string): Promise<void> {
    try {
      await send;
    } catch (error) {
      this.logger.error(
        `Could not enqueue the ${what} message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
