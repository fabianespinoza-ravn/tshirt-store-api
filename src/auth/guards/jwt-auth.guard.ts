import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { RequestWithUser } from '../../common/decorators/current-user.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { TokenService } from '../token.service';

// Solo autenticación, no autorización (eso va en otro guard); no consulta la base de datos, así que una cuenta desactivada conserva acceso hasta que expire su access token.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const presented = this.bearerFrom(request.headers.authorization);

    // Una ruta pública que además trae token lo aprovecha. Es lo que necesita
    // `GET /products/{productId}`: acepta anónimo y ensancha la respuesta para
    // un manager, así que no puede limitarse a dejar pasar sin mirar.
    if (isPublic) {
      if (presented) this.tryAttach(request, presented);
      return true;
    }

    if (!presented) {
      // RFC 6750: sin `error=` cuando no se presentó ningún token. La ausencia
      // del parámetro es lo que distingue "no mandaste" de "el tuyo no vale", y
      // es lo que le dice a un cliente si tiene que refrescar o volver al login.
      this.challenge(http.getResponse<Response>(), 'Bearer');
      throw new ProblemException(
        Problems.unauthorized,
        'A valid Bearer access token is required for this operation.',
      );
    }

    if (!this.tryAttach(request, presented)) {
      this.challenge(
        http.getResponse<Response>(),
        'Bearer error="invalid_token", error_description="The access token is expired or invalid"',
      );
      throw new ProblemException(
        Problems.unauthorized,
        'The access token is expired, malformed or invalid.',
      );
    }

    return true;
  }

  private tryAttach(request: RequestWithUser, token: string): boolean {
    try {
      const payload = this.tokens.verifyAccessToken(token);
      request.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
      return true;
    } catch {
      return false;
    }
  }

  private bearerFrom(header: string | undefined): string | undefined {
    const [scheme, value] = header?.split(' ') ?? [];
    return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
  }

  private challenge(response: Response, value: string): void {
    response.setHeader('WWW-Authenticate', value);
  }
}
