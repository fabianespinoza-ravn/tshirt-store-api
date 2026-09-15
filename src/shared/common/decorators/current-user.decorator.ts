import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

// What the JWT guard leaves on the request; kept minimal so nothing here
// ends up in a response by accident.
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

export type RequestWithUser = Request & { user?: AuthenticatedUser };

// Returns undefined on a @Public() route with no token (e.g. GET
// /products/{productId}): authentication is optional there, and the manager
// projection depends on whether there's a user.
export const CurrentUser = createParamDecorator(
  (
    property: keyof AuthenticatedUser | undefined,
    context: ExecutionContext,
  ) => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      return undefined;
    }

    return property ? user[property] : user;
  },
);
