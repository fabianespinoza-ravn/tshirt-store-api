import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import { CartService } from './cart.service';
import type { CartView } from './cart.views';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';

const uuid = ParseUUIDPipe;

// Every mutation answers with the whole cart, so changing a line never
// forces a second call to refresh the subtotal.
@ApiTags('Cart')
@ApiBearerAuth('bearerAuth')
@UseGuards(PoliciesGuard)
@Controller()
export class CartController {
  constructor(private readonly cart: CartService) {}

  @CheckPolicies({ action: 'read', subject: 'Cart' })
  @ApiOperation({ summary: "Get the caller's active cart" })
  @ApiResponse({ status: 200, description: 'Active cart, possibly empty' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.forbidden,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Get('cart')
  getCart(@CurrentUser() user: AuthenticatedUser): Promise<CartView> {
    return this.cart.getCart(user);
  }

  @CheckPolicies({ action: 'create', subject: 'CartItem' })
  @ApiOperation({ summary: 'Add a SKU to the active cart' })
  @ApiResponse({ status: 200, description: 'An existing line grew' })
  @ApiResponse({ status: 201, description: 'A new line was created' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.stockUnavailable,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('cart/items')
  async addCartItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddCartItemDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartView> {
    const { cart, created } = await this.cart.addItem(
      user,
      dto.skuId,
      dto.quantity,
    );

    // The contract splits 201 from 200 by whether a line was created, which
    // no static @HttpCode can express. This sets a success status and
    // nothing else: the body is still what the handler returns, and an
    // error is still shaped only by ProblemDetailsFilter.
    // eslint-disable-next-line no-restricted-syntax -- success status, not an error body
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return cart;
  }

  @CheckPolicies({ action: 'update', subject: 'CartItem' })
  @ApiOperation({ summary: 'Change a cart item quantity' })
  @ApiResponse({ status: 200, description: 'Active cart after the update' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.stockUnavailable,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Patch('cart/items/:cartItemId')
  updateCartItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('cartItemId', uuid) cartItemId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartView> {
    return this.cart.updateItem(user, cartItemId, dto.quantity);
  }

  @CheckPolicies({ action: 'delete', subject: 'CartItem' })
  @ApiOperation({ summary: 'Remove a cart item' })
  @ApiResponse({ status: 200, description: 'Active cart after the removal' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Delete('cart/items/:cartItemId')
  removeCartItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('cartItemId', uuid) cartItemId: string,
  ): Promise<CartView> {
    return this.cart.removeItem(user, cartItemId);
  }
}
