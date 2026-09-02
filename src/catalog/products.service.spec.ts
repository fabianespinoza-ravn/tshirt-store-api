import type { Prisma } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aFullProduct } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { ProductsService } from './products.service';

/**
 * Formas exactas del contrato, `W2-API/openapi.yaml`. Se afirma el **conjunto
 * completo** de claves y no sólo la ausencia de las que uno recuerda: así una
 * fuga futura, un campo añadido sin querer a la proyección pública, también
 * rompe el test.
 */
// `image` es opcional en PublicSku y ManagerSku, así que hay dos formas legales.
// Los fixtures de abajo enlazan la imagen a la variante a propósito: es el caso
// rico, y es donde una fuga tendría dónde esconderse.
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

    // El conjunto exacto cubre lo que `not.toHaveProperty` no puede: un campo
    // nuevo filtrado a la proyección pública también rompe aquí.
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
   * Lo que decide que un producto inactivo sea 404 para el público **es el
   * `where`**, no lo que devuelva la consulta. Afirmar sólo sobre el resultado
   * simulado dejaría pasar que alguien borrase el filtro de publicación: el test
   * seguiría verde porque el mock devuelve lo que se le dijo.
   */
  it('scopes the query by visibility instead of by the caller', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.getOne(product.id, false);
    await h.service.getOne(product.id, true);

    const publico = h.prisma.product.findFirst.mock
      .calls[0][0] as Prisma.ProductFindFirstArgs;
    const manager = h.prisma.product.findFirst.mock
      .calls[1][0] as Prisma.ProductFindFirstArgs;

    expect(publico.where).toMatchObject({
      id: product.id,
      isActive: true,
      deletedAt: null,
      skus: { some: {} },
      images: { some: {} },
    });

    // El manager ve estados que el catálogo nunca expone, así que su consulta
    // sólo excluye lo borrado.
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
    // priceFrom es el mínimo de las variantes, no el de la primera.
    expect(row.priceFrom).toBe(2599);
    // inStock basta con que UNA variante tenga disponible, aunque otra esté a cero.
    expect(row.inStock).toBe(true);
    // La portada es la primera imagen por orden de id.
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
   * `products.name` NO es único en el modelo, así que ordenar sólo por nombre
   * deja el orden indefinido entre homónimos y paginar puede repetir o saltarse
   * una fila. El desempate por id es la corrección del hallazgo 25.
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
 * Las escrituras. Lo que se afirma sale del contrato: `CreateProductRequest`
 * exige al menos un `categoryId`, el 404 de `POST /products` significa que
 * alguno no existe, y `DELETE /products/{id}` declara que el 409 es que una
 * variante todavía retiene unidades de pedidos pendientes.
 */
describe('ProductsService writes', () => {
  let h: ServiceHarness<ProductsService>;

  beforeEach(async () => {
    h = await buildService(ProductsService);
    resetPrismaMock(h.prisma);
  });

  it('links one row per supplied category', async () => {
    const creado = aFullProduct();
    h.prisma.category.count.mockResolvedValue(2);
    h.prisma.product.create.mockResolvedValue(creado);
    h.prisma.product.findFirst.mockResolvedValue(creado);

    await h.service.create({
      name: 'Camiseta',
      description: 'Algodón',
      categoryIds: ['cat-1', 'cat-2'],
    });

    const enlaces = h.prisma.productCategory.createMany.mock.calls[0][0]
      ?.data as { categoryId: string; productId: string }[];
    expect(enlaces).toHaveLength(2);
    expect(enlaces.map((e) => e.categoryId)).toEqual(['cat-1', 'cat-2']);
    expect(new Set(enlaces.map((e) => e.productId)).size).toBe(1);
  });

  /**
   * El chequeo es por conteo: si alguno de los ids no existe, el total no
   * coincide y nada se escribe. Comprobarlo uno a uno costaría N consultas.
   */
  it('returns 404 and writes nothing when a category does not exist', async () => {
    h.prisma.category.count.mockResolvedValue(1);

    await expect(
      h.service.create({
        name: 'Camiseta',
        description: 'Algodón',
        categoryIds: ['cat-1', 'cat-inexistente'],
      }),
    ).rejects.toMatchObject({ kind: Problems.notFound });
    expect(h.prisma.product.create).not.toHaveBeenCalled();
    expect(h.prisma.productCategory.createMany).not.toHaveBeenCalled();
  });

  /**
   * Omitir un campo significa "no lo toques" y no "ponlo a null". Sin esta
   * distinción, un PATCH que sólo cambia el nombre borraría la descripción.
   */
  it('only writes the fields the request actually carries', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.update(product.id, { name: 'Nuevo nombre' });

    const escrito = h.prisma.product.update.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(escrito).toEqual({ name: 'Nuevo nombre' });
    expect(h.prisma.productCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces the category set when categoryIds is supplied', async () => {
    const product = aFullProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);
    h.prisma.category.count.mockResolvedValue(1);

    await h.service.update(product.id, { categoryIds: ['cat-nueva'] });

    expect(h.prisma.productCategory.deleteMany).toHaveBeenCalledWith({
      where: { productId: product.id },
    });
    const enlaces = h.prisma.productCategory.createMany.mock.calls[0][0]
      ?.data as { categoryId: string }[];
    expect(enlaces.map((e) => e.categoryId)).toEqual(['cat-nueva']);
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
   * El borrado es lógico y terminal: la fila sobrevive porque el historial de
   * pedidos la referencia a través del SKU, y no hay ruta de restauración.
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
