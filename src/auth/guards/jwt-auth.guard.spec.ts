import { Reflector } from '@nestjs/core';
import { mockDeep } from 'jest-mock-extended';
import { Public } from '../../common/decorators/public.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { anExecutionContext } from '../../testing/http';
import { TokenService } from '../token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

class Rutas {
  @Public()
  publica(this: void): void {}

  protegida(this: void): void {}
}

/**
 * Este guard sólo contesta "quién es el que llama". Lo que puede hacer es
 * problema de la ability de CASL, en otro guard.
 *
 * Las expectativas salen del contrato: `components/responses/Unauthorized`
 * declara que la cabecera `WWW-Authenticate` distingue un token presentado y
 * rechazado de uno que nunca se envió, citando RFC 6750, y `GET
 * /products/{productId}` declara autenticación opcional con la respuesta
 * ensanchada para un manager.
 */
describe('JwtAuthGuard', () => {
  const tokens = mockDeep<TokenService>();
  const guard = new JwtAuthGuard(new Reflector(), tokens);
  const identidad = {
    sub: 'user-1',
    email: 'ana@ejemplo.test',
    role: 'MANAGER' as const,
  };

  beforeEach(() => {
    tokens.verifyAccessToken.mockReset();
  });

  const usuarioDe = (context: {
    switchToHttp: () => { getRequest: () => unknown };
  }) => (context.switchToHttp().getRequest() as { user?: unknown }).user;

  describe('rutas protegidas', () => {
    it('rejects a request with no Authorization header', () => {
      const { context, recorded } = anExecutionContext({
        handler: Rutas.prototype.protegida,
        controller: Rutas,
      });

      expect(() => guard.canActivate(context)).toThrow(ProblemException);
      // Sin `error=`: la ausencia del parámetro es lo que dice "no mandaste
      // token", y es lo que hace que un cliente vuelva al login en vez de
      // intentar refrescar.
      expect(recorded.headers['WWW-Authenticate']).toBe('Bearer');
    });

    it('rejects a token that fails verification and says so in the challenge', () => {
      tokens.verifyAccessToken.mockImplementation(() => {
        throw new Error('jwt expired');
      });
      const { context, recorded } = anExecutionContext({
        handler: Rutas.prototype.protegida,
        controller: Rutas,
        headers: { authorization: 'Bearer caducado' },
      });

      try {
        guard.canActivate(context);
        fail('el guard debía rechazar el token');
      } catch (error) {
        expect((error as ProblemException).kind).toBe(Problems.unauthorized);
      }
      expect(recorded.headers['WWW-Authenticate']).toContain(
        'error="invalid_token"',
      );
    });

    it('attaches the identity carried by a valid token', () => {
      tokens.verifyAccessToken.mockReturnValue(identidad);
      const { context } = anExecutionContext({
        handler: Rutas.prototype.protegida,
        controller: Rutas,
        headers: { authorization: 'Bearer valido' },
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(usuarioDe(context)).toEqual({
        id: 'user-1',
        email: 'ana@ejemplo.test',
        role: 'MANAGER',
      });
    });

    /**
     * Un esquema que no es Bearer se trata como si no hubiera token, no como un
     * token inválido: `Basic` o un valor suelto no son credenciales de esta API.
     */
    it.each([['Basic dXNlcjpwYXNz'], ['valorsuelto'], ['Bearer']])(
      'treats %s as no token at all',
      (authorization) => {
        const { context, recorded } = anExecutionContext({
          handler: Rutas.prototype.protegida,
          controller: Rutas,
          headers: { authorization },
        });

        expect(() => guard.canActivate(context)).toThrow(ProblemException);
        expect(recorded.headers['WWW-Authenticate']).toBe('Bearer');
        expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
      },
    );
  });

  describe('rutas públicas', () => {
    it('lets an anonymous caller through with no user attached', () => {
      const { context } = anExecutionContext({
        handler: Rutas.prototype.publica,
        controller: Rutas,
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(usuarioDe(context)).toBeUndefined();
    });

    /**
     * **Una ruta pública que además trae token lo aprovecha.** Es lo que necesita
     * `GET /products/{productId}`: acepta anónimo y ensancha la respuesta para un
     * manager, así que dejar pasar sin mirar dejaría a un manager viendo la
     * proyección pública de su propio catálogo.
     */
    it('still attaches the identity when a public route carries a valid token', () => {
      tokens.verifyAccessToken.mockReturnValue(identidad);
      const { context } = anExecutionContext({
        handler: Rutas.prototype.publica,
        controller: Rutas,
        headers: { authorization: 'Bearer valido' },
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(usuarioDe(context)).toMatchObject({ role: 'MANAGER' });
    });

    /**
     * Y con un token roto pasa como anónimo en vez de fallar. La proyección cae
     * del lado seguro: enseñar de menos, nunca de más.
     */
    it('falls back to anonymous when a public route carries a broken token', () => {
      tokens.verifyAccessToken.mockImplementation(() => {
        throw new Error('jwt malformed');
      });
      const { context } = anExecutionContext({
        handler: Rutas.prototype.publica,
        controller: Rutas,
        headers: { authorization: 'Bearer roto' },
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(usuarioDe(context)).toBeUndefined();
    });
  });
});
