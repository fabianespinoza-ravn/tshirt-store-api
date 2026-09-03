import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { buildService, type ServiceHarness } from '../testing/build-service';
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

  // Referenced so the harness compiles while the cases have no body.
  void client;

  it.todo('returns 404 for a product that does not exist');
  it.todo('returns 404 for a product that was soft-deleted');
  it.todo('upserts the like on the caller and the product when liked is true');
  it.todo('leaves an existing like untouched instead of duplicating it');
  it.todo('deletes only the caller’s like when liked is false');
  it.todo('answers with the state that was asked for, in both directions');
});
