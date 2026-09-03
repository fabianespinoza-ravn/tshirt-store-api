import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { RequestWithUser } from '../../common/decorators/current-user.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { TokenService } from '../token.service';

// Authentication only, not authorization (that goes in another guard); it
// doesn't query the database, so a deactivated account keeps access until
// its access token expires.
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

    // A public route that also carries a token makes use of it. That's what
    // `GET /products/{productId}` needs: it accepts anonymous callers and
    // widens the response for a manager, so it can't just let everything
    // through without looking.
    if (isPublic) {
      if (presented) this.tryAttach(request, presented);
      return true;
    }

    if (!presented) {
      // RFC 6750: no `error=` when no token was presented at all. The
      // absence of the parameter is what distinguishes "you sent none" from
      // "yours doesn't work", and it's what tells a client whether to
      // refresh or go back to login.
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
