import type { Prisma } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aFullProduct } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { ProductsService } from './products.service';

/**
 * Exact shapes from the contract, `W2-API/openapi.yaml`. What's asserted is
 * the **complete set** of keys, not just the absence of the ones one happens
 * to remember: that way a future leak, a field added to the public
 * projection by accident, also breaks the test.
 */
// `image` is optional on PublicSku and ManagerSku, so there are two legal
// shapes. The fixtures below deliberately link the image to the variant:
// it's the rich case, and it's where a leak would have somewhere to hide.
const PUBLIC_SKU_KEYS = [
  'available',
  'color',
  'id',
  'image',
  'inStock',
  'price',
  'size',
];
const MANAGER_SKU_KEYS = [...PUBLIC_SKU_KEYS, 'reserved', 'stock'].sort();
const PRODUCT_DETAIL_KEYS = [
  'categories',
  'description',
  'id',
  'image',
  'images',
  'inStock',
  'name',
  'priceFrom',
  'skus',
];
const MANAGER_PRODUCT_KEYS = [
  'categories',
  'description',
  'id',
  'image',
  'images',
  'isActive',
  'name',
  'priceFrom',
  'skus',
];
const PRODUCT_SUMMARY_KEYS = [
  'categories',
  'id',
  'image',
  'inStock',
  'name',
  'priceFrom',
];

const keysOf = (value: unknown) => Object.keys(value as object).sort();

describe('ProductsService projections', () => {
  let h: ServiceHarness<ProductsService>;

  beforeEach(async () => {
    h = await buildService(ProductsService);
    resetPrismaMock(h.prisma);
  });

  it('keeps manager-only fields and exact availability in the manager projection', async () => {
    const product = aFullProduct({
      product: { isActive: false },
      skus: [{ stock: 10, reserved: 2 }],
    });
    product.skus[0].imageId = product.images[0].id;
    h.prisma.product.findFirst.mockResolvedValue(product);

    const result = await h.service.getOne(product.id, true);
    const manager = result as unknown as Record<string, unknown>;
    const sku = (manager.skus as Record<string, unknown>[])[0];

    expect(keysOf(manager)).toEqual(MANAGER_PRODUCT_KEYS);
    expect(keysOf(sku)).toEqual(MANAGER_SKU_KEYS);
    expect(manager.isActive).toBe(false);
    expect(sku.stock).toBe(10);
    expect(sku.reserved).toBe(2);
    expect(sku.available).toBe(8);
  });

  it('does not leak manager-only fields and hides plentiful public availability', async () => {
    const product = aFullProduct({ skus: [{ stock: 10, reserved: 0 }] });
    product.skus[0].imageId = product.images[0].id;
    h.prisma.product.findFirst.mockResolvedValue(product);

    const result = await h.service.getOne(product.id, false);
    const detail = result as unknown as Record<string, unknown>;
    const sku = (detail.skus as Record<string, unknown>[])[0];

    // The exact set covers what `not.toHaveProperty` can't: a new field
    // leaked into the public projection also breaks here.
    expect(keysOf(detail)).toEqual(PRODUCT_DETAIL_KEYS);
    expect(keysOf(sku)).toEqual(PUBLIC_SKU_KEYS);
    expect(sku.available).toBeNull();
  });

  it('shows exact public availability at the scarcity threshold', async () => {
    const product = aFullProduct({ skus: [{ stock: 5, reserved: 0 }] });
    h.prisma.product.findFirst.mockResolvedValue(product);

    const result = await h.service.getOne(product.id, false);
    const sku = (
      (result as unknown as Record<string, unknown>).skus as Record<
        string,
        unknown
      >[]
    )[0];

    expect(sku.available).toBe(5);
  });

  /**
   * What decides that an inactive product is a 404 to the public **is the
   * `where`**, not whatever the query returns. Asserting only on the mocked
   * result would let someone delete the publication filter slip through: the
   * test would stay green because the mock returns whatever it's told to.
   */
  it('scopes the query by visibility instead of by the caller', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.getOne(product.id, false);
    await h.service.getOne(product.id, true);

    const publicArgs = h.prisma.product.findFirst.mock
      .calls[0][0] as Prisma.ProductFindFirstArgs;
    const manager = h.prisma.product.findFirst.mock
      .calls[1][0] as Prisma.ProductFindFirstArgs;

    expect(publicArgs.where).toMatchObject({
      id: product.id,
      isActive: true,
      deletedAt: null,
      skus: { some: {} },
      images: { some: {} },
    });

    // A manager sees states the catalog never exposes, so their query only
    // excludes what's deleted.
    expect(manager.where).toEqual({ id: product.id, deletedAt: null });
    expect(manager.where).not.toHaveProperty('isActive');
  });

  it('returns 404 to the public for a product outside the published set', async () => {
    h.prisma.product.findFirst.mockResolvedValue(null);

    await expect(h.service.getOne('any-id', false)).rejects.toMatchObject({
      kind: Problems.notFound,
    });
  });
});

