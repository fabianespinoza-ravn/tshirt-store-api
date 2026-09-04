import { OrderStatus } from '@prisma/client';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { anOrder, anOrderItem } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { OrdersSweepService, SWEEP_BATCH_SIZE } from './orders-sweep.service';

/**
 * Two cases here decide whether the sweep is safe, and both are about what
 * it refuses to do.
 *
 * The first is the precondition on the write. `OrdersService.settlePendingOrder`
 * cancels the same rows from the other direction, so the two race by design;
 * what keeps that safe is that each only releases stock when its own update
 * moved the row. A sweep that released unconditionally would hand the same
 * units back twice and the store would invent stock — and no test that only
 * looked at the happy path would notice.
 *
 * The second is the transaction boundary. One transaction per order, not one
 * for the batch: assert how `$transaction` was called and how often, because
 * a version that wrapped the loop instead would pass every assertion about
 * the resulting rows while conflicting with every concurrent checkout and
 * losing whole runs to one collision.
 */
describe('OrdersSweepService', () => {
  let h: ServiceHarness<OrdersSweepService>;

  beforeEach(async () => {
    h = await buildService(OrdersSweepService);
    resetPrismaMock(h.prisma);
  });

  describe('what it selects', () => {
    it.todo('takes only PENDING orders whose expiry has passed');
    it.todo('ignores a PENDING order carrying no expiry at all');
    it.todo('takes the oldest first, so a backlog drains in order');
    it.todo(`stops at ${SWEEP_BATCH_SIZE} orders in one run`);
  });

  describe('what it writes', () => {
    it.todo('cancels each order in its own transaction, not one for the batch');
    it.todo('runs each of those transactions at the serializable level');
    it.todo('repeats status and expiry as preconditions on the update');
    it.todo('gives the units of a cancelled order back to the shelf');
    it.todo('appends a CANCELLED row to the order history');
    it.todo('clears the expiry it acted on');
  });

  describe('when it loses the race', () => {
    it.todo('releases nothing when the update moved no row');
    it.todo('writes no history when the update moved no row');
    it.todo('keeps settling the rest of the batch after losing one');
    it.todo('reports how many it examined and how many it actually cancelled');
  });

  void anOrder;
  void anOrderItem;
  void OrderStatus;
});
