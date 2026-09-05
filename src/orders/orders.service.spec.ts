import { CartStatus, OrderStatus, UserRole } from '@prisma/client';

/* Jest's asymmetric matchers are typed as `any`; the assertions below are
 * deliberately partial Prisma-call checks, not values passed to production. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

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
    const address = {
      recipientName: 'Ada Lovelace',
      line1: '1 Analytical Street',
      city: 'London',
      postalCode: 'E1 6AN',
    };

    function arrangeCheckout(
      options: {
        cart?: ReturnType<typeof aCart> & { items: unknown[] };
        sku?: ReturnType<typeof aSku> & {
          product: ReturnType<typeof aProduct>;
        };
        pending?: ReturnType<typeof anOrder> & {
          items: ReturnType<typeof anOrderItem>[];
        };
      } = {},
    ) {
      const product = aProduct({ name: 'Fresh tee' });
      const sku = options.sku ?? {
        ...aSku(product.id, { price: 1250 }),
        product,
      };
      const cart = options.cart ?? {
        ...aCart(client.id),
        items: [{ ...aCartItem('cart-1', sku.id, { quantity: 2 }), sku }],
      };
      const result = {
        ...anOrder(client.id),
        items: [],
        payments: [],
      };

      h.prisma.order.findFirst.mockResolvedValueOnce(options.pending ?? null);
      h.prisma.order.findFirst.mockResolvedValue(result);
      h.prisma.cart.findFirst.mockResolvedValue(cart);
      h.prisma.sku.findUnique.mockResolvedValue(sku);
      h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      h.prisma.cart.updateMany.mockResolvedValue({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(0);
      return { cart, product, result, sku };
    }

    it('refuses a caller with no active cart', async () => {
      h.prisma.order.findFirst.mockResolvedValue(null);
      h.prisma.cart.findFirst.mockResolvedValue(null);

      await expect(
        h.service.checkout(client, {} as never),
      ).rejects.toMatchObject({
        kind: Problems.cartNotCheckoutable,
      });
    });

    it('refuses an active cart with no lines', async () => {
      h.prisma.order.findFirst.mockResolvedValue(null);
      h.prisma.cart.findFirst.mockResolvedValue({
        ...aCart(client.id),
        items: [],
      } as never);

      await expect(
        h.service.checkout(client, {} as never),
      ).rejects.toMatchObject({
        kind: Problems.cartNotCheckoutable,
      });
    });
    it('settles a pending order that already lapsed, giving its units back before reserving new ones', async () => {
      const oldSku = aSku(aProduct().id);
      const pending = {
        ...anOrder(client.id, {
          expiresAt: new Date(Date.now() - 1),
          status: OrderStatus.PENDING,
        }),
        items: [anOrderItem('old-order', oldSku.id, { quantity: 3 })],
      };
      const { sku } = arrangeCheckout({ pending });

      await h.service.checkout(client, address);

      expect(h.prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: pending.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED, expiresAt: null },
      });
      expect(h.prisma.sku.update.mock.calls).toEqual(
        expect.arrayContaining([
          [{ where: { id: oldSku.id }, data: { reserved: { decrement: 3 } } }],
          [{ where: { id: sku.id }, data: { reserved: { increment: 2 } } }],
        ]),
      );
    });

    it('refuses when a pending order already exists, and says when it expires', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      arrangeCheckout({
        pending: { ...anOrder(client.id, { expiresAt }), items: [] },
      });

      await expect(h.service.checkout(client, address)).rejects.toMatchObject({
        kind: Problems.orderAlreadyPending,
        extensions: { expiresAt: expiresAt.toISOString() },
      });
    });

    it('runs every precondition, the reservation and the insert in one serializable transaction', async () => {
      arrangeCheckout();
      await h.service.checkout(client, address);
      expect(h.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: 'Serializable' }),
      );
    });

    it('reserves each line by incrementing the SKU rather than writing a total', async () => {
      const { sku } = arrangeCheckout();
      await h.service.checkout(client, address);
      expect(h.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: sku.id },
        data: { reserved: { increment: 2 } },
      });
    });

    it('re-reads availability inside the transaction, not from the cart', async () => {
      const product = aProduct();
      const staleSku = { ...aSku(product.id, { stock: 100 }), product };
      const freshSku = {
        ...aSku(product.id, { id: staleSku.id, stock: 2 }),
        product,
      };
      const cart = {
        ...aCart(client.id),
        items: [
          {
            ...aCartItem('cart-1', staleSku.id, { quantity: 3 }),
            sku: staleSku,
          },
        ],
      };
      arrangeCheckout({ cart, sku: freshSku });
      await expect(h.service.checkout(client, address)).rejects.toMatchObject({
        kind: Problems.stockUnavailable,
      });
      expect(h.prisma.sku.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: staleSku.id } }),
      );
    });

    it('refuses a line whose product was withdrawn or soft-deleted', async () => {
      const product = aProduct({ deletedAt: new Date() });
      arrangeCheckout({ sku: { ...aSku(product.id), product } });
      await expect(h.service.checkout(client, address)).rejects.toMatchObject({
        kind: Problems.itemWithdrawn,
      });
    });

    it('refuses a line that no longer fits in the available stock', async () => {
      const product = aProduct();
      arrangeCheckout({
        sku: { ...aSku(product.id, { stock: 2, reserved: 1 }), product },
      });
      await expect(h.service.checkout(client, address)).rejects.toMatchObject({
        kind: Problems.stockUnavailable,
      });
    });

    it('freezes productName and unitPrice on the order line', async () => {
      const { product, sku } = arrangeCheckout();
      await h.service.checkout(client, address);
      const data = h.prisma.order.create.mock.calls[0][0].data as never as {
        items: { create: unknown[] };
      };
      expect(data.items.create).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productName: product.name,
            unitPrice: sku.price,
          }),
        ]),
      );
    });

    it('totals the order from the prices it froze', async () => {
      const { sku } = arrangeCheckout();
      await h.service.checkout(client, address);
      expect(h.prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotal: sku.price * 2,
            total: sku.price * 2,
          }),
        }),
      );
    });

    it('spends the cart with its ACTIVE status as a precondition, not only in the data', async () => {
      const { cart } = arrangeCheckout();
      await h.service.checkout(client, address);
      expect(h.prisma.cart.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: cart.id, status: CartStatus.ACTIVE },
        }),
      );
    });

    it('clears the mirror column so the client can start another cart', async () => {
      arrangeCheckout();
      await h.service.checkout(client, address);
      expect(h.prisma.cart.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: CartStatus.CHECKED_OUT, activeUserId: null },
        }),
      );
    });

    it('refuses when a concurrent request already spent the cart', async () => {
      arrangeCheckout();
      h.prisma.cart.updateMany.mockResolvedValue({ count: 0 });
      await expect(h.service.checkout(client, address)).rejects.toMatchObject({
        kind: Problems.cartNotCheckoutable,
      });
    });

    it('writes the first status history row at sequence 0', async () => {
      arrangeCheckout();
      await h.service.checkout(client, address);
      expect(h.prisma.orderStatusHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderStatus.PENDING,
            sequence: 0,
          }),
        }),
      );
    });

    it('gives the order an expiry', async () => {
      const before = Date.now();
      arrangeCheckout();
      await h.service.checkout(client, address);
      const data = h.prisma.order.create.mock.calls[0][0].data as never as {
        expiresAt: Date;
      };
      expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 1_799_000,
      );
      expect(data.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 1_801_000,
      );
    });

    it('treats a pending order with no expiry as live: refuses it without cancelling or releasing anything', async () => {
      const pending = {
        ...anOrder(client.id, { expiresAt: null }),
        items: [anOrderItem('old-order', 'old-sku', { quantity: 3 })],
      };
      arrangeCheckout({ pending });

      await expect(h.service.checkout(client, address)).rejects.toMatchObject({
        kind: Problems.orderAlreadyPending,
        extensions: { expiresAt: null },
      });
      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      // The history too, and not only the row and the stock: a regression
      // that returned after recording a CANCELLED entry would leave the
      // order untouched and still lie about what happened to it.
      expect(h.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('folds the ability scope into the where', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);

      await h.service.list(client, { limit: 2, offset: 0 });

      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([{ OR: [{ userId: client.id }] }]),
          }),
        }),
      );
    });

    it('filters by status', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);

      await h.service.list(client, {
        limit: 2,
        offset: 0,
        status: OrderStatus.SHIPPED,
      });

      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([{ status: OrderStatus.SHIPPED }]),
          }),
        }),
      );
    });
    it('filters by the placement date range', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(client, {
        limit: 2,
        offset: 0,
        placedFrom: '2026-01-01T00:00:00.000Z',
        placedTo: '2026-01-31T00:00:00.000Z',
      });
      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                createdAt: {
                  gte: new Date('2026-01-01T00:00:00.000Z'),
                  lte: new Date('2026-01-31T00:00:00.000Z'),
                },
              },
            ]),
          }),
        }),
      );
    });
    it('filters by the total range', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(client, {
        limit: 2,
        offset: 0,
        minTotal: 100,
        maxTotal: 200,
      });
      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([{ total: { gte: 100, lte: 200 } }]),
          }),
        }),
      );
    });
    it('combines the three filters', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(client, {
        limit: 2,
        offset: 0,
        status: OrderStatus.PAID,
        minTotal: 100,
      });
      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { status: OrderStatus.PAID, total: { gte: 100 } },
            ]),
          }),
        }),
      );
    });
    it('counts with the same where as the page it describes', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(client, { limit: 2, offset: 0 });
      expect(h.prisma.order.count).toHaveBeenCalledWith({
        where: (h.prisma.order.findMany.mock.calls[0][0] as { where: unknown })
          .where,
      });
    });
    it('orders by placement date and breaks ties by id', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(client, { limit: 2, offset: 0 });
      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });
    it('passes limit and offset through to take and skip', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(client, { limit: 3, offset: 6 });
      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3, skip: 6 }),
      );
    });
  });

  describe('getOne', () => {
    it('resolves the row with the scope inside the where', async () => {
      const order = { ...anOrder(client.id), items: [], payments: [] };
      h.prisma.order.findFirst.mockResolvedValue(order);

      await h.service.getOne(client, order.id);

      expect(h.prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ OR: [{ userId: client.id }] }, { id: order.id }],
          },
        }),
      );
    });

    it("answers 404 and not 403 for another client's order", async () => {
      h.prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        h.service.getOne(client, 'another-order'),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
      });
    });
  });

  describe('updateStatus', () => {
    function arrangeStatusChange(
      status: OrderStatus = OrderStatus.PENDING,
      items = [anOrderItem('order-1', 'sku-1', { quantity: 2 })],
    ) {
      const order = { ...anOrder(client.id, { status }), items, payments: [] };
      h.prisma.order.findFirst.mockResolvedValue(order);
      h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      h.prisma.orderStatusHistory.count.mockResolvedValue(0);
      return order;
    }

    it('answers 403 when the role can never reach that destination', async () => {
      const order = arrangeStatusChange(OrderStatus.PENDING);
      await expect(
        h.service.updateStatus(manager, order.id, OrderStatus.CANCELLED),
      ).rejects.toMatchObject({ kind: Problems.forbidden });
    });

    it('answers 409 when the role cannot reach it from this status', async () => {
      const order = arrangeStatusChange(OrderStatus.PAID);
      await expect(
        h.service.updateStatus(client, order.id, OrderStatus.CANCELLED),
      ).rejects.toMatchObject({ kind: Problems.conflict });
    });

    it('writes the new status with the judged status as a precondition in the where', async () => {
      const order = arrangeStatusChange();
      await h.service.updateStatus(client, order.id, OrderStatus.CANCELLED);
      expect(h.prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED, expiresAt: null },
      });
    });

    it('answers 409 when the order moved between the read and the write, and changes nothing', async () => {
      const order = arrangeStatusChange();
      h.prisma.order.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        h.service.updateStatus(client, order.id, OrderStatus.CANCELLED),
      ).rejects.toMatchObject({ kind: Problems.conflict });
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      expect(h.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('appends the history row after the status is written', async () => {
      const order = arrangeStatusChange();
      await h.service.updateStatus(client, order.id, OrderStatus.CANCELLED);
      expect(
        h.prisma.order.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        h.prisma.orderStatusHistory.create.mock.invocationCallOrder[0],
      );
    });

    it('numbers the history row after the ones already written', async () => {
      const order = arrangeStatusChange();
      h.prisma.orderStatusHistory.count.mockResolvedValue(4);
      await h.service.updateStatus(client, order.id, OrderStatus.CANCELLED);
      expect(h.prisma.orderStatusHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sequence: 4 }),
        }),
      );
    });

    it('clears the expiry once the order stops being PENDING', async () => {
      const order = arrangeStatusChange();
      await h.service.updateStatus(client, order.id, OrderStatus.CANCELLED);
      expect(h.prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ expiresAt: null }),
        }),
      );
    });

    it('gives the reserved units back when the order is cancelled', async () => {
      const order = arrangeStatusChange();
      await h.service.updateStatus(client, order.id, OrderStatus.CANCELLED);
      expect(h.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: order.items[0].skuId },
        data: { reserved: { decrement: order.items[0].quantity } },
      });
    });

    it('leaves the reservations alone on any other move', async () => {
      const order = arrangeStatusChange(OrderStatus.PAID);
      await h.service.updateStatus(manager, order.id, OrderStatus.PROCESSING);
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('resolves the order with the scope, so a stranger gets 404', async () => {
      h.prisma.order.findFirst.mockResolvedValue(null);
      await expect(
        h.service.updateStatus(client, 'another-order', OrderStatus.CANCELLED),
      ).rejects.toMatchObject({ kind: Problems.notFound });
      expect(h.prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ OR: [{ userId: client.id }] }, { id: 'another-order' }],
          },
        }),
      );
    });

    it('records the courier and the moment on a delivery, so the ability keeps letting them read it', async () => {
      const delivery: AuthenticatedUser = {
        id: 'delivery-1',
        email: 'delivery@example.test',
        role: UserRole.DELIVERY,
      };
      const order = arrangeStatusChange(OrderStatus.SHIPPED);

      await h.service.updateStatus(delivery, order.id, OrderStatus.DELIVERED);

      expect(h.prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderStatus.DELIVERED,
            deliveredById: delivery.id,
            deliveredAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  describe('without the Order rules in the ability', () => {
    it('scopes every query to a where that matches nothing', async () => {
      h.prisma.order.findMany.mockResolvedValue([]);
      h.prisma.order.count.mockResolvedValue(0);
      await h.service.list(undefined as never, { limit: 2, offset: 0 });
      expect(h.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{ OR: [] }, {}] } }),
      );
    });
  });

  describe('the payment intent checkout creates', () => {
    /**
     * Stripe is called after the transaction commits, which is what makes
     * these cases worth having. The reservation is already durable when the
     * intent is asked for, so the order can outlive a failed call — and the
     * intent can outlive a failed row. Both directions are named below.
     */
    it.todo(
      'creates the intent only after the reservation transaction has committed',
    );

    it.todo('asks Stripe for the order total, in cents, with nothing rounded');

    it.todo('records the attempt as a PENDING payment carrying the intent id');

    it.todo(
      'records the method as PAYMENT_INTENT, so the order view stops reading null',
    );

    it.todo('returns the client secret alongside the order');

    it.todo(
      'leaves the order PENDING when Stripe refuses, so the sweep can reclaim it',
    );

    it.todo(
      'writes no payment row when Stripe refuses, because there is no intent to record',
    );
  });
});
