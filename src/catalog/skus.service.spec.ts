import { Color, Size } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aFullProduct, aSku } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { ProductsService } from './products.service';
import { SkusService } from './skus.service';

describe('SkusService errors', () => {
  let h: ServiceHarness<SkusService>;
  let products: { loadForManager: jest.Mock };

  beforeEach(async () => {
    products = { loadForManager: jest.fn() };
    h = await buildService(SkusService, [
      { provide: ProductsService, useValue: products },
    ]);
    resetPrismaMock(h.prisma);
  });

  it('returns 409 for a duplicate size and colour on one product', async () => {
    const product = aFullProduct();
    products.loadForManager.mockResolvedValue(product);

    await expect(
      h.service.create(product.id, {
        size: Size.M,
        color: Color.BLACK,
        price: 2599,
        stock: 3,
      }),
    ).rejects.toMatchObject({ kind: Problems.conflict });
  });

  it('returns 409 when stock would fall below reserved units', async () => {
    const sku = aSku('product-1', { stock: 5, reserved: 3 });
    h.prisma.sku.findFirst.mockResolvedValue({
      ...sku,
      product: { images: [] },
    } as never);

    await expect(h.service.update(sku.id, { stock: 2 })).rejects.toMatchObject({
      kind: Problems.conflict,
    });
  });

  it('allows stock equal to the already reserved units', async () => {
    const sku = aSku('product-1', { stock: 5, reserved: 3 });
    h.prisma.sku.findFirst.mockResolvedValue({
      ...sku,
      product: { images: [] },
    } as never);
    h.prisma.sku.update.mockResolvedValue({ ...sku, stock: 3 });

    await expect(h.service.update(sku.id, { stock: 3 })).resolves.toMatchObject(
      {
        stock: 3,
        reserved: 3,
      },
    );
  });

  it('keeps an image when imageId is undefined but clears it for null', async () => {
    const sku = aSku('product-1', { imageId: 'image-1' });
    h.prisma.sku.findFirst.mockResolvedValue({
      ...sku,
      product: { images: [{ id: 'image-1' }] },
    } as never);
    h.prisma.sku.update.mockResolvedValue(sku);

    await h.service.update(sku.id, { price: 3000 });
    expect(h.prisma.sku.update.mock.calls[0][0]?.data).not.toHaveProperty(
      'imageId',
    );

    await h.service.update(sku.id, { imageId: null });
    expect(h.prisma.sku.update.mock.calls[1][0]?.data).toMatchObject({
      imageId: null,
    });
  });

  it('returns 404 when the SKU or its product is gone', async () => {
    h.prisma.sku.findFirst.mockResolvedValue(null);

    await expect(
      h.service.update('missing', { stock: 1 }),
    ).rejects.toMatchObject({
      kind: Problems.notFound,
    });
  });
});

/**
 * The composite FK (image_id, product_id) stops a variant at the database
 * level from pointing at another product's image. The contract promises the
 * caller gets an explained 404 instead of an integrity error, and that's
 * what's tested here.
 */
describe('SkusService image ownership', () => {
  let h: ServiceHarness<SkusService>;
  let products: { loadForManager: jest.Mock };

  beforeEach(async () => {
    products = { loadForManager: jest.fn() };
    h = await buildService(SkusService, [
      { provide: ProductsService, useValue: products },
    ]);
    resetPrismaMock(h.prisma);
  });

  it('returns 404 on create when the imageId belongs to another product', async () => {
    const product = aFullProduct({ skus: [] });
    products.loadForManager.mockResolvedValue(product);

    await expect(
      h.service.create(product.id, {
        size: Size.L,
        color: Color.RED,
        price: 1999,
        stock: 1,
        imageId: 'imagen-de-otro-producto',
      }),
    ).rejects.toMatchObject({ kind: Problems.notFound });
    expect(h.prisma.sku.create).not.toHaveBeenCalled();
  });

  it('returns 404 on update when the imageId belongs to another product', async () => {
    const sku = aSku('product-1');
    h.prisma.sku.findFirst.mockResolvedValue({
      ...sku,
      product: { images: [{ id: 'imagen-propia' }] },
    } as never);

    await expect(
      h.service.update(sku.id, { imageId: 'imagen-de-otro-producto' }),
    ).rejects.toMatchObject({ kind: Problems.notFound });
    expect(h.prisma.sku.update).not.toHaveBeenCalled();
  });

  it('accepts an imageId that does belong to the product', async () => {
    const product = aFullProduct({ skus: [] });
    products.loadForManager.mockResolvedValue(product);
    h.prisma.sku.create.mockResolvedValue(
      aSku(product.id, { imageId: product.images[0].id }),
    );
    h.prisma.productImage.findUnique.mockResolvedValue(product.images[0]);

    await expect(
      h.service.create(product.id, {
        size: Size.L,
        color: Color.RED,
        price: 1999,
        stock: 1,
        imageId: product.images[0].id,
      }),
    ).resolves.toMatchObject({ image: { id: product.images[0].id } });
  });
});
