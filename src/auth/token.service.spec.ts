import { buildService, type ServiceHarness } from '../testing/build-service';
import { aRefreshToken, aUser } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { TokenService } from './token.service';

/**
 * What's asserted here comes from the `refresh_tokens` note in the ERD:
 *
 * > Rotating refresh token with reuse detection. Detection lives in token_hash +
 * > revoked_at: a revoked row is kept, so replaying it is recognisable. On replay
 * > the whole family is revoked.
 */
describe('TokenService', () => {
  let h: ServiceHarness<TokenService>;

  beforeEach(async () => {
    h = await buildService(TokenService);
    resetPrismaMock(h.prisma);
  });

  describe('rotate', () => {
    it('refuses a token that is not in the table', async () => {
      h.prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(h.service.rotate('unknown')).resolves.toMatchObject({
        ok: false,
        reason: 'unknown',
      });
    });

    /**
     * The case that defines reuse detection. Presenting an already-rotated
     * token means either the cookie was stolen from the user or the copy was
     * stolen from the thief, and there's no way to know which. Revoking the
     * whole family is the only safe answer: both parties authenticate again.
     */
    it('revokes the whole family when a revoked token is replayed', async () => {
      const user = aUser();
      const row = aRefreshToken(user.id, { revokedAt: new Date() });
      h.prisma.refreshToken.findUnique.mockResolvedValue({
        ...row,
        user,
      } as never);

      const outcome = await h.service.rotate('stolen');

      expect(outcome).toMatchObject({ ok: false, reason: 'reused' });
      expect(h.prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
    });

    it('refuses an expired token without touching the family', async () => {
      const user = aUser();
      const row = aRefreshToken(user.id, {
        expiresAt: new Date(Date.now() - 1000),
      });
      h.prisma.refreshToken.findUnique.mockResolvedValue({
        ...row,
        user,
      } as never);

      const outcome = await h.service.rotate('expired');

      expect(outcome).toMatchObject({ ok: false, reason: 'expired' });
      expect(h.prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    /**
     * Rotating revokes the presented token and issues a new one **in the
     * same family**. If the successor opened a new family, replaying the old
     * one would no longer drag the new one down with it, and reuse detection
     * would stop protecting anything.
     */
    it('revokes the presented token and issues a successor in the same family', async () => {
      const user = aUser();
      const row = aRefreshToken(user.id);
      h.prisma.refreshToken.findUnique.mockResolvedValue({
        ...row,
        user,
      } as never);

      const outcome = await h.service.rotate('current');

      expect(outcome.ok).toBe(true);
      expect(h.prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: row.id },
        data: { revokedAt: expect.any(Date) as Date },
      });
      expect(h.prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: row.userId,
          familyId: row.familyId,
        }) as never,
      });
    });

    it('never stores the token in the clear', async () => {
      const user = aUser();
      const row = aRefreshToken(user.id);
      h.prisma.refreshToken.findUnique.mockResolvedValue({
        ...row,
        user,
      } as never);

      const outcome = await h.service.rotate('current');
      const issued = outcome.ok ? outcome.refresh.token : '';
      const stored = h.prisma.refreshToken.create.mock.calls[0][0].data as {
        tokenHash: string;
      };

      expect(stored.tokenHash).not.toBe(issued);
      expect(stored.tokenHash).toHaveLength(64);
    });
  });

  describe('revocation', () => {
    it('revokes by family when signing out', async () => {
      const row = aRefreshToken(aUser().id);
      h.prisma.refreshToken.findUnique.mockResolvedValue(row);

      await h.service.revokeFamilyOf('whichever');

      expect(h.prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
    });

    it('does nothing when the token is unknown', async () => {
      h.prisma.refreshToken.findUnique.mockResolvedValue(null);

      await h.service.revokeFamilyOf('unknown');

      expect(h.prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    /**
     * Resetting and changing the password revoke **every** family, not just
     * the current session's: a session opened before the change has to stop
     * being valid, and that's the whole point of changing the password.
     */
    it('revokes every family of a user', async () => {
      const user = aUser();

      await h.service.revokeAllForUser(user.id);

      expect(h.prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
    });
  });

  describe('startFamily', () => {
    it('opens a new family and returns the token in the clear only to the caller', async () => {
      const user = aUser();

      const issued = await h.service.startFamily(user.id);
      const stored = h.prisma.refreshToken.create.mock.calls[0][0].data as {
        userId: string;
        familyId: string;
        tokenHash: string;
      };

      expect(stored.userId).toBe(user.id);
      expect(stored.tokenHash).not.toBe(issued.token);
      expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
