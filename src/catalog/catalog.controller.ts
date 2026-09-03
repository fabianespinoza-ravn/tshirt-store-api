import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
import { MAX_IMAGE_BYTES } from '../storage/storage.service';
import { CreateSkuDto, UpdateSkuDto } from './dto/catalog.dto';
import { ImagesService } from './images.service';
import type { ImageView, ManagerSkuView } from './product.mappers';
import { SkusService } from './skus.service';

// Alias to shorten the signatures: every route id is validated as a UUID.
const uuid = ParseUUIDPipe;

@ApiTags('Catalog')
@Controller()
export class CatalogController {
  constructor(
    private readonly images: ImagesService,
    private readonly skus: SkusService,
  ) {}

  // --------------------------------------------------------------- images

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
  // The cap also lives in multer: without this, a huge file gets read
  // entirely into memory before the service ever has a chance to reject it.
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
