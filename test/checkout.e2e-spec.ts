import { createE2eApp, type E2eApp } from './support/app';

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
    it.todo(
      'answers 201 with an order in the PENDING status whose total is 12 500 cents and whose subtotal and discount are 12 500 and 0',
    );
    it.todo(
      'answers with an expiresAt 30 minutes ahead, which is PENDING_ORDER_TTL_MS after the order was created',
    );
    it.todo(
      "answers with the cart's two lines: 3 x 'E2E Checkout Cap' at 1 500 for a lineTotal of 4 500, and 2 x 'E2E Checkout Tee' at 4 000 for 8 000",
    );
    it.todo(
      'answers with a clientSecret, which is the only field CheckoutOrderView adds to OrderView',
    );
    it.todo(
      'copies CHECKOUT_ADDRESS onto the order and answers CHECKOUT_ADDRESS_VIEW, with line2 and region null because the body omitted them',
    );
    it.todo(
      'moves the cart out of the ACTIVE status and clears its activeUserId, so activeCartOf answers null for the shopper afterwards',
    );
    it.todo(
      'leaves the cart lines where they were: the spent cart still holds 2 tee and 3 cap',
    );
    it.todo(
      'writes exactly one order for the shopper and one status-history row for it, at sequence 0',
    );
    it.todo(
      "leaves the stranger's cart ACTIVE with its single 1 x tee line, because checkout reads only the caller's own cart",
    );
    it.todo(
      'answers the same order from GET /orders/{orderId} afterwards, minus the clientSecret',
    );
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
    it.todo(
      "keeps productName 'E2E Checkout Tee' and unitPrice 4 000 after repriceAndRename moves the product to 'Renamed Tee' at 9 900",
    );
    it.todo(
      "keeps the order's subtotal and total at 12 500 after that same reprice",
    );
    it.todo(
      'keeps each line pointing at the sku it was placed from, so skuId still names the renamed product',
    );
    it.todo(
      'freezes the price the SKU carried inside the transaction and not the one the cart was filled at: a tee repriced to 9 900 before the checkout produces a line at 9 900 and an order total of 24 300',
    );
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
    it.todo(
      'answers paymentMethod PAYMENT_INTENT on the checkout response itself, and not only on a later GET /orders/{orderId}',
    );
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
    it.todo(
      "answers 409 cart-not-checkoutable with the detail 'The cart is empty.' for a caller whose active cart holds no lines",
    );
    it.todo(
      'answers the same 409 cart-not-checkoutable for a caller with no cart row at all',
    );
    it.todo(
      "does not reach another client's cart: a caller with no cart of their own is refused while the stranger's full cart is still ACTIVE and untouched",
    );
    it.todo(
      'answers 409 order-already-pending while a live pending order stands, and names that order expiresAt in the problem document',
    );
    it.todo(
      'leaves the cart ACTIVE and writes no second order when it refuses for a live pending order',
    );
    it.todo(
      "answers 409 stock-unavailable with the detail 'Only 2 unit(s) of E2E Checkout Cap are available.' when setSkuCounts leaves the cap at stock 4 and reserved 2 against a cart line of 3",
    );
    it.todo(
      'answers 409 stock-unavailable rather than placing a short order, so ordersOf the shopper is still empty afterwards',
    );
    it.todo(
      'answers 400 validation when recipientName is the empty string, which BLANK_RECIPIENT_ADDRESS sends',
    );
    it.todo('answers 400 validation when postalCode is missing entirely');
    it.todo(
      "answers 409 item-withdrawn with the detail 'E2E Checkout Cap is no longer for sale.' when withdrawProduct deactivates the cap, and the same for a soft-deleted product",
    );
  });

  describe('POST /orders: the returning customer reclaims a lapsed order', () => {
    it.todo(
      'answers 201 and places the new order when the caller lapsed pending order held 4 caps',
    );
    it.todo(
      'moves the lapsed order to the CANCELLED status and clears its expiresAt',
    );
    it.todo(
      'appends CANCELLED to the lapsed order status history at sequence 1',
    );
    it.todo(
      'gives the lapsed order 4 cap units back and takes the new order 3, leaving cap reserved at 3 and stock at 10',
    );
    it.todo(
      'cancels the lapsed order intent: e2e.stripe.cancelled contains intentIdFor(lapsedOrderId) exactly once',
    );
    it.todo(
      'cancels that intent before anything is released: an e2e.stripe.onCancel hook reading skuCountsOf mid-flight still sees the 4 cap units reserved',
    );
    it.todo(
      'answers 409 order-already-pending and releases nothing when e2e.stripe.cancelSucceeds is false: the lapsed order is still PENDING, cap reserved is still 4, and the cart is still ACTIVE',
    );
    it.todo(
      'writes no new order at all after that refused cancellation, so ordersOf the shopper still holds only the lapsed one',
    );
    it.todo(
      'answers 409 order-already-pending and creates no intent for an order placed past IDEMPOTENCY_KEY_TTL_MS with no Payment row, because an unreachable intent is an unreleasable reservation',
    );
    it.todo(
      'reclaims only the lapsed order and never a live one: a pending order seeded by seedLivePendingOrder is left PENDING with its reservations',
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
    it.todo(
      "answers 401 unauthorized with a WWW-Authenticate header of 'Bearer' when no credentials are sent",
    );
    it.todo(
      'answers 401 to a malformed access token, with invalid_token in WWW-Authenticate',
    );
    it.todo(
      'answers 401 to an expired but correctly signed token from expiredAccessToken',
    );
    it.todo(
      'reserves nothing and creates no intent for an unauthenticated request, even one carrying a valid body',
    );
  });
});
