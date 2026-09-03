import { UserRole } from '@prisma/client';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { resetPrismaMock } from '../testing/prisma.mock';
import { CartService } from './cart.service';

/**
 * Harness only: the cases below name one branch of the service each, and
 * the assertions are the student's (CLAUDE.md, Tests).
 *
 * Two of them decide whether this module is safe, so they are worth more
 * than the rest put together. Since `PoliciesGuard` stopped rejecting a
 * conditional rule, the only thing keeping one client out of another's cart
 * is the scope this service folds into its Prisma `where`. Assert the
 * `where` itself — `expect(h.prisma.cart.findFirst).toHaveBeenCalledWith(...)`
 * — and not merely that a Problem was thrown: a service that dropped the
 * scope would still throw for a missing row while happily returning
 * somebody else's.
 *
 * The ability is the real one, so until the CLIENT rules exist every scope
 * here is `{ OR: [] }`. That is itself worth one case.
 */
describe('CartService', () => {
  let h: ServiceHarness<CartService>;

  const client: AuthenticatedUser = {
    id: 'client-1',
    email: 'client@example.test',
    role: UserRole.CLIENT,
  };

  beforeEach(async () => {
    h = await buildService(CartService, [AppAbilityFactory]);
    resetPrismaMock(h.prisma);
  });

  // Referenced so the harness compiles while the cases have no body.
  void client;

  describe('getCart', () => {
    it.todo('scopes the lookup with the ability and the ACTIVE status');
    it.todo('returns an empty cart instead of 404 when none was created yet');
    it.todo('maps every line with its live product name and SKU price');
    it.todo('adds the lines up into the subtotal');
    it.todo('resolves a presigned url for a line whose SKU has an image');
  });

  describe('addItem', () => {
    it.todo('returns 404 for a SKU that does not exist');
    it.todo('returns 404 for a SKU whose product was soft-deleted');
    it.todo('creates the cart on the first line and mirrors activeUserId');
    it.todo('reuses the active cart on later lines');
    it.todo('reports created for a SKU that was not in the cart');
    it.todo('grows the existing line instead of opening a second one');
    it.todo('reports not created when an existing line grew');
    it.todo(
      'returns 409 stock-unavailable when the total exceeds availability',
    );
    it.todo('returns 409 conflict when the total would pass the line cap');
    it.todo('counts the units already in the line towards both limits');
  });

  describe('updateItem', () => {
    it.todo('scopes the line lookup with the ability, so another cart is 404');
    it.todo(
      'returns 404 and never 403 for a line that belongs to somebody else',
    );
    it.todo('returns 409 when the new quantity exceeds availability');
    it.todo('writes the new quantity on the line it loaded');
    it.todo('answers with the whole cart after the update');
  });

  describe('removeItem', () => {
    it.todo('scopes the line lookup with the ability, so another cart is 404');
    it.todo('deletes the line it loaded and no other');
    it.todo('answers with the whole cart after the removal');
  });

  describe('without the CLIENT rules in the ability', () => {
    it.todo(
      'sends a where that matches no row at all, so nothing leaks before the rules exist',
    );
  });
});
