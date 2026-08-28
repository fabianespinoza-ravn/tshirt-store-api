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
import { ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PaginationQueryDto, type Paginated } from '../common/pagination';
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
  @Get('categories')
  listCategories(
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<CategoryView>> {
    return this.categories.list(query);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'Category' })
  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategory(@Body() dto: CreateCategoryDto): Promise<CategoryView> {
    return this.categories.create(dto.name);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'update', subject: 'Category' })
  @Patch('categories/:categoryId')
  updateCategory(
    @Param('categoryId', uuid) categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.rename(categoryId, dto.name);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'delete', subject: 'Category' })
  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(@Param('categoryId', uuid) categoryId: string): Promise<void> {
    return this.categories.remove(categoryId);
  }

  // -------------------------------------------------------------- productos

  @Public()
  @Get('products')
  listProducts(
    @Query() query: ListProductsQueryDto,
  ): Promise<Paginated<ProductSummaryView>> {
    return this.products.list(query);
  }

  // Autenticación opcional: @Public() acepta anónimo, pero el guard JWT igual adjunta el usuario si viene, y aquí se decide la proyección.
  @Public()
  @Get('products/:productId')
  getProduct(
    @Param('productId', uuid) productId: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<ProductDetailView | ManagerProductView> {
    return this.products.getOne(productId, user?.role === 'MANAGER');
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'Product' })
  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  createProduct(@Body() dto: CreateProductDto): Promise<ManagerProductView> {
    return this.products.create(dto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'update', subject: 'Product' })
  @Patch('products/:productId')
  updateProduct(
    @Param('productId', uuid) productId: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ManagerProductView> {
    return this.products.update(productId, dto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'delete', subject: 'Product' })
  @Delete('products/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteProduct(@Param('productId', uuid) productId: string): Promise<void> {
    return this.products.remove(productId);
  }

  // --------------------------------------------------------------- imágenes

  @UseGuards(PoliciesGuard)
  @CheckPolicies({ action: 'create', subject: 'ProductImage' })
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
  @Patch('skus/:skuId')
  updateSku(
    @Param('skuId', uuid) skuId: string,
    @Body() dto: UpdateSkuDto,
  ): Promise<ManagerSkuView> {
    return this.skus.update(skuId, dto);
  }
}
