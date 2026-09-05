import { CartStatus, OrderStatus, PaymentMethod } from '@prisma/client';
import {
  Problems,
  type ProblemKind,
} from '../src/common/problem/problem.catalog';
import type { ProblemBody } from '../src/common/problem/problem.exception';
import { PENDING_ORDER_TTL_MS } from '../src/orders/orders.service';
import type { CheckoutOrderView, OrderView } from '../src/orders/orders.views';
import { createE2eApp, type E2eApp } from './support/app';
import {
  activeCartOf,
  arrangeCheckout,
  BLANK_RECIPIENT_ADDRESS,
  cartRowOf,
  CHECKOUT_ADDRESS,
  CHECKOUT_ADDRESS_VIEW,
  CHECKOUT_ROUTE,
  orderRowOf,
  ordersOf,
  seedEmptyCart,
  seedLapsedPendingOrder,
  seedLivePendingOrder,
  setSkuCounts,
  signInClient,
  STALE_PLACED_AGO_MS,
  withdrawProduct,
} from './support/checkout-fixtures';
import {
  expiredAccessToken,
  MALFORMED_ACCESS_TOKEN,
  type Session,
} from './support/fixtures';
import { repriceAndRename } from './support/order-fixtures';

function bearer(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Supertest types `body` as `any`, so every read of it trips the
 * unsafe-member-access rule and, worse, would let a renamed field pass
 * unnoticed. These three name the shape once, from the application's own
 * types rather than a copy of them: a change to `OrderView`,
 * `CheckoutOrderView` or `ProblemBody` breaks the suite at compile time,
 * which is where it should break.
 */
const checkoutOf = (response: { body: unknown }): CheckoutOrderView =>
  response.body as CheckoutOrderView;

const orderOf = (response: { body: unknown }): OrderView =>
  response.body as OrderView;

const problemOf = (response: { body: unknown }): ProblemBody =>
  response.body as ProblemBody;

function postCheckout(
  e2e: E2eApp,
  session: Session,
  body: object = CHECKOUT_ADDRESS,
) {
  return e2e
    .request()
    .post(CHECKOUT_ROUTE)
    .set('Authorization', bearer(session.accessToken))
    .send(body);
}

function getOrder(e2e: E2eApp, session: Session, orderId: string) {
  return e2e
    .request()
    .get(`${CHECKOUT_ROUTE}/${orderId}`)
    .set('Authorization', bearer(session.accessToken));
}

/**
 * A refusal is asserted by its kind and not by its status alone: the seven
 * checkout conflicts share 409, so `expect(status).toBe(409)` would hold for
 * six answers the case did not mean. The detail is compared exactly, because
 * it is the sentence the client is shown.
 */
function expectProblem(
  response: { status: number; body: unknown },
  kind: ProblemKind,
  detail: string,
): void {
  expect(response.status).toBe(kind.status);
  expect(problemOf(response).type).toBe(kind.type);
  expect(problemOf(response).title).toBe(kind.title);
  expect(problemOf(response).detail).toBe(detail);
}

/**
 * `ORDER_INCLUDE` reads the lines with no `orderBy`, so Postgres returns them
 * in whatever order it likes and two reads of the same order may disagree
 * about positions. Sorting by id is what lets a whole-body comparison mean
 * "the same order" rather than "the same order, read twice in a row".
 */
function withSortedItems(view: OrderView): OrderView {
  return {
    ...view,
    items: [...view.items].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

/** The lines sorted by the name the case list quotes them in. */
function itemsByName(view: OrderView): OrderView['items'] {
  return [...view.items].sort((left, right) =>
    left.productName.localeCompare(right.productName),
  );
}

/** The two product names `arrangeCheckout` seeds, as the case names quote them. */
const TEE_NAME = 'E2E Checkout Tee';
const CAP_NAME = 'E2E Checkout Cap';

/** What `repriceAndRename` moves the tee to, the price in integer cents. */
const RENAMED_TEE = 'Renamed Tee';
const REPRICED_TEE = 9_900;

/** Thirty minutes, the number the case name states `PENDING_ORDER_TTL_MS` is. */
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;

/**
 * How far apart the database's `now()` and the application's `Date.now()` may
 * land. `createdAt` is a column default and `expiresAt` is computed in Node,
 * so their difference is the TTL plus whatever the two clocks disagree by.
 */
const CLOCK_SKEW_MS = 5_000;

/** The sentence `order-already-pending` carries. */
const PENDING_ORDER_DETAIL = 'Pay the pending order or wait for it to expire.';

/**
 * The third and last of the flows the program mandates, after authentication
 * and order history: checkout. Real HTTP requests against the real
 * application over the e2e database, posting `POST /api/v1/orders`.
 *
 * WHAT IS HERE AND WHAT IS NOT. This file is the harness and the case list.
 * The fixtures every case needs already exist and have been run against the
 * real database — see `test/support/checkout-fixtures.ts`, which sits beside
 * `order-fixtures.ts` and reuses its `seedSku` and `seedOrder` rather than
 * opening a second harness. The `expect` calls are the student's, per
 * CLAUDE.md: an assertion written by the same hand that produced the
 * behaviour asserts the behaviour it produced, bugs included. Every name
 * below states the exact number, status or identifier the arrangement makes
 * true, so a stub can be turned into an assertion without re-deriving it.
 *
 * THE ARRANGEMENT. Most cases start from one line:
 *
 *   const scene = await arrangeCheckout(e2e);
 *
 * which signs in two CLIENTs, seeds two SKUs and gives each shopper an
 * active cart:
 *
 *   sku   price (cents)   stock   reserved   scene.cart   scene.strangerCart
 *   tee           4 000      10          0      2 units             1 unit
 *   cap           1 500      10          0      3 units                  —
 *
 *   scene.shopper       the CLIENT whose cart prices at 12 500 cents
 *   scene.stranger      another CLIENT, whose cart prices at 4 000
 *   scene.skus          { tee, cap }, named 'E2E Checkout Tee' and 'E2E Checkout Cap'
 *   scene.cart          the shopper's, ACTIVE, 2 x tee + 3 x cap
 *   scene.strangerCart  the stranger's, ACTIVE, 1 x tee
 *
 * The stranger's line is on the *same* tee deliberately. A cart is not a
 * reservation, so after the shopper checks out `tee.reserved` is 2 and not 3,
 * and the stranger's cart is still ACTIVE with its line intact.
 *
 * THE REQUEST. `e2e.request().post(CHECKOUT_ROUTE).set('Authorization',
 * `Bearer ${scene.shopper.accessToken}`).send(CHECKOUT_ADDRESS)`, with both
 * constants exported from the same fixtures module. `CHECKOUT_ADDRESS` omits
 * `line2` and `region`, so the order stores null for both and the view
 * answers `CHECKOUT_ADDRESS_VIEW`.
 *
 * THE REST OF THE TOOLKIT, all from `./support/checkout-fixtures`:
 *
 *   seedCart / seedEmptyCart      a cart with the lines a case needs, or none
 *   seedLivePendingOrder          a PENDING order whose expiry is ahead of it
 *   seedLapsedPendingOrder        one whose expiry has passed, holding its stock
 *   seedPayment                   the `Payment` row a placed order carries
 *   setSkuCounts                  moves the shelf under a cart already filled
 *   skuCountsOf                   { stock, reserved, available } for one SKU
 *   orderRowOf / ordersOf         the order as the database holds it
 *   cartRowOf / activeCartOf      the cart's status and its mirror column
 *   paymentsOf                    every attempt on one order, newest first
 *   signInClient / signInWithRole a CLIENT with nothing, or a MANAGER/DELIVERY
 *
 * `seedLapsedPendingOrder` writes the `Payment` row by default, which is what
 * a checkout that ran to completion leaves behind; `withRecordedIntent:
 * false` reproduces the window between the order's commit and that row, and
 * `placedAgoMs: STALE_PLACED_AGO_MS` pushes it past `IDEMPOTENCY_KEY_TTL_MS`,
 * where the intent can no longer be reached and therefore nothing may be
 * released.
 *
 * WHAT STRIPE RECORDS. `test/support/app.ts` replaces `StripeService` with
 * `StripeStub` on both module trees, and the stub records rather than only
 * answering: `e2e.stripe.created`, `e2e.stripe.cancelled`, and
 * `e2e.stripe.createdFor(orderId)` — which is the double-charge question and
 * the reason several cases below are about a number rather than a status.
 * `e2e.stripe.cancelSucceeds = false` makes a cancellation fail, and
 * `e2e.stripe.onCancel` runs *while* one is in flight, which is the only
 * vantage point from which "the intent was stopped before anything was
 * released" can be told apart from the opposite ordering.
 *
 * WHAT IS DELIBERATELY ABSENT. Nothing here reads the payment webhook or the
 * sweep. Both move a PENDING order from the outside and both have their own
 * home; this suite is about the request a client makes and what it leaves in
 * the database.
 */
describe('Checkout (e2e)', () => {
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

  describe('POST /orders: the active cart becomes a pending order', () => {
    it('answers 201 with an order in the PENDING status whose total is 12 500 cents and whose subtotal and discount are 12 500 and 0', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      expect(checkoutOf(response).status).toBe(OrderStatus.PENDING);
      expect(checkoutOf(response).subtotal).toBe(12500);
      expect(checkoutOf(response).discount).toBe(0);
      expect(checkoutOf(response).total).toBe(12500);
    });

    it('answers with an expiresAt 30 minutes ahead, which is PENDING_ORDER_TTL_MS after the order was created', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);
      const view = checkoutOf(response);

      expect(response.status).toBe(201);
      expect(PENDING_ORDER_TTL_MS).toBe(THIRTY_MINUTES_MS);
      // Both instants serialize as ISO 8601, which is what makes the
      // subtraction below a comparison of dates rather than of two strings.
      expect(view.expiresAt).toEqual(expect.any(String));
      expect(new Date(view.expiresAt ?? '').toISOString()).toBe(view.expiresAt);
      expect(new Date(view.createdAt).toISOString()).toBe(view.createdAt);
      const drift = Math.abs(
        Date.parse(view.expiresAt ?? '') -
          Date.parse(view.createdAt) -
          PENDING_ORDER_TTL_MS,
      );
      expect(drift).toBeLessThan(CLOCK_SKEW_MS);
    });

    it("answers with the cart's two lines: 3 x 'E2E Checkout Cap' at 1 500 for a lineTotal of 4 500, and 2 x 'E2E Checkout Tee' at 4 000 for 8 000", async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);
      const items = itemsByName(checkoutOf(response));

      expect(response.status).toBe(201);
      // The length first: without it the two comparisons below would still
      // hold for an answer carrying a third line nobody asked for.
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        skuId: scene.skus.cap.id,
        productName: CAP_NAME,
        quantity: 3,
        unitPrice: 1500,
        lineTotal: 4500,
      });
      expect(items[1]).toMatchObject({
        skuId: scene.skus.tee.id,
        productName: TEE_NAME,
        quantity: 2,
        unitPrice: 4000,
        lineTotal: 8000,
      });
    });

    it('answers with a clientSecret, which is the only field CheckoutOrderView adds to OrderView', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);
      const view = checkoutOf(response);

      expect(response.status).toBe(201);
      expect(typeof view.clientSecret).toBe('string');
      expect(view.clientSecret.length).toBeGreaterThan(0);

      // "The only field it adds" is a statement about the whole key set, so
      // the whole key set is what is compared: an extra member on either
      // side fails here instead of slipping past a containment matcher.
      const detail = await getOrder(e2e, scene.shopper, view.id);
      expect(detail.status).toBe(200);
      expect(Object.keys(view).sort()).toEqual(
        [...Object.keys(orderOf(detail)), 'clientSecret'].sort(),
      );
    });

    it('copies CHECKOUT_ADDRESS onto the order and answers CHECKOUT_ADDRESS_VIEW, with line2 and region null because the body omitted them', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      expect(checkoutOf(response).shippingAddress).toEqual(
        CHECKOUT_ADDRESS_VIEW,
      );

      const row = await orderRowOf(e2e, checkoutOf(response).id);
      expect(row).not.toBeNull();
      expect(row).toMatchObject({ ...CHECKOUT_ADDRESS });
      expect(row?.line2).toBeNull();
      expect(row?.region).toBeNull();
    });

    it('moves the cart out of the ACTIVE status and clears its activeUserId, so activeCartOf answers null for the shopper afterwards', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      const cart = await cartRowOf(e2e, scene.cart.id);
      expect(cart).not.toBeNull();
      expect(cart?.status).toBe(CartStatus.CHECKED_OUT);
      expect(cart?.activeUserId).toBeNull();
      expect(await activeCartOf(e2e, scene.shopper.user.id)).toBeNull();
    });

    it('leaves the cart lines where they were: the spent cart still holds 2 tee and 3 cap', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      const cart = await cartRowOf(e2e, scene.cart.id);
      expect(cart?.items).toHaveLength(2);
      // An exact map rather than two containment checks, so a line that was
      // deleted, duplicated or re-quantified fails here.
      expect(
        Object.fromEntries(
          (cart?.items ?? []).map((item) => [item.skuId, item.quantity]),
        ),
      ).toEqual({
        [scene.skus.tee.id]: 2,
        [scene.skus.cap.id]: 3,
      });
    });

    it('writes exactly one order for the shopper and one status-history row for it, at sequence 0', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      const orders = await ordersOf(e2e, scene.shopper.user.id);
      expect(orders).toHaveLength(1);
      expect(orders[0].id).toBe(checkoutOf(response).id);

      const row = await orderRowOf(e2e, orders[0].id);
      expect(row?.statusHistory).toHaveLength(1);
      expect(row?.statusHistory[0]).toMatchObject({
        status: OrderStatus.PENDING,
        sequence: 0,
      });
    });

    it.todo(
      "leaves the stranger's cart ACTIVE with its single 1 x tee line, because checkout reads only the caller's own cart",
    );

    it('answers the same order from GET /orders/{orderId} afterwards, minus the clientSecret', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);
      expect(response.status).toBe(201);

      const detail = await getOrder(
        e2e,
        scene.shopper,
        checkoutOf(response).id,
      );
      expect(detail.status).toBe(200);

      // Copied and deleted rather than rest-destructured: the discarded
      // binding would be an unused variable, and this says plainly which
      // member is being excluded and why.
      const placed: Partial<CheckoutOrderView> = withSortedItems(
        checkoutOf(response),
      );
      delete placed.clientSecret;
      expect(withSortedItems(orderOf(detail))).toEqual(placed);
      expect(detail.body).not.toHaveProperty('clientSecret');
    });
  });

  describe('POST /orders: the reservation is not a sale', () => {
    it.todo('raises tee reserved from 0 to 2 and cap reserved from 0 to 3');
    it.todo(
      'leaves tee stock at 10 and cap stock at 10, because nothing has shipped',
    );
    it.todo(
      'lowers available from 10 to 8 on the tee and from 10 to 7 on the cap, which is stock minus reserved',
    );
    it.todo(
      "does not reserve the stranger's cart line: tee reserved is 2 and not 3, because a cart holds no units",
    );
    it.todo(
      'reserves nothing when the checkout is refused, even for the tee it had already priced before reaching the cap it could not fill',
    );
  });

  describe('POST /orders: the lines are frozen at the moment of purchase', () => {
    it("keeps productName 'E2E Checkout Tee' and unitPrice 4 000 after repriceAndRename moves the product to 'Renamed Tee' at 9 900", async () => {
      const scene = await arrangeCheckout(e2e);
      const response = await postCheckout(e2e, scene.shopper);
      expect(response.status).toBe(201);

      await repriceAndRename(e2e, scene.skus.tee, {
        productName: RENAMED_TEE,
        price: REPRICED_TEE,
      });

      const detail = await getOrder(
        e2e,
        scene.shopper,
        checkoutOf(response).id,
      );
      expect(detail.status).toBe(200);
      expect(
        orderOf(detail).items.find((item) => item.skuId === scene.skus.tee.id),
      ).toMatchObject({
        productName: TEE_NAME,
        unitPrice: 4000,
        lineTotal: 8000,
      });
    });

    it("keeps the order's subtotal and total at 12 500 after that same reprice", async () => {
      const scene = await arrangeCheckout(e2e);
      const response = await postCheckout(e2e, scene.shopper);
      expect(response.status).toBe(201);

      await repriceAndRename(e2e, scene.skus.tee, {
        productName: RENAMED_TEE,
        price: REPRICED_TEE,
      });

      const detail = await getOrder(
        e2e,
        scene.shopper,
        checkoutOf(response).id,
      );
      expect(detail.status).toBe(200);
      expect(orderOf(detail).subtotal).toBe(12500);
      expect(orderOf(detail).discount).toBe(0);
      expect(orderOf(detail).total).toBe(12500);
    });

    it('keeps each line pointing at the sku it was placed from, so skuId still names the renamed product', async () => {
      const scene = await arrangeCheckout(e2e);
      const response = await postCheckout(e2e, scene.shopper);
      expect(response.status).toBe(201);

      await repriceAndRename(e2e, scene.skus.tee, {
        productName: RENAMED_TEE,
        price: REPRICED_TEE,
      });

      const detail = await getOrder(
        e2e,
        scene.shopper,
        checkoutOf(response).id,
      );
      expect(detail.status).toBe(200);
      expect(
        orderOf(detail)
          .items.map((item) => item.skuId)
          .sort(),
      ).toEqual([scene.skus.cap.id, scene.skus.tee.id].sort());

      // The half that makes the case say something: the SKU the line points
      // at really did move, and the line kept the old name regardless.
      const sku = await e2e.prisma.sku.findUniqueOrThrow({
        where: { id: scene.skus.tee.id },
        include: { product: true },
      });
      expect(sku.product.name).toBe(RENAMED_TEE);
      expect(sku.price).toBe(REPRICED_TEE);
      expect(
        orderOf(detail).items.find((item) => item.skuId === scene.skus.tee.id)
          ?.productName,
      ).toBe(TEE_NAME);
    });

    it('freezes the price the SKU carried inside the transaction and not the one the cart was filled at: a tee repriced to 9 900 before the checkout produces a line at 9 900 and an order total of 24 300', async () => {
      const scene = await arrangeCheckout(e2e);
      // The cart was seeded holding 4 000 a line; the shelf moves underneath
      // it before the request, which is what the re-read exists to catch.
      await repriceAndRename(e2e, scene.skus.tee, {
        productName: RENAMED_TEE,
        price: REPRICED_TEE,
      });

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      expect(
        checkoutOf(response).items.find(
          (item) => item.skuId === scene.skus.tee.id,
        ),
      ).toMatchObject({
        productName: RENAMED_TEE,
        quantity: 2,
        unitPrice: REPRICED_TEE,
        lineTotal: 19800,
      });
      expect(checkoutOf(response).subtotal).toBe(24300);
      expect(checkoutOf(response).total).toBe(24300);
    });
  });

  describe('POST /orders: the payment attempt is recorded', () => {
    it.todo(
      'writes exactly one Payment row for the order, in the PENDING status and never SUCCEEDED',
    );
    it.todo(
      'writes that row with the PAYMENT_INTENT method and an amount of 12 500 cents, equal to the order total',
    );
    it.todo(
      "writes the intent's id onto stripePaymentIntentId, which is intentIdFor(order.id)",
    );

    it('answers paymentMethod PAYMENT_INTENT on the checkout response itself, and not only on a later GET /orders/{orderId}', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      expect(checkoutOf(response).paymentMethod).toBe(
        PaymentMethod.PAYMENT_INTENT,
      );

      // The second half of the name: the field is not merely reachable
      // later, it is already on the answer the checkout itself returns.
      const detail = await getOrder(
        e2e,
        scene.shopper,
        checkoutOf(response).id,
      );
      expect(detail.status).toBe(200);
      expect(orderOf(detail).paymentMethod).toBe(PaymentMethod.PAYMENT_INTENT);
    });

    it.todo(
      'hands Stripe the order total as an integer number of cents: e2e.stripe.created carries { orderId, amount: 12500 }',
    );
  });

  describe('POST /orders: one intent per order however often a client retries', () => {
    it.todo(
      'creates exactly one intent for the placed order: stripe.createdFor(orderId) is 1',
    );
    it.todo(
      'creates no second intent when a retry is refused by a live pending order: stripe.createdFor stays 1 for the first order and 0 for anything else',
    );
    it.todo(
      'creates no intent at all for a checkout it refuses, so e2e.stripe.created stays empty after an empty-cart refusal',
    );
    it.todo(
      'reuses a lapsed order recorded intent rather than asking for a second one: stripe.createdFor(lapsedOrderId) is 0 when seedLapsedPendingOrder wrote its Payment row',
    );
    it.todo(
      'asks for the lapsed order intent exactly once when no Payment row recorded it: with withRecordedIntent false, stripe.createdFor(lapsedOrderId) is 1',
    );
  });

  describe('POST /orders: the refusals', () => {
    it("answers 409 cart-not-checkoutable with the detail 'The cart is empty.' for a caller whose active cart holds no lines", async () => {
      const shopper = await signInClient(e2e);
      await seedEmptyCart(e2e, shopper.user.id);

      const response = await postCheckout(e2e, shopper);

      expectProblem(
        response,
        Problems.cartNotCheckoutable,
        'The cart is empty.',
      );
    });

    it('answers the same 409 cart-not-checkoutable for a caller with no cart row at all', async () => {
      const shopper = await signInClient(e2e);

      const response = await postCheckout(e2e, shopper);

      expectProblem(
        response,
        Problems.cartNotCheckoutable,
        'The cart is empty.',
      );
    });

    it.todo(
      "does not reach another client's cart: a caller with no cart of their own is refused while the stranger's full cart is still ACTIVE and untouched",
    );

    it('answers 409 order-already-pending while a live pending order stands, and names that order expiresAt in the problem document', async () => {
      const scene = await arrangeCheckout(e2e);
      const live = await seedLivePendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 1 }],
      });

      const response = await postCheckout(e2e, scene.shopper);

      expectProblem(
        response,
        Problems.orderAlreadyPending,
        PENDING_ORDER_DETAIL,
      );
      // The extension, and the exact instant: this is the only one of the
      // seven conflicts that carries a field beyond the RFC 9457 five.
      expect(problemOf(response).expiresAt).toBe(live.expiresAt.toISOString());
    });

    it('leaves the cart ACTIVE and writes no second order when it refuses for a live pending order', async () => {
      const scene = await arrangeCheckout(e2e);
      const live = await seedLivePendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 1 }],
      });

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(409);
      const cart = await cartRowOf(e2e, scene.cart.id);
      expect(cart?.status).toBe(CartStatus.ACTIVE);
      expect(cart?.activeUserId).toBe(scene.shopper.user.id);

      const orders = await ordersOf(e2e, scene.shopper.user.id);
      expect(orders).toHaveLength(1);
      expect(orders[0].id).toBe(live.order.id);
    });

    it("answers 409 stock-unavailable with the detail 'Only 2 unit(s) of E2E Checkout Cap are available.' when setSkuCounts leaves the cap at stock 4 and reserved 2 against a cart line of 3", async () => {
      const scene = await arrangeCheckout(e2e);
      await setSkuCounts(e2e, scene.skus.cap, { stock: 4, reserved: 2 });

      const response = await postCheckout(e2e, scene.shopper);

      expectProblem(
        response,
        Problems.stockUnavailable,
        `Only 2 unit(s) of ${CAP_NAME} are available.`,
      );
    });

    it('answers 409 stock-unavailable rather than placing a short order, so ordersOf the shopper is still empty afterwards', async () => {
      const scene = await arrangeCheckout(e2e);
      await setSkuCounts(e2e, scene.skus.cap, { stock: 4, reserved: 2 });

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(409);
      expect(problemOf(response).type).toBe(Problems.stockUnavailable.type);
      expect(await ordersOf(e2e, scene.shopper.user.id)).toEqual([]);
    });

    it('answers 400 validation when recipientName is the empty string, which BLANK_RECIPIENT_ADDRESS sends', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await postCheckout(
        e2e,
        scene.shopper,
        BLANK_RECIPIENT_ADDRESS,
      );

      expect(response.status).toBe(400);
      expect(problemOf(response).type).toBe(Problems.validation.type);
      expect(problemOf(response).title).toBe(Problems.validation.title);
      // Which field was refused, and not merely that something was: a 400
      // naming `line1` would be a different bug wearing the same status.
      expect(problemOf(response).detail).toContain('recipientName');
    });

    it('answers 400 validation when postalCode is missing entirely', async () => {
      const scene = await arrangeCheckout(e2e);
      const withoutPostalCode: Record<string, string> = { ...CHECKOUT_ADDRESS };
      delete withoutPostalCode.postalCode;

      const response = await postCheckout(
        e2e,
        scene.shopper,
        withoutPostalCode,
      );

      expect(response.status).toBe(400);
      expect(problemOf(response).type).toBe(Problems.validation.type);
      expect(problemOf(response).title).toBe(Problems.validation.title);
      expect(problemOf(response).detail).toContain('postalCode');
    });

    it("answers 409 item-withdrawn with the detail 'E2E Checkout Cap is no longer for sale.' when withdrawProduct deactivates the cap, and the same for a soft-deleted product", async () => {
      const deactivated = await arrangeCheckout(e2e);
      await withdrawProduct(e2e, deactivated.skus.cap, { deactivate: true });

      const unpublished = await postCheckout(e2e, deactivated.shopper);

      expectProblem(
        unpublished,
        Problems.itemWithdrawn,
        `${CAP_NAME} is no longer for sale.`,
      );

      // The second column, on its own scene: `isActive` and `deletedAt` are
      // different writes and the case name asks for both.
      const softDeleted = await arrangeCheckout(e2e);
      await withdrawProduct(e2e, softDeleted.skus.cap, { softDelete: true });

      const removed = await postCheckout(e2e, softDeleted.shopper);

      expectProblem(
        removed,
        Problems.itemWithdrawn,
        `${CAP_NAME} is no longer for sale.`,
      );
    });
  });

  describe('POST /orders: the returning customer reclaims a lapsed order', () => {
    it('answers 201 and places the new order when the caller lapsed pending order held 4 caps', async () => {
      const scene = await arrangeCheckout(e2e);
      const lapsed = await seedLapsedPendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
      });

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      expect(checkoutOf(response).status).toBe(OrderStatus.PENDING);
      expect(checkoutOf(response).total).toBe(12500);
      expect(checkoutOf(response).id).not.toBe(lapsed.order.id);
    });

    it('moves the lapsed order to the CANCELLED status and clears its expiresAt', async () => {
      const scene = await arrangeCheckout(e2e);
      const lapsed = await seedLapsedPendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
      });

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      const row = await orderRowOf(e2e, lapsed.order.id);
      expect(row).not.toBeNull();
      expect(row?.status).toBe(OrderStatus.CANCELLED);
      expect(row?.expiresAt).toBeNull();
    });

    it('appends CANCELLED to the lapsed order status history at sequence 1', async () => {
      const scene = await arrangeCheckout(e2e);
      const lapsed = await seedLapsedPendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
      });

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(201);
      const row = await orderRowOf(e2e, lapsed.order.id);
      // Appended, not replaced: the seeded PENDING row stays at sequence 0.
      expect(row?.statusHistory).toHaveLength(2);
      expect(row?.statusHistory[0]).toMatchObject({
        status: OrderStatus.PENDING,
        sequence: 0,
      });
      expect(row?.statusHistory[1]).toMatchObject({
        status: OrderStatus.CANCELLED,
        sequence: 1,
      });
    });

    it.todo(
      'gives the lapsed order 4 cap units back and takes the new order 3, leaving cap reserved at 3 and stock at 10',
    );
    it.todo(
      'cancels the lapsed order intent: e2e.stripe.cancelled contains intentIdFor(lapsedOrderId) exactly once',
    );
    it.todo(
      'cancels that intent before anything is released: an e2e.stripe.onCancel hook reading skuCountsOf mid-flight still sees the 4 cap units reserved',
    );

    it('answers 409 order-already-pending when e2e.stripe.cancelSucceeds is false, leaving the lapsed order PENDING and the cart ACTIVE', async () => {
      const scene = await arrangeCheckout(e2e);
      const lapsed = await seedLapsedPendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
      });
      e2e.stripe.cancelSucceeds = false;

      const response = await postCheckout(e2e, scene.shopper);

      expectProblem(
        response,
        Problems.orderAlreadyPending,
        PENDING_ORDER_DETAIL,
      );
      const row = await orderRowOf(e2e, lapsed.order.id);
      expect(row?.status).toBe(OrderStatus.PENDING);
      expect(row?.expiresAt?.toISOString()).toBe(
        lapsed.expiresAt.toISOString(),
      );

      const cart = await cartRowOf(e2e, scene.cart.id);
      expect(cart?.status).toBe(CartStatus.ACTIVE);
      expect(cart?.activeUserId).toBe(scene.shopper.user.id);
    });

    it.todo(
      'releases nothing when e2e.stripe.cancelSucceeds is false: cap reserved is still 4 and cap stock is still 10',
    );

    it('writes no new order at all after that refused cancellation, so ordersOf the shopper still holds only the lapsed one', async () => {
      const scene = await arrangeCheckout(e2e);
      const lapsed = await seedLapsedPendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
      });
      e2e.stripe.cancelSucceeds = false;

      const response = await postCheckout(e2e, scene.shopper);

      expect(response.status).toBe(409);
      const orders = await ordersOf(e2e, scene.shopper.user.id);
      expect(orders).toHaveLength(1);
      expect(orders[0].id).toBe(lapsed.order.id);
    });

    it('answers 409 order-already-pending for an order placed past IDEMPOTENCY_KEY_TTL_MS with no Payment row', async () => {
      const scene = await arrangeCheckout(e2e);
      const stale = await seedLapsedPendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
        withRecordedIntent: false,
        placedAgoMs: STALE_PLACED_AGO_MS,
      });

      const response = await postCheckout(e2e, scene.shopper);

      expectProblem(
        response,
        Problems.orderAlreadyPending,
        PENDING_ORDER_DETAIL,
      );
      expect(problemOf(response).expiresAt).toBe(stale.expiresAt.toISOString());
      const row = await orderRowOf(e2e, stale.order.id);
      expect(row?.status).toBe(OrderStatus.PENDING);
      expect(row?.statusHistory).toHaveLength(1);
    });

    it.todo(
      'creates no intent for an order placed past IDEMPOTENCY_KEY_TTL_MS with no Payment row, because an unreachable intent is an unreleasable reservation',
    );

    it('reclaims only the lapsed order and never a live one: a pending order seeded by seedLivePendingOrder is left PENDING', async () => {
      const scene = await arrangeCheckout(e2e);
      const live = await seedLivePendingOrder(e2e, {
        userId: scene.shopper.user.id,
        lines: [{ sku: scene.skus.cap, quantity: 4 }],
      });

      const response = await postCheckout(e2e, scene.shopper);

      expectProblem(
        response,
        Problems.orderAlreadyPending,
        PENDING_ORDER_DETAIL,
      );
      const row = await orderRowOf(e2e, live.order.id);
      expect(row?.status).toBe(OrderStatus.PENDING);
      // Untouched, not merely still PENDING: neither the expiry nor the
      // history moved, so nothing settled it and re-wrote the same status.
      expect(row?.expiresAt?.toISOString()).toBe(live.expiresAt.toISOString());
      expect(row?.statusHistory).toHaveLength(1);
    });

    it.todo(
      'leaves a live pending order holding its reservations: cap reserved is still 4 and cap stock is still 10',
    );
  });

  describe('POST /orders: who may check out', () => {
    it.todo(
      'answers 403 forbidden to a MANAGER, who has no create rule for an order in docs/AUTHORIZATION-MATRIX.md',
    );
    it.todo('answers 403 forbidden to a DELIVERY courier');
    it.todo(
      'refuses a MANAGER before touching the database: no order and no intent exist afterwards',
    );
  });

  describe('POST /orders: unauthenticated access', () => {
    it("answers 401 unauthorized with a WWW-Authenticate header of 'Bearer' when no credentials are sent", async () => {
      const response = await e2e
        .request()
        .post(CHECKOUT_ROUTE)
        .send(CHECKOUT_ADDRESS);

      expect(response.status).toBe(401);
      expect(problemOf(response).type).toBe(Problems.unauthorized.type);
      expect(problemOf(response).title).toBe(Problems.unauthorized.title);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    it('answers 401 to a malformed access token, with invalid_token in WWW-Authenticate', async () => {
      const response = await e2e
        .request()
        .post(CHECKOUT_ROUTE)
        .set('Authorization', bearer(MALFORMED_ACCESS_TOKEN))
        .send(CHECKOUT_ADDRESS);

      expect(response.status).toBe(401);
      expect(problemOf(response).type).toBe(Problems.unauthorized.type);
      expect(problemOf(response).title).toBe(Problems.unauthorized.title);
      expect(response.headers['www-authenticate']).toContain('invalid_token');
    });

    it('answers 401 to an expired but correctly signed token from expiredAccessToken', async () => {
      const scene = await arrangeCheckout(e2e);

      const response = await e2e
        .request()
        .post(CHECKOUT_ROUTE)
        .set(
          'Authorization',
          bearer(expiredAccessToken(e2e, scene.shopper.user)),
        )
        .send(CHECKOUT_ADDRESS);

      expect(response.status).toBe(401);
      expect(problemOf(response).type).toBe(Problems.unauthorized.type);
      expect(problemOf(response).title).toBe(Problems.unauthorized.title);
      expect(response.headers['www-authenticate']).toContain('invalid_token');
      // The credential was refused, not the cart: an authenticated caller
      // with this same arrangement is the 201 at the top of this file.
      expect(await ordersOf(e2e, scene.shopper.user.id)).toEqual([]);
    });

    it.todo(
      'reserves nothing and creates no intent for an unauthenticated request, even one carrying a valid body',
    );
  });
});
