import { applyDecorators, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

// Not a global guard on purpose: the limit is per operation because not
// every route declares 429 in the contract, and a global guard would apply
// it even where it doesn't.
export const RateLimited = (limit: number, ttl: number) =>
  applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle({ default: { limit, ttl } }),
  );
