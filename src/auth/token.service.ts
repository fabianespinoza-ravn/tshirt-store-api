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

  // Opaque tokens are hashed with SHA-256 and not argon2 because token_hash
  // is UNIQUE and has to be looked up by it: argon2 is salted, so the same
  // token would give a different hash every time; since the token is a
  // random 256 bits, there's no dictionary to attack and a fast hash is
  // enough.
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

  // Opens a new family of refresh tokens; this is what sign-in invokes.
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

  // The revoked row is kept because it's what makes detecting reuse
  // possible: if someone presents a token that was already rotated, there's
  // no way to know which of the two parties is the legitimate one, so the
  // whole family is revoked and both have to authenticate again.
  async rotate(token: string): Promise<RefreshOutcome> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.digest(token) },
      include: { user: true },
    });

    if (!row) return { ok: false, reason: 'unknown' };

    if (row.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected; revoking family ${row.familyId}`,
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

  // Revokes the family of the given token; this is what sign-out runs.
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

  // Revokes every family of the user; used by password reset and password
  // change to invalidate sessions opened before the change.
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
