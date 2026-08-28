import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { newId } from '../common/ids';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
  ) {}

  // email no es único para Prisma porque el índice del modelo es parcial (UNIQUE WHERE deleted_at IS NULL); hay que repetir aquí la condición o una cuenta borrada volvería como si estuviera viva.
  private findLiveByEmail(email: string) {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  // ---------------------------------------------------------------- registro

  // Responde igual exista o no la dirección, para no ser un oráculo de qué correos están registrados; si la cuenta existe pero no está verificada, reemite el enlace y reemplaza la credencial pendiente, dejando recuperar el acceso a quien olvidó la contraseña antes de confirmar.
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
            data: { id: newId(), email, role: 'CLIENT', state: 'GUEST' },
          })
        ).id;

      // El único parcial admite un solo token vivo por usuario, así que el
      // anterior se consume antes de emitir el nuevo. Sin esto el INSERT choca.
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

  // Mover la contraseña a users, marcar la verificación y pasar a ACTIVE van en la misma transacción porque los CHECK del modelo las relacionan: una cuenta verificada siempre tiene contraseña y un GUEST nunca está verificado.
  async confirmEmailVerification(token: string): Promise<void> {
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: this.tokens.oneTimeDigest(token) },
    });

    const usable =
      row &&
      !row.consumedAt &&
      row.expiresAt > new Date() &&
      row.pendingPasswordHash;

    if (!usable) {
      throw new ProblemException(
        Problems.emailVerificationTokenNotFound,
        'The token is invalid, expired, or has already been consumed.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: {
          passwordHash: row.pendingPasswordHash,
          emailVerifiedAt: new Date(),
          state: 'ACTIVE',
        },
      }),
      this.prisma.emailVerificationToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date(), pendingPasswordHash: null },
      }),
    ]);
  }

  // Reemite el enlace sin aceptar una credencial nueva: arrastra la que ya estaba pendiente.
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

  // ------------------------------------------------------------------ sesión

  // La contraseña se verifica antes que el estado de verificación, para que el 403 de "correo sin verificar" no sirva de oráculo de qué direcciones existen; si la cuenta aún no tiene passwordHash, se compara contra la credencial aparcada en su token de verificación vivo.
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

    // Tres guardas separadas, deliberadamente no fusionadas, como el ERD declara.
    if (user.state !== 'ACTIVE' || !user.emailVerifiedAt) {
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

  // -------------------------------------------------------------- contraseña

  // Responde 202 siempre: la respuesta no dice si la dirección está registrada.
  async forgotPassword(email: string): Promise<void> {
    const user = await this.findLiveByEmail(email);
    if (!user?.emailVerifiedAt || user.state !== 'ACTIVE') return;

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
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.tokens.oneTimeDigest(token) },
    });

    if (!row || row.consumedAt || row.expiresAt <= new Date()) {
      throw new ProblemException(
        Problems.notFound,
        'The token is invalid, expired, or has already been consumed.',
      );
    }

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

    // Una sesión abierta antes del restablecimiento deja de valer. Es el sentido
    // de restablecer: si alguien tenía acceso, lo pierde.
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
