import { OrderStatus, UserRole } from '@prisma/client';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import {
  aCart,
  aCartItem,
  anOrder,
  anOrderItem,
  aProduct,
  aSku,
} from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { OrdersService } from './orders.service';

/**
 * The cases that decide whether this module is safe are the ones about the
 * `where` and the ones about the transaction, and they fail differently.
 *
 * The scope is the same story as the cart: `PoliciesGuard` stopped rejecting
 * a conditional rule, so the only thing keeping one client out of another's
 * order is what this service folds into its Prisma `where`. Assert the
 * `where` itself — a service that dropped the scope would still throw a 404
 * for a missing row while returning somebody else's.
 *
 * The transaction is new. Availability is `stock - reserved`, which cannot
 * be expressed as an atomic `where`, so the check and the increment are two
 * statements and only the isolation level stops two checkouts from both
 * passing the check and overselling by one. That is why `checkout` asserts
 * how `$transaction` was called and not only what it produced: a version
 * that dropped the isolation option would pass every test that looked at
 * the resulting order.
 */
describe('OrdersService', () => {
  let h: ServiceHarness<OrdersService>;

  const client: AuthenticatedUser = {
    id: 'client-1',
    email: 'client@example.test',
    role: UserRole.CLIENT,
  };

  const manager: AuthenticatedUser = {
    id: 'manager-1',
    email: 'manager@example.test',
    role: UserRole.MANAGER,
  };

  beforeEach(async () => {
    h = await buildService(OrdersService, [AppAbilityFactory]);
    resetPrismaMock(h.prisma);
  });

  describe('checkout', () => {
    it.todo('refuses a caller with no active cart');
    it.todo('refuses an active cart with no lines');
    it.todo(
      'settles a pending order that already lapsed, giving its units back before reserving new ones',
    );
    it.todo(
      'refuses when a pending order already exists, and says when it expires',
    );
    it.todo(
      'runs every precondition, the reservation and the insert in one serializable transaction',
    );
    it.todo(
      'reserves each line by incrementing the SKU rather than writing a total',
    );
    it.todo('re-reads availability inside the transaction, not from the cart');
    it.todo('refuses a line whose product was withdrawn or soft-deleted');
    it.todo('refuses a line that no longer fits in the available stock');
    it.todo('freezes productName and unitPrice on the order line');
    it.todo('totals the order from the prices it froze');
    it.todo(
      'spends the cart with its ACTIVE status as a precondition, not only in the data',
    );
    it.todo('clears the mirror column so the client can start another cart');
    it.todo('refuses when a concurrent request already spent the cart');
    it.todo('writes the first status history row at sequence 0');
    it.todo('gives the order an expiry');
  });

  describe('list', () => {
    it.todo('folds the ability scope into the where');
    it.todo('filters by status');
    it.todo('filters by the placement date range');
    it.todo('filters by the total range');
    it.todo('combines the three filters');
    it.todo('counts with the same where as the page it describes');
    it.todo('orders by placement date and breaks ties by id');
    it.todo('passes limit and offset through to take and skip');
  });

  describe('getOne', () => {
    it.todo('resolves the row with the scope inside the where');
    it.todo("answers 404 and not 403 for another client's order");
  });

  describe('updateStatus', () => {
    it.todo('answers 403 when the role can never reach that destination');
    it.todo('answers 409 when the role cannot reach it from this status');
    it.todo(
      'writes the new status with the judged status as a precondition in the where',
    );
    it.todo(
      'answers 409 when the order moved between the read and the write, and changes nothing',
    );
    it.todo('appends the history row after the status is written');
    it.todo('numbers the history row after the ones already written');
    it.todo('clears the expiry once the order stops being PENDING');
    it.todo('gives the reserved units back when the order is cancelled');
    it.todo('leaves the reservations alone on any other move');
    it.todo('resolves the order with the scope, so a stranger gets 404');
  });

  describe('without the Order rules in the ability', () => {
    it.todo('scopes every query to a where that matches nothing');
  });

  void client;
  void manager;
  void aCart;
  void aCartItem;
  void anOrder;
  void anOrderItem;
  void aProduct;
  void aSku;
  void OrderStatus;
  void Problems;
});
