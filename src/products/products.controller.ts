import {
  Body,
  Controller,
  Delete,
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
import { UserRole } from '@prisma/client';
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
import { Public } from '../common/decorators/public.decorator';
import { type Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import type {
  ManagerProductView,
  ProductDetailView,
  ProductSummaryView,
} from '../catalog/views';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

// Alias to shorten the signatures: every route id is validated as a UUID.
const uuid = ParseUUIDPipe;

@ApiTags('Catalog')
@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Public()
  @ApiOperation({
    summary: 'List products',
    description: 'Public. Optionally narrowed to one category.',
  })
  @ApiResponse({ status: 200, description: 'A page of products' })
  @ApiProblems(Problems.validation, Problems.internalError)
  @Get('products')
  listProducts(
    @Query() query: ListProductsQueryDto,
  ): Promise<Paginated<ProductSummaryView>> {
    return this.products.list(query);
  }

  // Optional authentication: @Public() accepts anonymous callers, but the
  // JWT guard still attaches the user if one comes along, and the
  // projection is decided here.
  @Public()
  @ApiOperation({
    summary: 'Get one product',
    description:
      'Accepts anonymous callers. A manager sees the management projection; everyone else sees the public one, and an inactive product is a 404 rather than a 403 - visibility here is a condition on the row, not a permission.',
  })
  @ApiResponse({ status: 200, description: 'The product' })
  @ApiProblems(Problems.unauthorized, Problems.notFound, Problems.internalError)
  @Get('products/:productId')
  getProduct(
    @Param('productId', uuid) productId: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<ProductDetailView | ManagerProductView> {
    return this.products.getOne(productId, user?.role === UserRole.MANAGER);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'Product' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Create a product' })
  @ApiResponse({ status: 201, description: 'Product created' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.internalError,
  )
  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  createProduct(@Body() dto: CreateProductDto): Promise<ManagerProductView> {
    return this.products.create(dto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'update', subject: 'Product' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({
    summary: 'Update a product',
    description: 'Disabling a product is an update of its active flag.',
  })
  @ApiResponse({ status: 200, description: 'Product updated' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.internalError,
  )
  @Patch('products/:productId')
  updateProduct(
    @Param('productId', uuid) productId: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ManagerProductView> {
    return this.products.update(productId, dto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'delete', subject: 'Product' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Delete a product' })
  @ApiResponse({ status: 204, description: 'Product deleted' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Delete('products/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteProduct(@Param('productId', uuid) productId: string): Promise<void> {
    return this.products.remove(productId);
  }
}
