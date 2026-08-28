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
 * Las expectativas salen del contrato `1.0.2` y de las notas del ERD, no de leer
 * la implementación. Las tres fuentes que se citan:
 *
 * - `POST /auth/sign-up`: *"the response is the same whether or not the address
 *   already has an account"* y *"a registered address receives a sign-in
 *   reminder instead of a verification link"*.
 * - `users`: *"sign-in and account lookup require ACTIVE, email_verified_at IS
 *   NOT NULL, and deleted_at IS NULL"*.
 * - `email_verification_tokens`: *"pending_password_hash holds the credential
 *   until confirmation: it moves to users.password_hash in the same transaction
 *   that sets email_verified_at and state"*.
 */
describe('AuthService', () => {
  let h: ServiceHarness<AuthService>;
  let passwords: PasswordService;
  const CLARO = 'contrasena-de-prueba-larga';

  beforeEach(async () => {
    h = await buildService(AuthService);
    resetPrismaMock(h.prisma);
    passwords = new PasswordService();
    h.tokens.mintOneTime.mockReturnValue('token-en-claro');
    h.tokens.oneTimeDigest.mockReturnValue('hash-del-token');
  });

  // ------------------------------------------------------------------ signUp

  describe('signUp', () => {
    it('creates the account in GUEST with no credential in users', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);
      h.prisma.user.create.mockResolvedValue(anUnverifiedUser());

      await h.service.signUp('nueva@ejemplo.test', CLARO);

      const creado = h.prisma.user.create.mock.calls[0][0].data as {
        state: string;
        role: string;
      };
      expect(creado.state).toBe('GUEST');
      expect(creado.role).toBe('CLIENT');
      // La credencial se aparca en el token hasta confirmar: escribirla aquí
      // dejaría una cuenta con contraseña que nadie ha verificado.
      expect(creado).not.toHaveProperty('passwordHash');
      expect(h.mail.sendVerificationLink).toHaveBeenCalledWith(
        'nueva@ejemplo.test',
        'token-en-claro',
      );
    });

    /**
     * El oráculo de enumeración cerrado: una dirección ya verificada no produce
     * ninguna escritura y recibe un correo distinto. Desde fuera, las dos
     * respuestas son idénticas.
     */
    it('writes nothing and sends a reminder for an already verified address', async () => {
      h.prisma.user.findFirst.mockResolvedValue(aUser());

      await h.service.signUp('maria@ejemplo.test', CLARO);

      expect(h.mail.sendSignInReminder).toHaveBeenCalledWith(
        'maria@ejemplo.test',
      );
      expect(h.mail.sendVerificationLink).not.toHaveBeenCalled();
      expect(h.prisma.user.create).not.toHaveBeenCalled();
      expect(h.prisma.emailVerificationToken.create).not.toHaveBeenCalled();
    });

    /**
     * El único parcial de `email_verification_tokens` admite un solo token vivo
     * por usuario, así que reemitir obliga a consumir el anterior primero. Sin
     * eso el INSERT choca contra el índice.
     */
    it('consumes the live token before issuing a new one', async () => {
      h.prisma.user.findFirst.mockResolvedValue(anUnverifiedUser());

      await h.service.signUp('sin-verificar@ejemplo.test', CLARO);

      expect(h.prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ consumedAt: null }) as never,
        }) as never,
      );
      expect(h.prisma.emailVerificationToken.create).toHaveBeenCalled();
    });

    /**
     * La salida del encierro: quien se registró, no confirmó y olvidó la
     * contraseña vuelve a registrarse y la credencial pendiente se reemplaza por
     * la nueva. Es la decisión H26, que se cerró al cerrar el oráculo.
     */
    it('replaces the pending credential with the newly supplied one', async () => {
      const usuario = anUnverifiedUser();
      h.prisma.user.findFirst.mockResolvedValue(usuario);

      await h.service.signUp(usuario.email, 'una-contrasena-nueva-larga');

      const emitido = h.prisma.emailVerificationToken.create.mock.calls[0][0]
        .data as { pendingPasswordHash: string; userId: string };
      expect(emitido.userId).toBe(usuario.id);
      await expect(
        passwords.verify(
          emitido.pendingPasswordHash,
          'una-contrasena-nueva-larga',
        ),
      ).resolves.toBe(true);
    });
  });

  // ------------------------------------------------------- verificación

  describe('confirmEmailVerification', () => {
    /**
     * Confirmar mueve la credencial aparcada a `users`, marca la verificación y
     * promueve a ACTIVE. Las tres escrituras van juntas porque los CHECK del
     * modelo las relacionan: una cuenta verificada siempre tiene contraseña y un
     * GUEST nunca está verificado.
     */
    it('moves the pending credential, verifies and promotes to ACTIVE', async () => {
      const usuario = anUnverifiedUser();
      const token = aOneTimeToken(usuario.id, {
        pendingPasswordHash: '$argon2id$aparcada',
      });
      h.prisma.emailVerificationToken.findUnique.mockResolvedValue(token);

      await h.service.confirmEmailVerification('token-en-claro');

      expect(h.prisma.user.update).toHaveBeenCalledWith({
        where: { id: usuario.id },
        data: {
          passwordHash: '$argon2id$aparcada',
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
    ])('returns 404 for a token that is %s', async (_caso, overrides) => {
      h.prisma.emailVerificationToken.findUnique.mockResolvedValue(
        overrides === null ? null : aOneTimeToken('usuario-1', overrides),
      );

      await expect(
        h.service.confirmEmailVerification('token-en-claro'),
      ).rejects.toMatchObject({
        kind: Problems.emailVerificationTokenNotFound,
      });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ signIn

  describe('signIn', () => {
    const conCredencial = async (overrides = {}) =>
      aUser({ passwordHash: await passwords.hash(CLARO), ...overrides });

    it('opens a session for a verified account with the right password', async () => {
      h.prisma.user.findFirst.mockResolvedValue(await conCredencial());
      h.tokens.signAccessToken.mockReturnValue('jwt');
      h.tokens.startFamily.mockResolvedValue({
        token: 'refresh',
        expiresAt: new Date(),
      });

      await expect(
        h.service.signIn('ana@ejemplo.test', CLARO),
      ).resolves.toMatchObject({ accessToken: 'jwt' });
    });

    it('returns 401 for a wrong password', async () => {
      h.prisma.user.findFirst.mockResolvedValue(await conCredencial());

      await expect(
        h.service.signIn('ana@ejemplo.test', 'otra-contrasena-larga'),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
    });

    it('returns 401 for an address with no account', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        h.service.signIn('nadie@ejemplo.test', CLARO),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
    });

    /**
     * **El orden de comprobaciones es lo que decide qué se filtra.** Con la
     * contraseña equivocada sobre una cuenta sin verificar la respuesta tiene que
     * ser 401 y no 403: si fuera 403, cualquiera podría averiguar qué direcciones
     * están registradas probando una contraseña inventada, que es exactamente lo
     * que sign-up y forgot-password se molestan en no decir.
     */
    it('returns 401, never 403, when the password is wrong on an unverified account', async () => {
      const usuario = anUnverifiedUser();
      h.prisma.user.findFirst.mockResolvedValue(usuario);
      h.prisma.emailVerificationToken.findFirst.mockResolvedValue({
        pendingPasswordHash: await passwords.hash(CLARO),
      } as never);

      await expect(
        h.service.signIn(usuario.email, 'contrasena-equivocada-larga'),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
    });

    it('returns 403 only when the password is right and the email is unverified', async () => {
      const usuario = anUnverifiedUser();
      h.prisma.user.findFirst.mockResolvedValue(usuario);
      h.prisma.emailVerificationToken.findFirst.mockResolvedValue({
        pendingPasswordHash: await passwords.hash(CLARO),
      } as never);

      await expect(
        h.service.signIn(usuario.email, CLARO),
      ).rejects.toMatchObject({ kind: Problems.emailNotVerified });
    });

    /** Las tres guardas del ERD, deliberadamente no fusionadas. */
    it('refuses a verified account that is not ACTIVE', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        await conCredencial({ state: 'GUEST' }),
      );

      await expect(
        h.service.signIn('ana@ejemplo.test', CLARO),
      ).rejects.toMatchObject({ kind: Problems.emailNotVerified });
    });

    /**
     * `email` no es único en Prisma porque el único del modelo es parcial:
     * `UNIQUE (email) WHERE deleted_at IS NULL`. Olvidar el `deletedAt: null`
     * devolvería una cuenta borrada como si estuviera viva.
     */
    it('scopes the lookup to accounts that are not deleted', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        h.service.signIn('ana@ejemplo.test', CLARO),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
      expect(h.prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'ana@ejemplo.test', deletedAt: null },
      });
    });
  });

  // ------------------------------------------------------------ contraseña

  describe('forgotPassword', () => {
    it('issues a reset token for an eligible account', async () => {
      const usuario = aUser();
      h.prisma.user.findFirst.mockResolvedValue(usuario);

      await h.service.forgotPassword(usuario.email);

      expect(h.prisma.passwordResetToken.create).toHaveBeenCalled();
      expect(h.mail.sendPasswordReset).toHaveBeenCalledWith(
        usuario.email,
        'token-en-claro',
      );
    });

    /** 202 siempre: no se puede distinguir desde fuera. */
    it.each([
      ['unknown', null],
      ['unverified', anUnverifiedUser()],
    ])(
      'writes nothing and sends nothing for an address that is %s',
      async (_caso, usuario) => {
        h.prisma.user.findFirst.mockResolvedValue(usuario);

        await expect(
          h.service.forgotPassword('quien@ejemplo.test'),
        ).resolves.toBeUndefined();
        expect(h.prisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(h.mail.sendPasswordReset).not.toHaveBeenCalled();
      },
    );
  });

  describe('resetPassword', () => {
    it('sets the new credential and revokes every family', async () => {
      const token = aOneTimeToken('usuario-1');
      h.prisma.passwordResetToken.findUnique.mockResolvedValue(token);

      await h.service.resetPassword('token-en-claro', 'la-nueva-y-larga');

      const escrito = h.prisma.user.update.mock.calls[0][0].data as {
        passwordHash: string;
      };
      await expect(
        passwords.verify(escrito.passwordHash, 'la-nueva-y-larga'),
      ).resolves.toBe(true);
      expect(h.tokens.revokeAllForUser).toHaveBeenCalledWith('usuario-1');
    });

    it.each([
      ['unknown', null],
      ['already consumed', { consumedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])('returns 404 for a token that is %s', async (_caso, overrides) => {
      h.prisma.passwordResetToken.findUnique.mockResolvedValue(
        overrides === null ? null : aOneTimeToken('usuario-1', overrides),
      );

      await expect(
        h.service.resetPassword('token-en-claro', 'la-nueva-y-larga'),
      ).rejects.toMatchObject({ kind: Problems.notFound });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
      expect(h.tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('revokes every family and sends the notification the brief requires', async () => {
      const usuario = aUser({ passwordHash: await passwords.hash(CLARO) });
      h.prisma.user.findUnique.mockResolvedValue(usuario);

      await h.service.changePassword(usuario.id, CLARO, 'la-nueva-y-larga');

      expect(h.tokens.revokeAllForUser).toHaveBeenCalledWith(usuario.id);
      expect(h.mail.sendPasswordChanged).toHaveBeenCalledWith(usuario.email);
    });

    it('returns 401 when the current password does not match', async () => {
      const usuario = aUser({ passwordHash: await passwords.hash(CLARO) });
      h.prisma.user.findUnique.mockResolvedValue(usuario);

      await expect(
        h.service.changePassword(
          usuario.id,
          'la-equivocada-larga',
          'otra-larga',
        ),
      ).rejects.toMatchObject({ kind: Problems.unauthorized });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
      expect(h.tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('signOut', () => {
    it('revokes the family the presented cookie belongs to', async () => {
      h.prisma.refreshToken.findUnique.mockResolvedValue(
        aRefreshToken('usuario-1'),
      );

      await h.service.signOut('refresh-en-claro');

      expect(h.tokens.revokeFamilyOf).toHaveBeenCalledWith('refresh-en-claro');
    });

    it('does nothing without a cookie', async () => {
      await h.service.signOut(undefined);

      expect(h.tokens.revokeFamilyOf).not.toHaveBeenCalled();
    });
  });
});
