import { Prisma } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aCategory } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { CategoriesService } from './categories.service';

// Used by the two propagation cases below: the P2002 the service now lets through.
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

  // Without at least one happy path per method, a bug that made it throw
  // ALWAYS would pass every error test.

  it('creates a category and returns only the contract fields', async () => {
    const created = aCategory({ name: 'Tees' });
    h.prisma.category.create.mockResolvedValue(created);

    const result = await h.service.create('Tees');

    // The projection doesn't carry createdAt or updatedAt: `Category` in the
    // contract is exactly id and name.
    expect(Object.keys(result).sort()).toEqual(['id', 'name']);
    expect(result).toEqual({ id: created.id, name: 'Tees' });
  });

  /**
   * These two asserted that the service caught the P2002 and rewrote it as a
   * conflict. It no longer does: the mapping moved to the `Category:name`
   * entry of src/common/problem/translators/prisma.translator.ts, so the
   * service lets the error through and the filter serves the same 409 with
   * the same detail — verified against a real duplicate insert.
   *
   * What these two assert is the half that is still the service's: that it
   * does not swallow, wrap or rewrite the error on its way out, because a
   * translator can only classify what reaches it.
   */
  it('lets the unique violation from create reach the translator untouched', async () => {
    const error = uniqueViolation();
    h.prisma.category.create.mockRejectedValue(error);

    await expect(h.service.create('Tees')).rejects.toBe(error);
  });

  it('renames a category when the new name is free', async () => {
    const category = aCategory({ name: 'Tees' });
    const renamed = { ...category, name: 'Hoodies' };
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.category.update.mockResolvedValue(renamed);

    const result = await h.service.rename(category.id, 'Hoodies');

    expect(result).toEqual({ id: category.id, name: 'Hoodies' });
  });

  /**
   * Renaming to its own name isn't a conflict: the database never fires the
   * unique violation because the row already had that name. Without this
   * case, the P2002 catch could be mistaken for an idempotent change.
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

  it('lets the unique violation from rename reach the translator untouched', async () => {
    const category = aCategory({ name: 'Tees' });
    const error = uniqueViolation();
    h.prisma.category.findUnique.mockResolvedValue(category);
    h.prisma.category.update.mockRejectedValue(error);

    await expect(h.service.rename(category.id, 'Hoodies')).rejects.toBe(error);
  });

  it('returns 404 when renaming a category that does not exist', async () => {
    h.prisma.category.findUnique.mockResolvedValue(null);

    await expect(
      h.service.rename('missing-category', 'Tees'),
    ).rejects.toMatchObject({ kind: Problems.notFound });
  });

  // The delete is hard, not soft: a category doesn't appear in any
  // historical record, and a product does.
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
   * `categories.name` is indeed unique in the model, so ordering by name
   * gives a total order and pagination doesn't repeat or skip rows. That's
   * the opposite of `products`, which needs the id to break ties.
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
