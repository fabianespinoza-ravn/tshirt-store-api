import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aFullProduct, aMulterFile } from '../testing/factories';
import { aMulterFile } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { ImagesService } from './images.service';
import { ProductsService } from './products.service';

describe('ImagesService errors', () => {
  let h: ServiceHarness<ImagesService>;
  let products: { loadForManager: jest.Mock };

  beforeEach(async () => {
    products = { loadForManager: jest.fn() };
    h = await buildService(ImagesService, [
      { provide: ProductsService, useValue: products },
    ]);
    resetPrismaMock(h.prisma);
  });

  it('returns 409 when an image is still used by a SKU', async () => {
    const product = aFullProduct({ images: [] });
    const image = {
      id: 'image-1',
      productId: product.id,
      s3Key: 'key',
      createdAt: new Date(),
    };
    product.images.push(image);
    products.loadForManager.mockResolvedValue(product);
    h.prisma.sku.count.mockResolvedValue(1);

    await expect(h.service.remove(product.id, image.id)).rejects.toMatchObject({
      kind: Problems.conflict,
    });
  });

  it('returns 409 when deleting the last image of an active product', async () => {
    const product = aFullProduct();
    products.loadForManager.mockResolvedValue(product);
    h.prisma.sku.count.mockResolvedValue(0);

    await expect(
      h.service.remove(product.id, product.images[0].id),
    ).rejects.toMatchObject({
      kind: Problems.conflict,
    });
  });

  it('returns 404 when the image belongs to another product', async () => {
    const product = aFullProduct({ images: [] });
    products.loadForManager.mockResolvedValue(product);

    await expect(
      h.service.remove(product.id, 'other-image'),
    ).rejects.toMatchObject({
      kind: Problems.notFound,
    });
  });

  it('uploads a valid image after checking that its product exists', async () => {
    const product = aFullProduct();
    const file = aMulterFile();
    products.loadForManager.mockResolvedValue(product);
    h.prisma.productImage.create.mockResolvedValue({
      id: 'image-2',
      productId: product.id,
      s3Key: 'products/key.png',
      createdAt: new Date(),
    });
    h.storage.buildKey.mockReturnValue('products/key.png');

    await expect(h.service.upload(product.id, file)).resolves.toEqual({
      id: 'image-2',
      url: 'https://s3.test/products/key.png?firmada',
    });
  });
});

/**
 * Las tres validaciones de subida y la garantía de orden. Cada expectativa sale
 * del contrato, `POST /products/{productId}/images`, que declara 400, 413 y 415
 * y los tipos aceptados.
 */
describe('ImagesService upload validation', () => {
  let h: ServiceHarness<ImagesService>;
  let products: { loadForManager: jest.Mock };

  beforeEach(async () => {
    products = { loadForManager: jest.fn() };
    h = await buildService(ImagesService, [
      { provide: ProductsService, useValue: products },
    ]);
    resetPrismaMock(h.prisma);
    products.loadForManager.mockResolvedValue(aFullProduct());
  });

  it('returns 400 when no file reaches the handler', async () => {
    await expect(
      h.service.upload('product-1', undefined),
    ).rejects.toMatchObject({ kind: Problems.validation });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it('returns 413 above the declared 5 MB ceiling', async () => {
    const file = aMulterFile({ size: 5 * 1024 * 1024 + 1 });

    await expect(h.service.upload('product-1', file)).rejects.toMatchObject({
      kind: Problems.payloadTooLarge,
    });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it('accepts a file sitting exactly on the ceiling', async () => {
    const file = aMulterFile({ size: 5 * 1024 * 1024 });
    h.storage.buildKey.mockReturnValue('products/borde.png');
    h.prisma.productImage.create.mockResolvedValue({
      id: 'image-borde',
      productId: 'product-1',
      s3Key: 'products/borde.png',
      createdAt: new Date(),
    });

    await expect(h.service.upload('product-1', file)).resolves.toMatchObject({
      id: 'image-borde',
    });
  });

  it('returns 415 for a type outside jpeg, png and webp', async () => {
    const file = aMulterFile({ mimetype: 'application/pdf' });

    await expect(h.service.upload('product-1', file)).rejects.toMatchObject({
      kind: Problems.unsupportedMediaType,
    });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  /**
   * El producto se valida ANTES de subir. Sin esta prueba, mover la validación
   * después del `put` deja objetos huérfanos en S3 que nadie va a borrar, y
   * ningún test lo nota.
   */
  it('does not touch S3 when the product does not exist', async () => {
    products.loadForManager.mockRejectedValue(
      new ProblemException(Problems.notFound, 'no existe'),
    );

    await expect(
      h.service.upload('product-1', aMulterFile()),
    ).rejects.toMatchObject({ kind: Problems.notFound });
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.prisma.productImage.create).not.toHaveBeenCalled();
  });

  /**
   * En el borrado el orden es el contrario y también importa: la fila cae antes
   * que el objeto. Al revés quedaría una fila apuntando a algo que ya no está, y
   * eso rompe el correo de F8, que adjunta la imagen.
   */
  it('deletes the row before the S3 object', async () => {
    const product = aFullProduct();
    const extra = {
      id: 'image-2',
      productId: product.id,
      s3Key: 'products/segunda.png',
      createdAt: new Date(),
    };
    product.images.push(extra);
    products.loadForManager.mockResolvedValue(product);
    h.prisma.sku.count.mockResolvedValue(0);

    const orden: string[] = [];
    h.prisma.productImage.delete.mockImplementation((() => {
      orden.push('fila');
      return Promise.resolve(extra);
    }) as never);
    h.storage.remove.mockImplementation(() => {
      orden.push('s3');
      return Promise.resolve();
    });

    await h.service.remove(product.id, extra.id);

    expect(orden).toEqual(['fila', 's3']);
  });
});
