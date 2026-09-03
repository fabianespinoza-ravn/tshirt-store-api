import { Prisma } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aCategory } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { CategoriesService } from './categories.service';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });

describe('CategoriesService', () => {
  let h: ServiceHarness<CategoriesService>;

  beforeEach(async () => {
    h = await buildService(CategoriesService);
    resetPrismaMock(h.prisma);
  });

  // Sin al menos un camino feliz por método, un fallo que hiciera lanzar SIEMPRE
  // pasaría todos los tests de error.

  it('creates a category and returns only the contract fields', async () => {
    const created = aCategory({ name: 'Tees' });
    h.prisma.category.create.mockResolvedValue(created);

    const result = await h.service.create('Tees');

    // La proyección no arrastra createdAt ni updatedAt: `Category` en el
    // contrato son exactamente id y name.
    expect(Object.keys(result).sort()).toEqual(['id', 'name']);
    expect(result).toEqual({ id: created.id, name: 'Tees' });
  });

  // The unique index, not a findUnique probe, is what decides this: a P2002
  // from the write is what "the name is taken" looks like now.
  it('rejects creating a category whose name is already used', async () => {
    h.prisma.category.create.mockRejectedValue(uniqueViolation());

    await expect(h.service.create('Tees')).rejects.toMatchObject({
      kind: Problems.conflict,
    });
  });

  it('renames a category when the new name is free', async () => {
    const category = aCategory({ name: 'Tees' });
    const renamed = { ...category, name: 'Camisetas' };
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.category.update.mockResolvedValue(renamed);

    const result = await h.service.rename(category.id, 'Camisetas');

    expect(result).toEqual({ id: category.id, name: 'Camisetas' });
  });

  /**
   * Renombrar a su propio nombre no es un conflicto: la base no dispara la
   * violación de unicidad porque la fila ya tenía ese nombre. Sin este caso,
   * el catch de P2002 podría confundirse con un cambio idempotente.
   */
  it('lets a category keep its own name', async () => {
    const category = aCategory({ name: 'Tees' });
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.category.update.mockResolvedValue(category);

    await expect(h.service.rename(category.id, 'Tees')).resolves.toEqual({
      id: category.id,
      name: 'Tees',
    });
  });

  it('rejects renaming a category to another category name', async () => {
    const category = aCategory({ name: 'Tees' });
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.category.update.mockRejectedValue(uniqueViolation());

    await expect(
      h.service.rename(category.id, 'Hoodies'),
    ).rejects.toMatchObject({ kind: Problems.conflict });
  });

  it('returns 404 when renaming a category that does not exist', async () => {
    h.prisma.category.findUnique.mockResolvedValue(null);

    await expect(
      h.service.rename('missing-category', 'Tees'),
    ).rejects.toMatchObject({ kind: Problems.notFound });
  });

  // El borrado es físico, no lógico: una categoría no aparece en ningún registro
  // histórico y un producto sí.
  it('deletes a category that no product uses', async () => {
    const category = aCategory();
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.productCategory.count.mockResolvedValue(0);

    await h.service.remove(category.id);

    expect(h.prisma.category.delete).toHaveBeenCalledWith({
      where: { id: category.id },
    });
  });

  it('rejects deleting a category while products are assigned to it', async () => {
    const category = aCategory();
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.productCategory.count.mockResolvedValue(2);

    await expect(h.service.remove(category.id)).rejects.toMatchObject({
      kind: Problems.conflict,
    });
    expect(h.prisma.category.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when deleting a category that does not exist', async () => {
    h.prisma.category.findUnique.mockResolvedValue(null);

    await expect(h.service.remove('missing-category')).rejects.toMatchObject({
      kind: Problems.notFound,
    });
  });

  /**
   * `categories.name` sí es único en el modelo, así que ordenar por nombre da un
   * orden total y paginar no repite ni salta filas. Es lo contrario que
   * `products`, que necesita desempatar con el id.
   */
  it('pages categories by name and returns the shared envelope', async () => {
    const rows = [aCategory({ name: 'Hoodies' }), aCategory({ name: 'Tees' })];
    h.prisma.category.findMany.mockResolvedValue(rows);
    h.prisma.category.count.mockResolvedValue(7);

    const page = await h.service.list({ limit: 2, offset: 4 });
    const args = h.prisma.category.findMany.mock
      .calls[0][0] as Prisma.CategoryFindManyArgs;

    expect(args.orderBy).toEqual({ name: 'asc' });
    expect(args.skip).toBe(4);
    expect(args.take).toBe(2);
    expect(page.data).toEqual([
      { id: rows[0].id, name: 'Hoodies' },
      { id: rows[1].id, name: 'Tees' },
    ]);
    expect(page.meta).toEqual({ limit: 2, offset: 4, total: 7 });
  });
});
