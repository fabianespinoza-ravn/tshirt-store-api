import { OrderStatus } from '@prisma/client';
import { Problems } from '../src/common/problem/problem.catalog';
import type { Paginated } from '../src/common/pagination';
import type { OrderView } from '../src/orders/orders.views';
import { createE2eApp, type E2eApp } from './support/app';
import { MALFORMED_ACCESS_TOKEN, expiredAccessToken } from './support/fixtures';
import {
  arrangeOrderHistory,
  HISTORY_DATES,
  MALFORMED_ORDER_ID,
  ORDERS_ROUTE,
  repriceAndRename,
  SEEDED_ADDRESS,
  UNKNOWN_ORDER_ID,
} from './support/order-fixtures';

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function ids(body: { data: { id: string }[] }): string[] {
  return body.data.map((order) => order.id);
}

/**
 * Supertest types `body` as `any`, so every read of it trips the
 * unsafe-member-access rule and, worse, would let a renamed field pass
 * unnoticed. These two name the shape once, from the application's own view
 * types rather than a copy of them: a change to `OrderView` breaks the suite
 * at compile time, which is where it should break.
 */
const listOf = (response: { body: unknown }): Paginated<OrderView> =>
  response.body as Paginated<OrderView>;

const orderOf = (response: { body: unknown }): OrderView =>
  response.body as OrderView;

function expectValidation(response: { status: number; body: unknown }): void {
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ type: Problems.validation.type });
}

/**
 * The second of the three end-to-end flows the program mandates, after
 * authentication and alongside checkout: order history. Real HTTP requests
 * against the real application over the e2e database, reading
 * `GET /api/v1/orders` and `GET /api/v1/orders/{orderId}`.
 *
 * WHAT IS HERE AND WHAT IS NOT. This file is the harness and the contract
 * assertions for order history. The fixtures each case needs already exist
 * and run — see `test/support/order-fixtures.ts` — and every case states the
 * exact subset, the exact totals in integer cents and the exact statuses the
 * answer is supposed to contain.
 *
 * Each case starts from one line:
 *
 *   const scene = await arrangeOrderHistory(e2e);
 *
 * from `./support/order-fixtures`, which signs in three sessions and seeds six
 * orders:
 *
 *   scene.owner      a CLIENT with five orders, one per status the flow needs
 *   scene.stranger   another CLIENT with one order, PAID, total 12 500
 *   scene.manager    a MANAGER, who by the matrix sees all six
 *   scene.history    the owner's five, named and newest first:
 *
 *     status      placed       lines                total (cents)
 *     PENDING     2025-05-30   5 x cap                    7 500
 *     PAID        2025-04-05   2 x hoodie                25 000
 *     SHIPPED     2025-03-15   2 x tee + 3 x cap         12 500
 *     DELIVERED   2025-02-20   1 x tee                    4 000
 *     CANCELLED   2025-01-10   1 x cap                    1 500
 *
 * The request itself is `e2e.request().get(ORDERS_ROUTE).set('Authorization',
 * `Bearer ${scene.owner.accessToken}`).query({ ... })`, with `ORDERS_ROUTE`
 * exported from the same fixtures module.
 *
 * ONE THING TO WATCH WHEN ASSERTING ON `items`. `ORDER_INCLUDE` in
 * `src/orders/orders.views.ts` includes the lines with no `orderBy`, so
 * Postgres returns them in whatever order it likes and the array's order is
 * not part of the contract. The two-line case below is the only one affected;
 * assert on it with a set-like matcher (`expect.arrayContaining`, or sort by
 * `productName` first) rather than on positions.
 *
 * Checkout is deliberately absent. It is the third mandated flow and it has
 * its own suite; the seeding here writes order rows directly, which is the
 * only way to produce five different placement dates, and
 * `test/support/order-fixtures.ts` is shared so that suite can reuse `seedSku`
 * and `seedOrder` when it lands.
 */
