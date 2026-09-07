import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { PaginationQueryDto, type Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import {
  CreatePromoCodeDto,
  PromoCodePageResponseDto,
  PromoCodeResponseDto,
  PromoCodeValidationResponseDto,
  UpdatePromoCodeDto,
  ValidatePromoCodeDto,
} from './dto/promo-codes.dto';
import { PromoCodesService } from './promo-codes.service';
import type {
  PromoCodeValidationView,
  PromoCodeView,
} from './promo-codes.views';

const uuid = ParseUUIDPipe;

@ApiTags('Promotions')
@ApiBearerAuth('bearerAuth')
@UseGuards(PoliciesGuard)
@Controller('promo-codes')
export class PromoCodesController {
  constructor(private readonly promoCodes: PromoCodesService) {}

  @CheckPolicies({ action: 'read', subject: 'PromoCode' })
  @ApiOperation({
    summary:
      'List non-deleted promo codes, including inactive and expired campaigns',
  })
  @ApiResponse({
    status: 200,
    description: 'A page of promo codes',
    type: PromoCodePageResponseDto,
  })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Get()
  list(@Query() query: PaginationQueryDto): Promise<Paginated<PromoCodeView>> {
    return this.promoCodes.list(query);
  }

  @CheckPolicies({ action: 'create', subject: 'PromoCode' })
  @ApiOperation({ summary: 'Create a promo code' })
  @ApiResponse({
    status: 201,
    description: 'Promo code created',
    type: PromoCodeResponseDto,
  })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.conflict,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post()
  create(@Body() dto: CreatePromoCodeDto): Promise<PromoCodeView> {
    return this.promoCodes.create(dto);
  }

  @CheckPolicies({ action: 'validate', subject: 'PromoCode' })
  @ApiOperation({
    summary: 'Preview a promo code against the current active cart',
    description:
      'Calculates current server-side prices and reserves neither stock nor a promo-code use.',
  })
  @ApiResponse({
    status: 200,
    description: 'Discount and resulting total',
    type: PromoCodeValidationResponseDto,
  })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.cartNotCheckoutable,
    Problems.stockUnavailable,
    Problems.promoCodeUnavailable,
    Problems.promoMinimumNotMet,
    Problems.promoTotalTooLow,
    Problems.itemWithdrawn,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ValidatePromoCodeDto,
  ): Promise<PromoCodeValidationView> {
    return this.promoCodes.validate(user, dto);
  }

  @CheckPolicies({ action: 'update', subject: 'PromoCode' })
  @ApiOperation({
    summary: 'Update a promo code without changing its code or discount type',
  })
  @ApiResponse({
    status: 200,
    description: 'Promo code updated',
    type: PromoCodeResponseDto,
  })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Patch(':promoCodeId')
  update(
    @Param('promoCodeId', uuid) promoCodeId: string,
    @Body() dto: UpdatePromoCodeDto,
  ): Promise<PromoCodeView> {
    return this.promoCodes.update(promoCodeId, dto);
  }
}
