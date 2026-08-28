import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { newId, parseDuration } from '../common/ids';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: User['role'];
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export type RefreshOutcome =
  | { ok: true; user: User; refresh: IssuedRefreshToken }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' };

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // Los tokens opacos se hashean con SHA-256 y no con argon2 porque token_hash es UNIQUE y hay que buscar por él: argon2 lleva sal y el mismo token daría un hash distinto cada vez; al ser el token aleatorio de 256 bits, no hay diccionario que atacar y un hash rápido basta.
  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private mint(): string {
    return randomBytes(32).toString('base64url');
  }

  signAccessToken(user: Pick<User, 'id' | 'email' | 'role'>): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwt.sign(payload);
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token);
  }

  private refreshTtlMs(): number {
    return parseDuration(this.config.get<string>('JWT_REFRESH_TTL', '7d'));
  }

  // Abre una familia nueva de refresh tokens; es lo que invoca el inicio de sesión.
  async startFamily(userId: string): Promise<IssuedRefreshToken> {
    return this.appendToFamily(userId, newId());
  }

  private async appendToFamily(
    userId: string,
    familyId: string,
  ): Promise<IssuedRefreshToken> {
    const token = this.mint();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs());

    await this.prisma.refreshToken.create({
      data: {
        id: newId(),
        userId,
        tokenHash: this.digest(token),
        familyId,
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  // La fila revocada se conserva porque es lo que permite detectar un reuso: si alguien presenta un token ya rotado no se puede saber cuál de las dos partes es la legítima, así que se revoca la familia entera y ambas deben autenticarse de nuevo.
  async rotate(token: string): Promise<RefreshOutcome> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.digest(token) },
      include: { user: true },
    });

    if (!row) return { ok: false, reason: 'unknown' };

    if (row.revokedAt) {
      this.logger.warn(
        `Reuso de refresh token detectado; se revoca la familia ${row.familyId}`,
      );
      await this.revokeFamily(row.familyId);
      return { ok: false, reason: 'reused' };
    }

    if (row.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

    const refresh = await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
      const next = this.mint();
      await tx.refreshToken.create({
        data: {
          id: newId(),
          userId: row.userId,
          tokenHash: this.digest(next),
          familyId: row.familyId,
          expiresAt: new Date(Date.now() + this.refreshTtlMs()),
        },
      });
      return {
        token: next,
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      };
    });

    return { ok: true, user: row.user, refresh };
  }

  // Revoca la familia del token dado; es lo que ejecuta el cierre de sesión.
  async revokeFamilyOf(token: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.digest(token) },
      select: { familyId: true },
    });

    if (row) await this.revokeFamily(row.familyId);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // Revoca todas las familias del usuario; lo usan el restablecimiento y el cambio de contraseña para invalidar sesiones abiertas antes del cambio.
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  oneTimeDigest(token: string): string {
    return this.digest(token);
  }

  mintOneTime(): string {
    return this.mint();
  }
}
