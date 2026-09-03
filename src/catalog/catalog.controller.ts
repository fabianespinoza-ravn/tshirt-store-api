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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
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
import { PaginationQueryDto, type Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import { MAX_IMAGE_BYTES } from '../storage/storage.service';
import { CategoriesService, type CategoryView } from './categories.service';
import {
  CreateCategoryDto,
  CreateProductDto,
  CreateSkuDto,
  ListProductsQueryDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateSkuDto,
} from './dto/catalog.dto';
import { ImagesService } from './images.service';
import type {
  ImageView,
  ManagerProductView,
  ManagerSkuView,
  ProductDetailView,
  ProductSummaryView,
} from './product.mappers';
import { ProductsService } from './products.service';
import { SkusService } from './skus.service';

// Alias para acortar las firmas: cada id de ruta se valida como UUID.
const uuid = ParseUUIDPipe;

@ApiTags('Catalog')
@Controller()
export class CatalogController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly images: ImagesService,
    private readonly skus: SkusService,
  ) {}

  // ------------------------------------------------------------- categorías

  @Public()
  @ApiOperation({ summary: 'List categories' })
  @ApiResponse({ status: 200, description: 'A page of categories' })
  @ApiProblems(Problems.validation, Problems.internalError)
  @Get('categories')
  listCategories(
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<CategoryView>> {
    return this.categories.list(query);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'Category' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.conflict,
    Problems.internalError,
  )
  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategory(@Body() dto: CreateCategoryDto): Promise<CategoryView> {
    return this.categories.create(dto.name);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'update', subject: 'Category' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Rename a category' })
  @ApiResponse({ status: 200, description: 'Category updated' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Patch('categories/:categoryId')
  updateCategory(
    @Param('categoryId', uuid) categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.rename(categoryId, dto.name);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'delete', subject: 'Category' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Delete a category' })
  @ApiResponse({ status: 204, description: 'Category deleted' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(@Param('categoryId', uuid) categoryId: string): Promise<void> {
    return this.categories.remove(categoryId);
  }

  // -------------------------------------------------------------- productos

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

  // Autenticación opcional: @Public() acepta anónimo, pero el guard JWT igual adjunta el usuario si viene, y aquí se decide la proyección.
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

  // --------------------------------------------------------------- imágenes

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'ProductImage' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Upload an image for a product' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Image stored' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.payloadTooLarge,
    Problems.unsupportedMediaType,
    Problems.internalError,
  )
  @Post('products/:productId/images')
  @HttpCode(HttpStatus.CREATED)
  // El techo va también en multer: sin esto un fichero enorme se lee entero en
  // memoria antes de que el servicio tenga ocasión de rechazarlo.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  uploadImage(
    @Param('productId', uuid) productId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ImageView> {
    return this.images.upload(productId, file);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'delete', subject: 'ProductImage' })
  @ApiBearerAuth('bearerAuth')
  @ApiOperation({ summary: 'Delete a product image' })
  @ApiResponse({ status: 204, description: 'Image deleted' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.internalError,
  )
  @Delete('products/:productId/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteImage(
    @Param('productId', uuid) productId: string,
    @Param('imageId', uuid) imageId: string,
  ): Promise<void> {
    return this.images.remove(productId, imageId);
  }

  // ------------------------------------------------------------------- SKUs

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
