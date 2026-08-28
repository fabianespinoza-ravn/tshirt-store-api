import { applyDecorators, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

// No es guard global a propósito: el límite es por operación porque no todas las rutas declaran 429 en el contrato, y un guard global lo aplicaría también donde no lo declara.
export const RateLimited = (limit: number, ttl: number) =>
  applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle({ default: { limit, ttl } }),
  );
