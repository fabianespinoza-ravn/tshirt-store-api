import { createE2eApp, type E2eApp } from './support/app';

/**
 * The second of the three end-to-end flows the program mandates, after
 * authentication and alongside checkout: order history. Real HTTP requests
 * against the real application over the e2e database, reading
 * `GET /api/v1/orders` and `GET /api/v1/orders/{orderId}`.
 *
 * WHAT IS HERE AND WHAT IS NOT. This file is the harness and the case list.
 * Every case below is an `it.todo`, and that is a declared gap, not an
 * oversight: assertions for behaviour an assistant produced would assert that
 * behaviour, bugs included, so they are the student's to write (CLAUDE.md,
 * Tests). The fixtures each case needs already exist and run — see
 * `test/support/order-fixtures.ts` — and every name below states the exact
 * subset, the exact totals in integer cents and the exact statuses the answer
 * is supposed to contain, so writing the `expect` is reading the name.
 *
 * HOW TO TURN A STUB INTO A TEST. Each case starts from one line:
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
    it.todo(
      "with no filters, returns the caller's five seeded orders newest first — PENDING 2025-05-30, PAID 2025-04-05, SHIPPED 2025-03-15, DELIVERED 2025-02-20, CANCELLED 2025-01-10 — with meta { limit: 20, offset: 0, total: 5 }, the contract's defaults",
    );

    it.todo(
      'date range: placedFrom=2025-02-01T00:00:00.000Z with placedTo=2025-04-30T23:59:59.999Z returns exactly scene.history.delivered, scene.history.shipped and scene.history.paid, newest first, and meta.total 3 — leaving out the CANCELLED order placed 2025-01-10 and the PENDING one placed 2025-05-30',
    );

    it.todo(
      "date range, both bounds inclusive: placedFrom and placedTo both set to 2025-02-20T10:00:00.000Z, the DELIVERED order's own createdAt, return that one order alone and meta.total 1",
    );

    it.todo(
      'date range, open at the top: placedFrom=2025-04-01T00:00:00.000Z with no placedTo returns scene.history.pending and scene.history.paid and meta.total 2',
    );

    it.todo(
      'date range, open at the bottom: placedTo=2025-02-28T23:59:59.999Z with no placedFrom returns scene.history.delivered and scene.history.cancelled and meta.total 2',
    );

    it.todo(
      'order status: status=SHIPPED returns scene.history.shipped alone, with meta.total 1',
    );

    it.todo(
      'order status with no match: status=FAILED returns an empty data array and meta.total 0, because nothing seeded ever failed',
    );

    it.todo(
      'price range: minTotal=4000 with maxTotal=12500 returns scene.history.delivered (4 000), scene.history.pending (7 500) and scene.history.shipped (12 500), newest first, and meta.total 3 — both bounds inclusive, with the PAID order at 25 000 and the CANCELLED one at 1 500 outside',
    );

    it.todo(
      'price range, open at the top: minTotal=12500 alone returns scene.history.paid (25 000) and scene.history.shipped (12 500) and meta.total 2',
    );

    it.todo(
      'price range, open at the bottom: maxTotal=4000 alone returns scene.history.delivered (4 000) and scene.history.cancelled (1 500) and meta.total 2',
    );

    it.todo(
      'the three filters combined narrow to one row: status=SHIPPED with placedFrom=2025-02-01T00:00:00.000Z, placedTo=2025-04-30T23:59:59.999Z, minTotal=4000 and maxTotal=12500 returns scene.history.shipped alone and meta.total 1',
    );

    it.todo(
      "the filters are combined with AND and not OR: status=PAID with maxTotal=12500 returns an empty data array and meta.total 0, since the only PAID order of the caller's costs 25 000",
    );

    it.todo(
      'rejects an unknown status, status=NOT_A_STATUS, with 400 and the validation problem type',
    );

    it.todo(
      'rejects a non-integer price bound, minTotal=125.5, with 400 and the validation problem type: money is an integer number of cents',
    );

    it.todo(
      'rejects a negative price bound, minTotal=-1, with 400 and the validation problem type',
    );

    it.todo(
      'rejects a date that is not ISO 8601, placedFrom=yesterday, with 400 and the validation problem type',
    );
  });

  describe('GET /orders: pagination', () => {
    it.todo(
      'limit=2 with offset=0 returns the two newest orders, scene.history.pending then scene.history.paid, with meta { limit: 2, offset: 0, total: 5 }',
    );

    it.todo(
      'limit=2 with offset=2 returns the next two, scene.history.shipped then scene.history.delivered, with meta { limit: 2, offset: 2, total: 5 }',
    );

    it.todo(
      'limit=2 with offset=4 returns the last page, scene.history.cancelled alone, with meta { limit: 2, offset: 4, total: 5 }',
    );

    it.todo(
      'the boundary one past the end: offset=5 with limit=2 returns an empty data array and 200, while meta.total stays 5 and meta.offset stays 5',
    );

    it.todo(
      'far past the end: offset=1000 returns an empty data array and 200, while meta.total stays 5',
    );

    it.todo(
      'no page is skipped or repeated: the three pages of limit=2 concatenated equal the unpaginated list of five, in the same order and with no duplicate id',
    );

    it.todo(
      'meta.total counts the filtered set and not the table: minTotal=4000 with maxTotal=12500 and limit=1 returns scene.history.pending alone but reports meta.total 3',
    );

    it.todo(
      "rejects limit=0 with 400 and the validation problem type, the contract's minimum being 1",
    );

    it.todo(
      "rejects limit=101 with 400 and the validation problem type, the contract's maximum being 100",
    );

    it.todo('rejects offset=-1 with 400 and the validation problem type');
  });

  describe('GET /orders/{orderId}: the detail payload', () => {
    it.todo(
      'returns scene.history.shipped with both of its lines — quantity 2 of "E2E Classic Tee" at unitPrice 4000 for a lineTotal of 8000, and quantity 3 of "E2E Cap" at unitPrice 1500 for a lineTotal of 4500 — plus subtotal 12500, discount 0, total 12500 and status SHIPPED',
    );

    it.todo(
      'every line carries its own skuId, and they are the two SKUs scene.history.skus.tee and scene.history.skus.cap the order was placed from',
    );

    it.todo(
      'the lines are a snapshot and not a join: after repriceAndRename(e2e, scene.history.skus.tee, { productName: "Renamed Tee", price: 9900 }), scene.history.shipped still reports productName "E2E Classic Tee", unitPrice 4000, lineTotal 8000 and total 12500',
    );

    it.todo(
      'returns the shipping address the order was placed with: recipientName "E2E Recipient", line1 "1 Test Street", line2 null, city "Testville", region null and postalCode "00000"',
    );

    it.todo(
      'returns expiresAt as an ISO 8601 string for scene.history.pending, the one PENDING order, and null for scene.history.shipped',
    );

    it.todo(
      'returns paymentMethod null for scene.history.paid: no Payment row exists for any seeded order, so the field is declared and empty rather than absent',
    );

    it.todo(
      'returns createdAt as the ISO 8601 form of the date the order was seeded with, 2025-03-15T10:00:00.000Z for scene.history.shipped',
    );

    it.todo(
      'the detail and the list agree: for scene.history.paid, whose single line leaves no room for the items array to come back in a different order, the entry inside GET /orders is deep-equal to the body of GET /orders/{scene.history.paid.id}',
    );

    it.todo(
      'rejects a malformed order id, MALFORMED_ORDER_ID, with 400 and the validation problem type, before any row is read',
    );
  });

  describe('Authorization: a client reaches their own orders and nothing else', () => {
    it.todo(
      "the owner's list holds their five orders and never scene.strangerOrder, whose total 12 500 is the same as scene.history.shipped's on purpose: a leak would survive an assertion on totals alone",
    );

    it.todo(
      "the stranger's list holds scene.strangerOrder alone, with meta.total 1, although six orders exist in the table",
    );

    it.todo(
      "a MANAGER lists all six orders — the owner's five and the stranger's one — with meta.total 6",
    );

    it.todo(
      'GET /orders/{scene.strangerOrder.id} as the owner answers 404 with the not-found problem type, and never 403',
    );

    it.todo(
      'GET /orders/{scene.history.shipped.id} as the stranger answers 404 with the not-found problem type, and never 403',
    );

    it.todo(
      'GET /orders/{UNKNOWN_ORDER_ID} as the owner answers 404 with the not-found problem type',
    );

    it.todo(
      'the endpoint is not an identifier oracle: as the owner, the response for scene.strangerOrder.id and the response for UNKNOWN_ORDER_ID carry the same status, type, title and detail, so an order id that belongs to somebody cannot be told apart from an invented one — compare the two bodies with `instance` removed, since that member echoes the requested path and differs by construction',
    );

    it.todo(
      'the 404 is scope and not absence: the same scene.strangerOrder.id the owner cannot see answers 200 to scene.manager',
    );
  });

  describe('Unauthenticated access', () => {
    it.todo(
      'GET /orders with no Authorization header answers 401 with the unauthorized problem type and the header WWW-Authenticate: Bearer',
    );

    it.todo(
      'GET /orders/{scene.history.shipped.id} with no Authorization header answers 401 and never 404: the missing credential is reported before the row is looked for',
    );

    it.todo(
      'GET /orders with MALFORMED_ACCESS_TOKEN answers 401 with the unauthorized problem type and a WWW-Authenticate header containing invalid_token',
    );

    it.todo(
      'GET /orders with an expired but correctly signed token, expiredAccessToken(e2e, scene.owner.user), answers 401 with a WWW-Authenticate header containing invalid_token',
    );
  });
});
