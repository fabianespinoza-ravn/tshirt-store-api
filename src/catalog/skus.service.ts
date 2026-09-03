import { Injectable } from '@nestjs/common';
import { newId } from '../common/ids';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { CreateSkuDto, UpdateSkuDto } from './dto/catalog.dto';
import { toManagerSku, type ManagerSkuView } from './product.mappers';
import { NOT_DELETED, ProductsService } from '../products/products.service';

@Injectable()
export class SkusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly products: ProductsService,
  ) {}

  async create(productId: string, dto: CreateSkuDto): Promise<ManagerSkuView> {
    const product = await this.products.loadForManager(productId);

    const duplicate = product.skus.some(
      (s) => s.size === dto.size && s.color === dto.color,
    );
    if (duplicate) {
      throw new ProblemException(
        Problems.conflict,
        'This product already has a variant with that size and colour.',
      );
    }

    // The composite FK (image_id, product_id) stops a variant at the
    // database level from pointing at another product's image. Checking it
    // here lets the caller get an explained 404 instead of an integrity
    // error.
    if (dto.imageId) this.mustOwnImage(product.images, dto.imageId);

    const sku = await this.prisma.sku.create({
      data: {
        id: newId(),
        productId,
        size: dto.size,
        color: dto.color,
        price: dto.price,
        stock: dto.stock,
        ...(dto.imageId ? { imageId: dto.imageId } : {}),
      },
    });

    return toManagerSku(sku, await this.imageViewOf(sku.imageId));
  }

  // A variant has no DELETE: it's retired by setting its stock to zero; the
  // floor is the units already reserved, which is why `reserved` is
  // published instead of being discovered through a string of 409s.
  async update(skuId: string, dto: UpdateSkuDto): Promise<ManagerSkuView> {
    const sku = await this.prisma.sku.findFirst({
      where: { id: skuId, product: NOT_DELETED },
      include: { product: { include: { images: true } } },
    });

    if (!sku) {
      throw new ProblemException(
        Problems.notFound,
        'The variant does not exist, or its product has been deleted.',
      );
    }

    if (dto.stock !== undefined && dto.stock < sku.reserved) {
      throw new ProblemException(
        Problems.conflict,
        `Stock cannot go below the ${sku.reserved} unit(s) already reserved by pending orders.`,
      );
    }

    if (dto.imageId) this.mustOwnImage(sku.product.images, dto.imageId);

    // `undefined` means "don't touch it" and `null` means "remove it". The
    // distinction is the way back for a manager who attached the wrong
    // photo, and it can't depend on another image existing.
    const updated = await this.prisma.sku.update({
      where: { id: skuId },
      data: {
        ...(dto.price === undefined ? {} : { price: dto.price }),
        ...(dto.stock === undefined ? {} : { stock: dto.stock }),
        ...(dto.imageId === undefined ? {} : { imageId: dto.imageId }),
      },
    });

    // PENDING (Week 4): a price change deactivates this SKU's active Payment
    // Link, and a sale that leaves it at zero does too. That's an outbound
    // call to Stripe inside a manager request, and what happens if Stripe
    // doesn't respond is still undecided. Finding 9 of ATAQUE-DISENO.md.

    return toManagerSku(updated, await this.imageViewOf(updated.imageId));
  }

  private mustOwnImage(images: { id: string }[], imageId: string): void {
    if (!images.some((i) => i.id === imageId)) {
      throw new ProblemException(
        Problems.notFound,
        'The supplied imageId does not belong to that product.',
      );
    }
  }

  private async imageViewOf(imageId: string | null) {
    if (!imageId) return undefined;
    const row = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });
    if (!row) return undefined;
    return { id: row.id, url: await this.storage.urlFor(row.s3Key) };
  }
}
