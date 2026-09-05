import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import type { Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import {
  CheckoutDto,
  ListOrdersQueryDto,
  UpdateOrderStatusDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';
import type {
  CheckoutOrderView,
  OrderStatusEventView,
  OrderView,
} from './orders.views';

const uuid = ParseUUIDPipe;

@ApiTags('Orders')
@ApiBearerAuth('bearerAuth')
@UseGuards(PoliciesGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @CheckPolicies({ action: 'create', subject: 'Order' })
  @ApiOperation({ summary: "Place an order from the caller's active cart" })
  @ApiResponse({ status: 201, description: 'The order, PENDING' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.cartNotCheckoutable,
    Problems.stockUnavailable,
    Problems.orderAlreadyPending,
    Problems.itemWithdrawn,
    // The retryable 409, which is a different answer from the four above.
    // At `Serializable` the database refuses the losing concurrent checkout
    // as P2034 and the translator serves it as a plain conflict; a client
    // reading only `order-already-pending` would take every 409 here to mean
    // "do not retry", which is the opposite of what this one says.
    Problems.conflict,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post()
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutOrderView> {
    return this.orders.checkout(user, dto);
  }

  @CheckPolicies({ action: 'read', subject: 'Order' })
  @ApiOperation({
    summary: 'List orders the caller may see, newest first',
    description:
      'Filters by status, by placement date range and by total range, all optional and combinable. "The caller may see" is the row scope and not a role check: a CLIENT reads their own orders, a MANAGER reads every order, and a DELIVERY courier reads every SHIPPED order plus the ones they delivered.',
  })
  @ApiResponse({ status: 200, description: 'A page of orders' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<Paginated<OrderView>> {
    return this.orders.list(user, query);
  }

  /**
   * No 403 declared, and that is the contract's own decision: another
   * client's order answers 404, because a 403 would confirm the identifier
   * belongs to somebody.
   */
  @CheckPolicies({ action: 'read', subject: 'Order' })
  @ApiOperation({
    summary: 'Get one order with its lines and totals',
    description:
      'Scoped exactly as the list is. An order outside the caller scope answers 404 and never 403, so the route cannot be used to enumerate identifiers.',
  })
  @ApiResponse({ status: 200, description: 'The order' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.notFound,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Get(':orderId')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', uuid) orderId: string,
  ): Promise<OrderView> {
    return this.orders.getOne(user, orderId);
  }

  /**
   * The order's status history, as a sub-resource of the order.
   *
   * WHY A SUB-RESOURCE. Every transition row is meaningless without its
   * order — `sequence` is unique per order and not globally — and it is
   * readable exactly when the order is. A collection at `/order-status-history`
   * with an `orderId` filter would state the opposite: that the rows are a
   * resource in their own right whose scope has to be re-derived from a
   * query parameter, which is the shape that produces an identifier oracle.
   *
   * WHY 404 AND NEVER 403. The same reason `getOrder` gives above, and it
   * comes from the same `where`: `OrdersService.statusHistory` roots its
   * query at the order and folds the ability's row scope into it, so an
   * order the caller cannot reach is indistinguishable from one that does
   * not exist. A 403 here would confirm that an id belongs to somebody, and
   * it would do it on a route whose whole payload is a list of what happened
   * to that somebody's order.
   *
   * WHAT THE PAYLOAD DOES NOT CARRY: `deliveredById`. The one transition
   * that records who performed it writes that column on `Order`, not on
   * `OrderStatusHistory`, so attributing the DELIVERED entry to the courier
   * currently named there is an inference and not a recorded fact — a later
   * transition out of DELIVERED, or a re-delivery, would rewrite the column
   * and silently restate history. It is also personal data about a third
   * party with no client-facing purpose: a buyer needs to know their order
   * was delivered and when, not by whom. If the courier's identity is ever
   * to be published it needs a `performedById` column on the history row so
   * the attribution is a fact, and a MANAGER-only projection — which
   * `docs/AUTHORIZATION-MATRIX.md` puts outside the ability, under "the
   * per-role projection", because CASL's field permissions only restrict and
   * this one would have to add.
   *
   * ─── Extension point: a subject of its own ──────────────────────────────
   *
   * This route rides on the existing `read Order` rule, which is what makes
   * it work today for all three roles the matrix names. If the author would
   * rather model the history as its own subject — a defensible reading,
   * since it is a different resource with a different projection — the rules
   * are the author's to write, not the assistant's, and they are:
   *
   *   CLIENT   · read · OrderStatusHistory · { order: { is: { userId: <caller> } } }
   *   MANAGER  · read · OrderStatusHistory · (unconditional)
   *   DELIVERY · read · OrderStatusHistory · { order: { is: { status: SHIPPED } } }
   *   DELIVERY · read · OrderStatusHistory · { order: { is: { deliveredById: <caller> } } }
   *
   * from the `getOrderStatusHistory` row this branch adds to the Orders
   * table of `docs/AUTHORIZATION-MATRIX.md`, whose scope column is copied
   * verbatim from `getOrder`. Adding `'OrderStatusHistory'` to
   * `AppSubjectName` without those four rules is strictly worse than not
   * adding it: `PoliciesGuard` denies what the ability does not grant, so
   * every role would receive 403 and the route would not exist. Until they
   * are written, `read Order` is the rule, and the scope this handler
   * actually applies is the order's.
   * ────────────────────────────────────────────────────────────────────────
   */
  @CheckPolicies({ action: 'read', subject: 'Order' })
  @ApiOperation({
    summary: "Read an order's full status history, oldest transition first",
    description:
      'Every status the order has taken, ordered by the per-order `sequence` the API assigns when it records the transition. The sequence is the contract: it is unique per order and assigned inside the transaction that moves the order, so it orders two transitions landing in the same millisecond and a client can re-sort or merge entries without trusting the array it received. Scoped exactly as the order is — a CLIENT reads their own, a MANAGER reads any, a DELIVERY courier reads the ones in its scope — and an order outside the caller scope answers 404 and never 403, so the route cannot be used to enumerate identifiers. The courier who completed a delivery is deliberately not published.',
  })
  @ApiResponse({
    status: 200,
    description: 'The transitions, ascending by sequence',
  })
  @ApiProblems(
    Problems.unauthorized,
    Problems.notFound,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Get(':orderId/status-history')
  statusHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', uuid) orderId: string,
  ): Promise<OrderStatusEventView[]> {
    return this.orders.statusHistory(user, orderId);
  }

  /**
   * One route for every status change, which is why the decorator gates by
   * role only and the destination is checked afterwards, against the state
   * machine. 403 and 409 are different answers here and mean different
   * things: see `order-state-machine.ts`.
   */
  @CheckPolicies({ action: 'update', subject: 'Order' })
  @ApiOperation({
    summary: 'Move an order to another status',
    description:
      'A MANAGER advances PAID to PROCESSING to SHIPPED; a CLIENT cancels their own PENDING order; a DELIVERY courier moves a SHIPPED order to DELIVERED, which records the courier on the order. 403 when the role can never reach the destination, 409 when it cannot from the current status, 404 when the order is outside the caller scope.',
  })
  @ApiResponse({ status: 200, description: 'The order after the change' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Patch(':orderId/status')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', uuid) orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<OrderView> {
    return this.orders.updateStatus(user, orderId, dto.status);
  }
}
