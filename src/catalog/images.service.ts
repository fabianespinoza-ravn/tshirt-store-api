import { Injectable } from '@nestjs/common';
import { newId } from '../common/ids';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  StorageService,
  detectImageType,
} from '../storage/storage.service';
import type { ImageView } from './product.mappers';
import { ProductsService } from './products.service';

@Injectable()
export class ImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly products: ProductsService,
  ) {}

  async upload(
    productId: string,
    file: Express.Multer.File | undefined,
  ): Promise<ImageView> {
    // The product is checked first: uploading to S3 and only then finding
    // out it doesn't exist leaves an orphaned object nobody will delete.
    await this.products.loadForManager(productId);

    if (!file) {
      throw new ProblemException(Problems.validation, 'A file is required.');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new ProblemException(
        Problems.payloadTooLarge,
        'Product images are limited to 5 MB.',
      );
    }
    if (!ACCEPTED_IMAGE_TYPES.includes(file.mimetype as never)) {
      throw new ProblemException(
        Problems.unsupportedMediaType,
        `Accepted types are ${ACCEPTED_IMAGE_TYPES.join(', ')}.`,
      );
    }

    // `file.mimetype` is data the client declares in the multipart request;
    // Multer never opens the file to check it. We verify the actual bytes
    // and only proceed if they match what was declared, so we don't store a
    // file under a label it doesn't deserve.
    const verifiedType = detectImageType(file.buffer);
    if (!verifiedType || verifiedType !== file.mimetype) {
      throw new ProblemException(
        Problems.unsupportedMediaType,
        `Accepted types are ${ACCEPTED_IMAGE_TYPES.join(', ')}.`,
      );
    }

    const s3Key = this.storage.buildKey(productId, verifiedType);
    await this.storage.put(s3Key, file.buffer, file.mimetype);

    let row;
    try {
      row = await this.prisma.productImage.create({
        data: { id: newId(), productId, s3Key },
      });
    } catch (error) {
      // If the row fails after uploading the object, the `put` has to be
      // undone: without this the object stays orphaned in S3 forever,
      // because this repository has no sweeper that reconciles objects with
      // no row.
      await this.storage.remove(s3Key);
      throw error;
    }

    return { id: row.id, url: await this.storage.urlFor(row.s3Key) };
  }

  // The 409 distinguishes two causes because the remedy differs: repoint the
  // variant to another image, or upload a replacement before deleting.
  async remove(productId: string, imageId: string): Promise<void> {
    const product = await this.products.loadForManager(productId);
    const image = product.images.find((i) => i.id === imageId);

    if (!image) {
      throw new ProblemException(
        Problems.notFound,
        'The image does not exist or does not belong to that product.',
      );
    }

    const usedBy = await this.prisma.sku.count({ where: { imageId } });
    if (usedBy > 0) {
      throw new ProblemException(
        Problems.conflict,
        `The image is still used by ${usedBy} variant(s). Repoint them to another image or to none first.`,
      );
    }

    if (product.isActive && product.images.length === 1) {
      throw new ProblemException(
        Problems.conflict,
        'An active product cannot be left without images. Upload a replacement first, or disable the product.',
      );
    }

    // The row first: if the S3 delete fails, an orphaned object is left
    // behind, which is cheap garbage. The other way around would leave a row
    // pointing at something that's gone, and that breaks F8's restock
    // email.
    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.storage.remove(image.s3Key);
  }
}
