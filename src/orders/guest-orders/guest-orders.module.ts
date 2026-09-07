import { Module } from '@nestjs/common';
import { GuestOrdersController } from './guest-orders.controller';
import { GuestOrdersService } from './guest-orders.service';

/**
 * Its own module rather than a route on `OrdersModule`, because it shares
 * nothing with it: no ability, no CASL scope, no `OrderView`. Keeping them
 * apart is what makes the absence of a guard here readable as a decision
 * instead of as something that fell off.
 */
@Module({
  controllers: [GuestOrdersController],
  providers: [GuestOrdersService],
})
export class GuestOrdersModule {}