describe('ProductsService list', () => {
  let h: ServiceHarness<ProductsService>;

  beforeEach(async () => {
    h = await buildService(ProductsService);
    resetPrismaMock(h.prisma);
  });

  it('summarises a product with the aggregates the contract requires', async () => {
    const product = aFullProduct({
      skus: [
        { price: 4000, stock: 0, reserved: 0 },
        { price: 2599, stock: 3, reserved: 1 },
      ],
    });
    h.prisma.product.findMany.mockResolvedValue([product]);
    h.prisma.product.count.mockResolvedValue(1);

    const page = await h.service.list({ limit: 20, offset: 0 });
    const row = page.data[0] as unknown as Record<string, unknown>;

    expect(keysOf(row)).toEqual(PRODUCT_SUMMARY_KEYS);
    // priceFrom is the minimum across the variants, not the first one's.
    expect(row.priceFrom).toBe(2599);
    // inStock only needs ONE variant to have availability, even if another
    // one is at zero.
    expect(row.inStock).toBe(true);
    // The cover is the first image by id order.
    expect((row.image as { id: string }).id).toBe(product.images[0].id);
    expect(page.meta).toEqual({ limit: 20, offset: 0, total: 1 });
  });

  it('reports a product as out of stock when every variant is fully reserved', async () => {
    const product = aFullProduct({ skus: [{ stock: 2, reserved: 2 }] });
    h.prisma.product.findMany.mockResolvedValue([product]);
    h.prisma.product.count.mockResolvedValue(1);

    const page = await h.service.list({ limit: 20, offset: 0 });

    expect((page.data[0] as unknown as Record<string, unknown>).inStock).toBe(
      false,
    );
  });

  /**
   * `products.name` is NOT unique in the model, so ordering by name alone
   * leaves the order undefined between homonyms, and paginating can repeat
   * or skip a row. Breaking the tie with id is finding 25's fix in
   * docs/DESIGN-ATTACK.md.
   */
  it('breaks the name ordering tie with the id', async () => {
    h.prisma.product.findMany.mockResolvedValue([]);
    h.prisma.product.count.mockResolvedValue(0);

    await h.service.list({ limit: 20, offset: 0 });

    const args = h.prisma.product.findMany.mock
      .calls[0][0] as Prisma.ProductFindManyArgs;

    expect(args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });

  it('lists only published products and honours the category filter', async () => {
    h.prisma.product.findMany.mockResolvedValue([]);
    h.prisma.product.count.mockResolvedValue(0);

    await h.service.list({ limit: 5, offset: 10, categoryId: 'cat-1' });

    const args = h.prisma.product.findMany.mock
      .calls[0][0] as Prisma.ProductFindManyArgs;

    expect(args.where).toMatchObject({
      isActive: true,
      deletedAt: null,
      skus: { some: {} },
      images: { some: {} },
      categories: { some: { categoryId: 'cat-1' } },
    });
    expect(args.skip).toBe(10);
    expect(args.take).toBe(5);
  });
});

describe('ProductsService writes', () => {
  let h: ServiceHarness<ProductsService>;

  beforeEach(async () => {
    h = await buildService(ProductsService);
    resetPrismaMock(h.prisma);
  });

  it('returns 404 when creation references a category that no longer exists', async () => {
    h.prisma.category.count.mockResolvedValue(0);

    await expect(
      h.service.create({
        name: 'Tee',
        description: 'Cotton',
        categoryIds: ['gone'],
      }),
    ).rejects.toMatchObject({ kind: Problems.notFound });
  });

  it('returns 409 instead of retiring a product with reserved units', async () => {
    const product = aFullProduct({ skus: [{ stock: 4, reserved: 1 }] });
    h.prisma.product.findFirst.mockResolvedValue(product);

    await expect(h.service.remove(product.id)).rejects.toMatchObject({
      kind: Problems.conflict,
    });
  });
});

/**
 * The writes. What's asserted comes from the contract: `CreateProductRequest`
 * requires at least one `categoryId`, `POST /products`'s 404 means one of
 * them doesn't exist, and `DELETE /products/{id}` declares that the 409
 * means a variant still holds units from pending orders.
 */
describe('ProductsService writes', () => {
  let h: ServiceHarness<ProductsService>;

  beforeEach(async () => {
    h = await buildService(ProductsService);
    resetPrismaMock(h.prisma);
  });

  it('links one row per supplied category', async () => {
    const created = aFullProduct();
    h.prisma.category.count.mockResolvedValue(2);
    h.prisma.product.create.mockResolvedValue(created);
    h.prisma.product.findFirst.mockResolvedValue(created);

    await h.service.create({
      name: 'Tee',
      description: 'Cotton',
      categoryIds: ['cat-1', 'cat-2'],
    });

    const links = h.prisma.productCategory.createMany.mock.calls[0][0]
      ?.data as { categoryId: string; productId: string }[];
    expect(links).toHaveLength(2);
    expect(links.map((e) => e.categoryId)).toEqual(['cat-1', 'cat-2']);
    expect(new Set(links.map((e) => e.productId)).size).toBe(1);
  });

  /**
   * The check works by count: if any of the ids doesn't exist, the total
   * doesn't match and nothing gets written. Checking one by one would cost
   * N queries.
   */
  it('returns 404 and writes nothing when a category does not exist', async () => {
    h.prisma.category.count.mockResolvedValue(1);

    await expect(
      h.service.create({
        name: 'Tee',
        description: 'Cotton',
        categoryIds: ['cat-1', 'cat-missing'],
      }),
    ).rejects.toMatchObject({ kind: Problems.notFound });
    expect(h.prisma.product.create).not.toHaveBeenCalled();
    expect(h.prisma.productCategory.createMany).not.toHaveBeenCalled();
  });

  /**
   * Omitting a field means "don't touch it", not "set it to null". Without
   * this distinction, a PATCH that only changes the name would wipe out the
   * description.
   */
  it('only writes the fields the request actually carries', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.update(product.id, { name: 'New name' });

    const written = h.prisma.product.update.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(written).toEqual({ name: 'New name' });
    expect(h.prisma.productCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces the category set when categoryIds is supplied', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);
    h.prisma.category.count.mockResolvedValue(1);

    await h.service.update(product.id, { categoryIds: ['cat-new'] });

    expect(h.prisma.productCategory.deleteMany).toHaveBeenCalledWith({
      where: { productId: product.id },
    });
    const links = h.prisma.productCategory.createMany.mock.calls[0][0]
      ?.data as { categoryId: string }[];
    expect(links.map((e) => e.categoryId)).toEqual(['cat-new']);
  });

  it('can disable a product without deleting it', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.update(product.id, { isActive: false });

    expect(h.prisma.product.update.mock.calls[0][0].data).toEqual({
      isActive: false,
    });
  });

  /**
   * The delete is soft and terminal: the row survives because order history
   * references it through the SKU, and there's no restore path.
   */
  it('soft deletes and deactivates in one write', async () => {
    const product = aFullProduct({ skus: [{ stock: 5, reserved: 0 }] });
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.remove(product.id);

    expect(h.prisma.product.update).toHaveBeenCalledWith({
      where: { id: product.id },
      data: { deletedAt: expect.any(Date) as Date, isActive: false },
    });
  });

  it('refuses to delete while any variant still holds reserved units', async () => {
    const product = aFullProduct({
      skus: [
        { stock: 5, reserved: 0 },
        { stock: 4, reserved: 2 },
      ],
    });
    h.prisma.product.findFirst.mockResolvedValue(product);

    await expect(h.service.remove(product.id)).rejects.toMatchObject({
      kind: Problems.conflict,
    });
    expect(h.prisma.product.update).not.toHaveBeenCalled();
  });
});