describe('Order history (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    // Optional on purpose: if createE2eApp threw, there is nothing to close
    // and the real error must be the one that surfaces.
    await e2e?.close();
  });

  beforeEach(async () => {
    await e2e.reset();
  });

  describe('GET /orders: the three filters the challenge mandates', () => {
    it("with no filters, returns the caller's five seeded orders newest first with the contract defaults", async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken));

      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual(scene.history.all.map((o) => o.id));
      expect(listOf(response).meta).toEqual({ limit: 20, offset: 0, total: 5 });
    });

    it('filters by an inclusive date range', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({
          placedFrom: '2025-02-01T00:00:00.000Z',
          placedTo: '2025-04-30T23:59:59.999Z',
        });

      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([
        scene.history.paid.id,
        scene.history.shipped.id,
        scene.history.delivered.id,
      ]);
      expect(listOf(response).meta.total).toBe(3);
    });

    it('includes an order exactly on both date bounds', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const date = HISTORY_DATES.delivered.toISOString();
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ placedFrom: date, placedTo: date });

      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([scene.history.delivered.id]);
      expect(listOf(response).meta.total).toBe(1);
    });

    it('supports an open upper date bound', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ placedFrom: '2025-04-01T00:00:00.000Z' });

      expect(ids(listOf(response))).toEqual([
        scene.history.pending.id,
        scene.history.paid.id,
      ]);
      expect(response.status).toBe(200);
      expect(listOf(response).meta.total).toBe(2);
    });

    it('supports an open lower date bound', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ placedTo: '2025-02-28T23:59:59.999Z' });

      expect(ids(listOf(response))).toEqual([
        scene.history.delivered.id,
        scene.history.cancelled.id,
      ]);
      expect(response.status).toBe(200);
      expect(listOf(response).meta.total).toBe(2);
    });

    it('filters by order status', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ status: OrderStatus.SHIPPED });

      expect(ids(listOf(response))).toEqual([scene.history.shipped.id]);
      expect(listOf(response).meta.total).toBe(1);
    });

    it('returns no rows for a status with no match', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ status: OrderStatus.FAILED });

      expect(response.status).toBe(200);
      expect(listOf(response).data).toEqual([]);
      expect(listOf(response).meta.total).toBe(0);
    });

    it('filters by an inclusive price range', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ minTotal: 4000, maxTotal: 12500 });

      expect(ids(listOf(response))).toEqual([
        scene.history.pending.id,
        scene.history.shipped.id,
        scene.history.delivered.id,
      ]);
      expect(response.status).toBe(200);
      expect(listOf(response).meta.total).toBe(3);
    });

    it('supports an open upper price bound', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ minTotal: 12500 });

      expect(ids(listOf(response))).toEqual([
        scene.history.paid.id,
        scene.history.shipped.id,
      ]);
      expect(response.status).toBe(200);
      expect(listOf(response).meta.total).toBe(2);
    });

    it('supports an open lower price bound', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ maxTotal: 4000 });

      expect(ids(listOf(response))).toEqual([
        scene.history.delivered.id,
        scene.history.cancelled.id,
      ]);
      expect(response.status).toBe(200);
      expect(listOf(response).meta.total).toBe(2);
    });

    it('combines the three filters with AND', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({
          status: OrderStatus.SHIPPED,
          placedFrom: '2025-02-01T00:00:00.000Z',
          placedTo: '2025-04-30T23:59:59.999Z',
          minTotal: 4000,
          maxTotal: 12500,
        });

      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([scene.history.shipped.id]);
      expect(listOf(response).meta.total).toBe(1);
    });

    it('does not combine filters with OR', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ status: OrderStatus.PAID, maxTotal: 12500 });

      expect(listOf(response).data).toEqual([]);
      expect(listOf(response).meta.total).toBe(0);
    });

    it('rejects an unknown status', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ status: 'NOT_A_STATUS' });
      expectValidation(response);
    });

    it('rejects a non-integer price bound', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ minTotal: '125.5' });
      expectValidation(response);
    });

    it('rejects a negative price bound', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ minTotal: -1 });
      expectValidation(response);
    });

    it('rejects a non-ISO date', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ placedFrom: 'yesterday' });
      expectValidation(response);
    });
  });

  describe('GET /orders: pagination', () => {
    it('returns the first page', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ limit: 2, offset: 0 });
      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([
        scene.history.pending.id,
        scene.history.paid.id,
      ]);
      expect(listOf(response).meta).toEqual({ limit: 2, offset: 0, total: 5 });
    });

    it('returns the middle page', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ limit: 2, offset: 2 });
      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([
        scene.history.shipped.id,
        scene.history.delivered.id,
      ]);
      expect(listOf(response).meta).toEqual({ limit: 2, offset: 2, total: 5 });
    });

    it('returns the final partial page', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ limit: 2, offset: 4 });
      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([scene.history.cancelled.id]);
      expect(listOf(response).meta).toEqual({ limit: 2, offset: 4, total: 5 });
    });

    it('returns an empty page exactly one past the end', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ limit: 2, offset: 5 });
      expect(response.status).toBe(200);
      expect(listOf(response).data).toEqual([]);
      expect(listOf(response).meta).toEqual({ limit: 2, offset: 5, total: 5 });
    });

    it('returns an empty page far past the end with the same total', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ offset: 1000 });
      expect(response.status).toBe(200);
      expect(listOf(response).data).toEqual([]);
      expect(listOf(response).meta.total).toBe(5);
    });

    it('does not skip or repeat rows across pages', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const pages = await Promise.all(
        [0, 2, 4].map((offset) =>
          e2e
            .request()
            .get(ORDERS_ROUTE)
            .set('Authorization', bearer(scene.owner.accessToken))
            .query({ limit: 2, offset }),
        ),
      );
      expect(pages.flatMap((page) => ids(listOf(page)))).toEqual(
        scene.history.all.map((order) => order.id),
      );
    });

    it('counts the filtered set rather than the table', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ minTotal: 4000, maxTotal: 12500, limit: 1 });
      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual([scene.history.pending.id]);
      expect(listOf(response).meta).toEqual({ limit: 1, offset: 0, total: 3 });
    });

    it('rejects limit zero', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ limit: 0 });
      expectValidation(response);
    });

    it('rejects limit above the contract maximum', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ limit: 101 });
      expectValidation(response);
    });

    it('rejects a negative offset', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken))
        .query({ offset: -1 });
      expectValidation(response);
    });
  });

  describe('GET /orders/{orderId}: the detail payload', () => {
    it('returns the shipped detail with its frozen lines and totals', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.body).toMatchObject({
        status: OrderStatus.SHIPPED,
        subtotal: 12500,
        discount: 0,
        total: 12500,
        items: expect.arrayContaining([
          expect.objectContaining({
            productName: 'E2E Classic Tee',
            quantity: 2,
            unitPrice: 4000,
            lineTotal: 8000,
          }),
          expect.objectContaining({
            productName: 'E2E Cap',
            quantity: 3,
            unitPrice: 1500,
            lineTotal: 4500,
          }),
        ]) as OrderView['items'],
      });
    });

    it('returns each line with its source sku id', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(200);
      expect(orderOf(response).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ skuId: scene.history.skus.tee.id }),
          expect.objectContaining({ skuId: scene.history.skus.cap.id }),
        ]),
      );
    });

    it('reads line snapshots rather than the current catalogue', async () => {
      const scene = await arrangeOrderHistory(e2e);
      await repriceAndRename(e2e, scene.history.skus.tee, {
        productName: 'Renamed Tee',
        price: 9900,
      });
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(200);
      expect(orderOf(response).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productName: 'E2E Classic Tee',
            unitPrice: 4000,
            lineTotal: 8000,
          }),
        ]),
      );
      expect(orderOf(response).total).toBe(12500);
    });

    it('returns the seeded shipping address', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(200);
      expect(orderOf(response).shippingAddress).toEqual(SEEDED_ADDRESS);
    });

    it('serializes expiry for pending orders and null for shipped orders', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const [pending, shipped] = await Promise.all([
        e2e
          .request()
          .get(`${ORDERS_ROUTE}/${scene.history.pending.id}`)
          .set('Authorization', bearer(scene.owner.accessToken)),
        e2e
          .request()
          .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
          .set('Authorization', bearer(scene.owner.accessToken)),
      ]);
      expect(pending.status).toBe(200);
      expect(orderOf(pending).expiresAt).toEqual(expect.any(String));
      expect(() =>
        new Date(orderOf(pending).expiresAt ?? '').toISOString(),
      ).not.toThrow();
      expect(shipped.status).toBe(200);
      expect(orderOf(shipped).expiresAt).toBeNull();
    });

    it('declares an empty payment method when no payment row exists', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.paid.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.body).toHaveProperty('paymentMethod', null);
    });

    it('serializes the seeded creation date', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(200);
      expect(orderOf(response).createdAt).toBe(
        HISTORY_DATES.shipped.toISOString(),
      );
    });

    it('returns the same representation in list and detail', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const [list, detail] = await Promise.all([
        e2e
          .request()
          .get(ORDERS_ROUTE)
          .set('Authorization', bearer(scene.owner.accessToken)),
        e2e
          .request()
          .get(`${ORDERS_ROUTE}/${scene.history.paid.id}`)
          .set('Authorization', bearer(scene.owner.accessToken)),
      ]);
      expect(
        listOf(list).data.find(
          (order: { id: string }) => order.id === scene.history.paid.id,
        ),
      ).toEqual(detail.body);
    });

    it('rejects a malformed order id before reading a row', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${MALFORMED_ORDER_ID}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expectValidation(response);
    });
  });

  describe('Authorization: a client reaches their own orders and nothing else', () => {
    it("lists only the owner's five orders", async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual(scene.history.all.map((o) => o.id));
      expect(ids(listOf(response))).not.toContain(scene.strangerOrder.id);
    });

    it("lists only the stranger's order for the stranger", async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.stranger.accessToken));
      expect(ids(listOf(response))).toEqual([scene.strangerOrder.id]);
      expect(listOf(response).meta.total).toBe(1);
    });

    it('lets a manager list all six orders', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(scene.manager.accessToken));
      expect(response.status).toBe(200);
      expect(ids(listOf(response))).toEqual(
        expect.arrayContaining([
          ...scene.history.all.map((o) => o.id),
          scene.strangerOrder.id,
        ]),
      );
      expect(listOf(response).meta.total).toBe(6);
    });

    it("answers 404 rather than 403 for another client's order", async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.strangerOrder.id}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ type: Problems.notFound.type });
    });

    it("answers 404 when the stranger asks for the owner's order", async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`)
        .set('Authorization', bearer(scene.stranger.accessToken));
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ type: Problems.notFound.type });
    });

    it('answers 404 for an unknown order id', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${UNKNOWN_ORDER_ID}`)
        .set('Authorization', bearer(scene.owner.accessToken));
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ type: Problems.notFound.type });
    });

    it('does not reveal whether an inaccessible id exists', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const [owned, unknown] = await Promise.all([
        e2e
          .request()
          .get(`${ORDERS_ROUTE}/${scene.strangerOrder.id}`)
          .set('Authorization', bearer(scene.owner.accessToken)),
        e2e
          .request()
          .get(`${ORDERS_ROUTE}/${UNKNOWN_ORDER_ID}`)
          .set('Authorization', bearer(scene.owner.accessToken)),
      ]);
      // `instance` echoes the requested path, so the two bodies differ there
      // by construction. Copied and deleted rather than rest-destructured:
      // the discarded binding would be an unused variable, and this says
      // plainly which member is being excluded and why.
      const withoutInstance = (body: unknown): Record<string, unknown> => {
        const rest = { ...(body as Record<string, unknown>) };
        delete rest.instance;
        return rest;
      };
      expect(owned.status).toBe(404);
      expect(withoutInstance(owned.body)).toEqual(
        withoutInstance(unknown.body),
      );
    });

    it('allows a manager to read the order a client cannot see', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.strangerOrder.id}`)
        .set('Authorization', bearer(scene.manager.accessToken));
      expect(response.status).toBe(200);
      expect(orderOf(response).id).toBe(scene.strangerOrder.id);
    });
  });

  describe('Unauthenticated access', () => {
    it('rejects a list request without credentials', async () => {
      const response = await e2e.request().get(ORDERS_ROUTE);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    it('rejects a detail request without credentials before looking up a row', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(`${ORDERS_ROUTE}/${scene.history.shipped.id}`);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
    });

    it('rejects a malformed access token', async () => {
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set('Authorization', bearer(MALFORMED_ACCESS_TOKEN));
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
      expect(response.headers['www-authenticate']).toContain('invalid_token');
    });

    it('rejects an expired but correctly signed token', async () => {
      const scene = await arrangeOrderHistory(e2e);
      const response = await e2e
        .request()
        .get(ORDERS_ROUTE)
        .set(
          'Authorization',
          bearer(expiredAccessToken(e2e, scene.owner.user)),
        );
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ type: Problems.unauthorized.type });
      expect(response.headers['www-authenticate']).toContain('invalid_token');
    });
  });
});
