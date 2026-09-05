import { OrderStatus, Payment } from '@prisma/client';

/* Jest's asymmetric matchers are typed as `any`; these are partial checks of
 * Prisma calls and are never values passed to production code. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { buildService, type ServiceHarness } from '../testing/build-service';
import { anOrder, anOrderItem } from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { OrdersSweepService, SWEEP_BATCH_SIZE } from './orders-sweep.service';
import { deferred, flushMicrotasks } from '../testing/deferred';

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
    const now = new Date('2026-09-04T12:00:00.000Z');

    it('takes only PENDING orders whose expiry has passed', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);

      await h.service.sweep(now);

      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: OrderStatus.PENDING,
            expiresAt: { not: null, lte: now },
          },
        }),
      );
    });

    it('ignores a PENDING order carrying no expiry at all', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);

      await h.service.sweep(now);

      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: { not: null, lte: now },
          }),
        }),
      );
    });

    it('takes the oldest first, so a backlog drains in order', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);

      await h.service.sweep(now);

      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { expiresAt: 'asc' } }),
      );
    });

    it(`stops at ${SWEEP_BATCH_SIZE} orders in one run`, async () => {
      h.prisma.order.findMany.mockResolvedValue([]);

      await h.service.sweep(now);

      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: SWEEP_BATCH_SIZE }),
      );
    });
  });

  describe('what it writes', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');

    function expiredOrder(
      id: string,
      items = [anOrderItem(`${id}-item`, `${id}-sku`, { quantity: 3 })],
    ) {
      return {
        ...anOrder('user-1', {
          id,
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items,
      };
    }

    function arrangeSweep(orders: ReturnType<typeof expiredOrder>[]) {
      h.prisma.order.findMany.mockResolvedValue(orders);
      h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(4);
      return orders;
    }

    it('cancels each order in its own transaction, not one for the batch', async () => {
      const orders = arrangeSweep([
        expiredOrder('order-1'),
        expiredOrder('order-2'),
      ]);

      await h.service.sweep(now);

      expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(h.prisma.order.updateMany).toHaveBeenCalledTimes(2);
      expect(h.prisma.order.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: orders[0].id,
          status: OrderStatus.PENDING,
          expiresAt: { lte: now },
        },
        data: { status: OrderStatus.CANCELLED, expiresAt: null },
      });
    });

    it('runs each of those transactions at the serializable level', async () => {
      arrangeSweep([expiredOrder('order-1'), expiredOrder('order-2')]);

      await h.service.sweep(now);

      expect(h.prisma.$transaction).toHaveBeenNthCalledWith(
        1,
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
      expect(h.prisma.$transaction).toHaveBeenNthCalledWith(
        2,
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    it('repeats status and expiry as preconditions on the update', async () => {
      const [order] = arrangeSweep([expiredOrder('order-1')]);

      await h.service.sweep(now);

      expect(h.prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: order.id,
          status: OrderStatus.PENDING,
          expiresAt: { lte: now },
        },
        data: expect.any(Object),
      });
    });

    it('gives the units of a cancelled order back to the shelf', async () => {
      const items = [
        anOrderItem('order-1', 'sku-1', { quantity: 3 }),
        anOrderItem('order-1', 'sku-2', { quantity: 2 }),
      ];
      arrangeSweep([expiredOrder('order-1', items)]);

      await h.service.sweep(now);

      expect(h.prisma.sku.update).toHaveBeenCalledTimes(items.length);
      expect(h.prisma.sku.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'sku-1' },
        data: { reserved: { decrement: 3 } },
      });
      expect(h.prisma.sku.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'sku-2' },
        data: { reserved: { decrement: 2 } },
      });
    });

    it('appends a CANCELLED row to the order history', async () => {
      const [order] = arrangeSweep([expiredOrder('order-1')]);

      await h.service.sweep(now);

      expect(h.prisma.orderStatusHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: order.id,
            status: OrderStatus.CANCELLED,
            sequence: 4,
          }),
        }),
      );
    });

    it('clears the expiry it acted on', async () => {
      arrangeSweep([expiredOrder('order-1')]);

      await h.service.sweep(now);

      expect(h.prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: OrderStatus.CANCELLED, expiresAt: null },
        }),
      );
    });
  });

  describe('when it loses the race', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');

    it('releases nothing when the update moved no row', async () => {
      h.prisma.order.findMany.mockResolvedValue([
        {
          ...anOrder('user-1', {
            id: 'order-1',
            status: OrderStatus.PENDING,
            expiresAt: new Date('2026-09-04T11:00:00.000Z'),
          }),
          items: [anOrderItem('order-1', 'sku-1', { quantity: 3 })],
        },
      ] as never);
      h.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await h.service.sweep(now);

      expect(h.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('writes no history when the update moved no row', async () => {
      h.prisma.order.findMany.mockResolvedValue([
        {
          ...anOrder('user-1', {
            id: 'order-1',
            status: OrderStatus.PENDING,
            expiresAt: new Date('2026-09-04T11:00:00.000Z'),
          }),
          items: [anOrderItem('order-1', 'sku-1', { quantity: 3 })],
        },
      ] as never);
      h.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await h.service.sweep(now);

      expect(h.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('keeps settling the rest of the batch after losing one', async () => {
      const first = {
        ...anOrder('user-1', {
          id: 'order-1',
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [anOrderItem('order-1', 'sku-1', { quantity: 3 })],
      };
      const second = {
        ...anOrder('user-1', {
          id: 'order-2',
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [anOrderItem('order-2', 'sku-2', { quantity: 2 })],
      };
      h.prisma.order.findMany.mockResolvedValue([first, second] as never);
      h.prisma.order.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(0);

      await h.service.sweep(now);

      expect(h.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: 'sku-2' },
        data: { reserved: { decrement: 2 } },
      });
    });

    it('reports how many it examined and how many it actually cancelled', async () => {
      const first = {
        ...anOrder('user-1', {
          id: 'order-1',
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [],
      };
      const second = {
        ...anOrder('user-1', {
          id: 'order-2',
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [],
      };
      h.prisma.order.findMany.mockResolvedValue([first, second] as never);
      h.prisma.order.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(0);

      await expect(h.service.sweep(now)).resolves.toEqual({
        examined: 2,
        cancelled: 1,
        // Losing the precondition is not a failure: the row moved, just not
        // by us. Only a rejected transaction counts here.
        failed: 0,
      });
    });

    /**
     * The branch the review found missing: a rejected transaction, which is
     * what `Serializable` does to the loser of a genuine conflict. The sweep
     * runs once with no retries because the next minute's run is the retry —
     * and that only holds if one rejection costs one order rather than the
     * rest of the batch behind it.
     */
    function arrangeRejectedTransaction() {
      const first = {
        ...anOrder('user-1', {
          id: 'order-1',
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [anOrderItem('order-1', 'sku-1', { quantity: 3 })],
      };
      const second = {
        ...anOrder('user-1', {
          id: 'order-2',
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [anOrderItem('order-2', 'sku-2', { quantity: 2 })],
      };
      h.prisma.order.findMany.mockResolvedValue([first, second] as never);
      h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(0);
      h.prisma.$transaction.mockRejectedValueOnce(
        new Error('serialization conflict'),
      );
      return { first, second };
    }

    it('carries on with the batch when one order transaction is rejected', async () => {
      const { second } = arrangeRejectedTransaction();

      await h.service.sweep(now);

      expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(h.prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: second.id }),
        }),
      );
      expect(h.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: 'sku-2' },
        data: { reserved: { decrement: 2 } },
      });
    });

    it('counts a rejected transaction as failed, not as cancelled', async () => {
      arrangeRejectedTransaction();

      await expect(h.service.sweep(now)).resolves.toEqual({
        examined: 2,
        cancelled: 1,
        failed: 1,
      });
    });
  });

  describe('cancelling the payment before releasing the stock', () => {
    /**
     * The ordering is the whole point, and only these cases hold it in
     * place. Released first, a payment confirming inside the window leaves a
     * charged order whose units have already been sold to someone else.
     */
    const now = new Date('2026-09-04T12:00:00.000Z');

    function arrangePaymentSweep() {
      const order = {
        ...anOrder('user-1', {
          id: 'order-payment',
          total: 4_599,
          status: OrderStatus.PENDING,
          expiresAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
        items: [anOrderItem('order-payment', 'sku-payment', { quantity: 2 })],
      };
      h.prisma.order.findMany.mockResolvedValue([order] as never);
      h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(0);
      h.prisma.payment.findFirst.mockResolvedValue(null);
      return order;
    }

    it('cancels the intent before it releases a single reservation', async () => {
      arrangePaymentSweep();

      // The cancellation is held unresolved, and the question is whether a
      // single unit goes back on the shelf while it hangs. Comparing
      // invocation order would not answer it: that records when each call
      // *started*, so a release fired without waiting for the cancellation
      // to come back would still look correctly ordered — which is the
      // arrangement that lets a late payment land on units already resold.
      const cancellation = deferred<boolean>();
      h.stripe.cancelPaymentIntent.mockReturnValueOnce(cancellation.promise);

      const sweeping = h.service.sweep(now);
      await flushMicrotasks();

      expect(h.prisma.sku.update).not.toHaveBeenCalled();

      cancellation.resolve(true);
      await sweeping;

      expect(h.prisma.sku.update).toHaveBeenCalled();
    });

    it('leaves the order PENDING and its stock reserved when the intent will not cancel', async () => {
      arrangePaymentSweep();
      h.stripe.cancelPaymentIntent.mockResolvedValueOnce(false);

      await h.service.sweep(now);

      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('counts an order it could not stop as failed rather than as cancelled', async () => {
      arrangePaymentSweep();
      h.stripe.cancelPaymentIntent.mockResolvedValueOnce(false);

      await expect(h.service.sweep(now)).resolves.toEqual({
        examined: 1,
        cancelled: 0,
        failed: 1,
      });
    });

    it('reaches for the intent by the order id when no payment row recorded one', async () => {
      const order = arrangePaymentSweep();

      await h.service.sweep(now);

      expect(h.prisma.payment.findFirst).toHaveBeenCalledWith({
        where: { orderId: order.id, stripePaymentIntentId: { not: null } },
        select: { stripePaymentIntentId: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(h.stripe.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ id: order.id, total: order.total }),
      );
      expect(h.stripe.cancelPaymentIntent).toHaveBeenCalledWith(
        `pi_for_${order.id}`,
      );
    });

    it('cancels the intent recorded on the newest payment row when there is one', async () => {
      arrangePaymentSweep();
      // The service selects one column, so only that column is stood up;
      // the cast says the partial row is deliberate rather than forgotten.
      h.prisma.payment.findFirst.mockResolvedValueOnce({
        stripePaymentIntentId: 'pi_recorded',
      } as Payment);

      await h.service.sweep(now);

      expect(h.stripe.createPaymentIntent).not.toHaveBeenCalled();
      expect(h.stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_recorded');
    });
  });
});
