import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aProduct } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { LikesService } from './likes.service';

/**
 * Harness only: the assertions are the student's (CLAUDE.md, Tests).
 *
 * The like has no row scope to assert, because it is addressed by the
 * caller's own id plus the product. What is worth asserting instead is the
 * pair of writes: an upsert keyed on `userId_productId`, so a double click
 * does not create two rows, and a `deleteMany` that names the caller and
 * nobody else.
 */
describe('LikesService', () => {
  let h: ServiceHarness<LikesService>;

  const client: AuthenticatedUser = {
    id: 'client-1',
    email: 'client@example.test',
    role: UserRole.CLIENT,
  };

  beforeEach(async () => {
    h = await buildService(LikesService);
    resetPrismaMock(h.prisma);
  });

  it('returns 404 for a product that does not exist', async () => {
    h.prisma.product.findFirst.mockResolvedValue(null);

    await expect(
      h.service.set(client, 'missing-product', true),
    ).rejects.toMatchObject({
      kind: Problems.notFound,
    });
    expect(h.prisma.productLike.upsert).not.toHaveBeenCalled();
  });

  it('returns 404 for a product that was soft-deleted', async () => {
    h.prisma.product.findFirst.mockResolvedValue(null);

    await expect(
      h.service.set(client, 'deleted-product', true),
    ).rejects.toMatchObject({
      kind: Problems.notFound,
    });
    expect(h.prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'deleted-product', deletedAt: null },
    });
  });

  it('upserts the like on the caller and the product when liked is true', async () => {
    const product = aProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.set(client, product.id, true);

    expect(h.prisma.productLike.upsert).toHaveBeenCalledWith({
      where: { userId_productId: { userId: client.id, productId: product.id } },
      create: {
        id: expect.any(String) as string,
        userId: client.id,
        productId: product.id,
      },
      update: {},
    });
  });

  it('leaves an existing like untouched instead of duplicating it', async () => {
    const product = aProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.set(client, product.id, true);

    expect(h.prisma.productLike.upsert).toHaveBeenCalledTimes(1);
    expect(h.prisma.productLike.create).not.toHaveBeenCalled();
    expect(h.prisma.productLike.upsert.mock.calls[0][0].update).toEqual({});
  });

  it('deletes only the caller’s like when liked is false', async () => {
    const product = aProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await h.service.set(client, product.id, false);

    expect(h.prisma.productLike.deleteMany).toHaveBeenCalledWith({
      where: { userId: client.id, productId: product.id },
    });
  });

  it('answers with the state that was asked for, in both directions', async () => {
    const product = aProduct();
    h.prisma.product.findFirst.mockResolvedValue(product);

    await expect(h.service.set(client, product.id, true)).resolves.toEqual({
      liked: true,
    });
    await expect(h.service.set(client, product.id, false)).resolves.toEqual({
      liked: false,
    });
  });
});
