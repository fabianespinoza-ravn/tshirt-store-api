import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ApiProblems } from '../../common/swagger';
import { GuestOrdersService } from './guest-orders.service';
import type { GuestOrderView } from './guest-orders.views';

@ApiTags('Orders')
@Controller('guest-orders')
export class GuestOrdersController {
  constructor(private readonly orders: GuestOrdersService) {}

  /**
   * No `@UseGuards(PoliciesGuard)` and no `@CheckPolicies`, and that is the
   * decision rather than an omission.
   *
   * docs/AUTHORIZATION-MATRIX.md puts this operation under "What does NOT go
   * in the ability", in as many words: the credential is possessing the URL,
   * not a role, and modelling it as an ability would force a subject that
   * does not exist. There is no `GuestOrder` and no rule to write.
   *
   * `@Public()` is what lets it past the global JWT guard. A caller who does
   * present a token is still let through with it attached — the guard
   * attaches on public routes — and this route ignores it, because the
   * answer must not depend on who is asking. The narrowing that keeps this
   * from being a back door onto every order lives in the service's `where`.
   */
  @Public()
  @ApiOperation({ summary: 'Read an order placed through a payment link' })
  @ApiResponse({ status: 200, description: 'The order, without its buyer' })
  @ApiProblems(
    // Two codes beyond the three the matrix extracted, both for reasons that
    // hold across this API rather than for this operation. 400 is
    // `ParseUUIDPipe`: `Order.id` is a `uuid` column, so a malformed path
    // segment reaches Postgres as a cast error and comes back a 500, and
    // refusing it in the pipe is what turns that into an honest answer. It
    // discloses nothing — a syntactically invalid id cannot exist, whoever
    // is asking. 503 is the one every route in this API carries, because
    // every route reads Postgres. Both belong in W2-API/openapi.yaml.
    Problems.validation,
    Problems.notFound,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Get(':orderId')
  getGuestOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<GuestOrderView> {
    return this.orders.getOne(orderId);
  }
}
