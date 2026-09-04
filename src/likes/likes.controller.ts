import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Put,
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
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import {
  SetProductLikeDto,
  type ProductLikeView,
} from './dto/set-product-like.dto';
import { LikesService } from './likes.service';

@ApiTags('Catalog')
@Controller()
export class LikesController {
  constructor(private readonly likes: LikesService) {}

  // One route sets and clears, so it declares both actions and the guard
  // requires both. A like is not a bookmark: it enrols the caller in the
  // product's low-stock notification, which is why a manager gets 403.
  @UseGuards(PoliciesGuard)
  @CheckPolicies(
    { action: 'create', subject: 'ProductLike' },
    { action: 'delete', subject: 'ProductLike' },
  )
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Set whether the caller likes a product' })
  @ApiResponse({ status: 200, description: 'Like state set' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Put('products/:productId/like')
  setProductLike(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetProductLikeDto,
  ): Promise<ProductLikeView> {
    return this.likes.set(user, productId, dto.liked);
  }
}
