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
import type { OrderView } from './orders.views';

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
  ): Promise<OrderView> {
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
