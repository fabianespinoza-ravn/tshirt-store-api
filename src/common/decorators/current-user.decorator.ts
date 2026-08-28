import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

// Lo que el guard JWT deja en la petición; se mantiene mínimo para que nada de aquí acabe en una respuesta por descuido.
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

export type RequestWithUser = Request & { user?: AuthenticatedUser };

// Devuelve undefined en una ruta @Public() sin token (p. ej. GET /products/{productId}): la autenticación es opcional y la proyección de manager depende de si hay usuario.
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
