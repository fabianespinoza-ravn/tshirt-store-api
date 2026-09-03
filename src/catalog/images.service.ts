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
    // El producto se comprueba primero: subir a S3 y luego descubrir que no
    // existe deja un objeto huérfano que nadie va a borrar.
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

    // `file.mimetype` es un dato que declara el cliente en la petición
    // multipart; Multer nunca abre el archivo para comprobarlo. Verificamos
    // los bytes reales y sólo seguimos si coinciden con lo declarado, para no
    // guardar un archivo bajo una etiqueta que no le corresponde.
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
      // Si la fila falla después de subir el objeto, hay que deshacer el
      // `put`: sin esto el objeto queda huérfano en S3 para siempre, porque
      // este repositorio no tiene barredor que reconcilie objetos sin fila.
      await this.storage.remove(s3Key);
      throw error;
    }

    return { id: row.id, url: await this.storage.urlFor(row.s3Key) };
  }

  // El 409 distingue dos causas porque el remedio difiere: repuntar la variante a otra imagen, o subir un reemplazo antes de borrar.
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

    // La fila primero: si falla el borrado en S3 queda un objeto huérfano, que es
    // basura barata. Al revés quedaría una fila apuntando a algo que ya no está,
    // y eso rompe el correo de reposición de F8.
    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.storage.remove(image.s3Key);
  }
}
