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
 * This guard only answers "who is the caller". What they're allowed to do is
 * the CASL ability's problem, in another guard.
 *
 * The expectations come from the contract: `components/responses/Unauthorized`
 * declares that the `WWW-Authenticate` header distinguishes a token that was
 * presented and rejected from one that was never sent, citing RFC 6750, and
 * `GET /products/{productId}` declares authentication optional with the
 * response widened for a manager.
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

  const userOf = (context: {
    switchToHttp: () => { getRequest: () => unknown };
  }) => (context.switchToHttp().getRequest() as { user?: unknown }).user;

  describe('protected routes', () => {
    it('rejects a request with no Authorization header', () => {
      const { context, recorded } = anExecutionContext({
        handler: Rutas.prototype.protegida,
        controller: Rutas,
      });

      expect(() => guard.canActivate(context)).toThrow(ProblemException);
      // No `error=`: the absence of the parameter is what says "you sent no
      // token", and it's what makes a client go back to login instead of
      // trying to refresh.
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
        fail('the guard should have rejected the token');
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
      expect(userOf(context)).toEqual({
        id: 'user-1',
        email: 'ana@ejemplo.test',
        role: 'MANAGER',
      });
    });

    /**
     * A scheme that isn't Bearer is treated as if there were no token, not
     * as an invalid one: `Basic` or a bare value aren't credentials for this
     * API.
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

  describe('public routes', () => {
    it('lets an anonymous caller through with no user attached', () => {
      const { context } = anExecutionContext({
        handler: Rutas.prototype.publica,
        controller: Rutas,
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(userOf(context)).toBeUndefined();
    });

    /**
     * **A public route that also carries a token makes use of it.** That's
     * what `GET /products/{productId}` needs: it accepts anonymous callers
     * and widens the response for a manager, so letting it through without
     * looking would leave a manager seeing the public projection of their
     * own catalog.
     */
    it('still attaches the identity when a public route carries a valid token', () => {
      tokens.verifyAccessToken.mockReturnValue(identidad);
      const { context } = anExecutionContext({
        handler: Rutas.prototype.publica,
        controller: Rutas,
        headers: { authorization: 'Bearer valido' },
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(userOf(context)).toMatchObject({ role: 'MANAGER' });
    });

    /**
     * And with a broken token it passes through as anonymous instead of
     * failing. The projection falls on the safe side: show too little,
     * never too much.
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
      expect(userOf(context)).toBeUndefined();
    });
  });
});
