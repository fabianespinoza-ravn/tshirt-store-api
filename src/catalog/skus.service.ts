import { Injectable } from '@nestjs/common';
import { newId } from '../common/ids';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { CreateSkuDto, UpdateSkuDto } from './dto/catalog.dto';
import { toManagerSku, type ManagerSkuView } from './product.mappers';
import { NOT_DELETED, ProductsService } from './products.service';

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

    // La FK compuesta (image_id, product_id) impide en la base que una variante
    // apunte a la imagen de otro producto. Comprobarlo aquí sirve para que el
    // caller reciba un 404 explicado en vez de un error de integridad.
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

  // Una variante no tiene DELETE: se retira poniendo su stock a cero; el mínimo son las unidades ya reservadas, y por eso `reserved` se publica en vez de descubrirse a base de 409.
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

    // `undefined` significa "no lo toques" y `null` significa "quítala". La
    // distinción es la vuelta atrás para un manager que enganchó la foto
    // equivocada, y no puede depender de que exista otra imagen.
    const updated = await this.prisma.sku.update({
      where: { id: skuId },
      data: {
        ...(dto.price === undefined ? {} : { price: dto.price }),
        ...(dto.stock === undefined ? {} : { stock: dto.stock }),
        ...(dto.imageId === undefined ? {} : { imageId: dto.imageId }),
      },
    });

    // PENDIENTE (Semana 4): un cambio de precio desactiva el Payment Link activo
    // de este SKU, y una venta que lo deje a cero también. Es una llamada
    // saliente a Stripe dentro de una petición de manager, y qué pasa si Stripe
    // no responde sigue sin decidirse. Hallazgo 9 de ATAQUE-DISENO.md.

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
