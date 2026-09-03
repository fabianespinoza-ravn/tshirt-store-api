import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import type { ManagerSkuView } from '../catalog/product.mappers';
import { CreateSkuDto } from './dto/create-sku.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';
import { SkusService } from './skus.service';

// Alias to shorten the signatures: every route id is validated as a UUID.
const uuid = ParseUUIDPipe;

@ApiTags('Catalog')
@Controller()
export class SkusController {
  constructor(private readonly skus: SkusService) {}

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'Sku' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Create a SKU for a product' })
  @ApiResponse({ status: 201, description: 'SKU created' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Post('products/:productId/skus')
  @HttpCode(HttpStatus.CREATED)
  createSku(
    @Param('productId', uuid) productId: string,
    @Body() dto: CreateSkuDto,
  ): Promise<ManagerSkuView> {
    return this.skus.create(productId, dto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'update', subject: 'Sku' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Update a SKU' })
  @ApiResponse({ status: 200, description: 'SKU updated' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Patch('skus/:skuId')
  updateSku(
    @Param('skuId', uuid) skuId: string,
    @Body() dto: UpdateSkuDto,
  ): Promise<ManagerSkuView> {
    return this.skus.update(skuId, dto);
  }
}
