import {
  CartStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Size,
  UserRole,
} from '@prisma/client';
import { availableOf } from '../../src/catalog/views';
import { newId } from '../../src/common/ids';
import { PENDING_ORDER_TTL_MS } from '../../src/orders/orders.service';
import { IDEMPOTENCY_KEY_TTL_MS } from '../../src/orders/payment-recovery';
import type { E2eApp } from './app';
import {
  signIn,
  signUpVerified,
  someCredentials,
  type Session,
} from './fixtures';
import {
  ORDERS_ROUTE,
  seedOrder,
  seedSku,
  type SeededOrder,
  type SeededSku,
} from './order-fixtures';
import { intentIdFor } from './stripe-stub';

/**
 * The arrangement the checkout flow needs: an active cart with known lines,
 * SKUs with known stock, and pending orders that are either still live or
 * already lapsed.
 *
 * These sit beside `order-fixtures.ts` and reuse its builders rather than
 * repeating them — `seedSku` and `seedOrder` are the same writes, and the
 * order-history suite already proved them against the real database. What is
 * new here is everything checkout reads that history does not: the cart, the
 * `Payment` row, the SKU counters, and the two ways a PENDING order can be
 * standing in the way.
 *
 * As in `fixtures.ts` and `order-fixtures.ts`, a builder that cannot produce
 * what it promises throws. That is setup integrity, not an assertion about
 * behaviour: the assertions live in the *.e2e-spec.ts files and are the
 * student's (CLAUDE.md, Tests).
 */

/** The collection checkout posts to. The same route order history reads. */
export const CHECKOUT_ROUTE = ORDERS_ROUTE;

/**
 * The body of `POST /orders`. `line2` and `region` are deliberately absent:
 * the DTO makes them optional and the order stores null for both, so the
 * address the view answers with is `CHECKOUT_ADDRESS_VIEW` below.
 */
export const CHECKOUT_ADDRESS = {
  recipientName: 'E2E Buyer',
  line1: '2 Checkout Lane',
  city: 'Testville',
  postalCode: '11111',
};

/** `CHECKOUT_ADDRESS` as `OrderView.shippingAddress` serializes it. */
export const CHECKOUT_ADDRESS_VIEW = {
  ...CHECKOUT_ADDRESS,
  line2: null,
  region: null,
};

/**
 * An address whose `recipientName` is the empty string. `@IsNotEmpty()`
 * refuses it, so this is the 400 that proves the DTO rejects `""` and not
 * only a missing key.
 */
export const BLANK_RECIPIENT_ADDRESS = {
  ...CHECKOUT_ADDRESS,
  recipientName: '',
};

/** Integer cents, as money is everywhere in this codebase. */
export const CHECKOUT_PRICES = {
  tee: 4_000,
  cap: 1_500,
};

/** What each seeded SKU carries on the shelf, with `reserved` starting at zero. */
export const CHECKOUT_STOCK = {
  tee: 10,
  cap: 10,
};

/** The shopper's cart: 2 tees and 3 caps. */
export const CHECKOUT_QUANTITIES = {
  tee: 2,
  cap: 3,
};

/** 2 x 4 000 + 3 x 1 500, in integer cents. */
export const CHECKOUT_TOTAL =
  CHECKOUT_PRICES.tee * CHECKOUT_QUANTITIES.tee +
  CHECKOUT_PRICES.cap * CHECKOUT_QUANTITIES.cap;

/** The stranger's cart: 1 tee, 4 000 cents. */
export const STRANGER_QUANTITIES = { tee: 1 };

/** 1 x 4 000, in integer cents. */
export const STRANGER_CART_TOTAL =
  CHECKOUT_PRICES.tee * STRANGER_QUANTITIES.tee;

// ─── Carts ────────────────────────────────────────────────────────────────

export interface SeedCartLine {
  sku: SeededSku;
  quantity: number;
}

export interface SeedCartOptions {
  /** The owner. `Cart.userId` is the column the CLIENT ability scopes on. */
  userId: string;
  /** Empty by default, which is the cart checkout refuses. */
  lines?: SeedCartLine[];
  /** ACTIVE by default; a CHECKED_OUT cart is what a spent one looks like. */
  status?: CartStatus;
}

export interface SeededCartLine {
  skuId: string;
  quantity: number;
  /** The SKU's price when the cart was seeded, in integer cents. */
  unitPrice: number;
  /** `unitPrice * quantity`, in integer cents. */
  lineTotal: number;
}

export interface SeededCart {
  id: string;
  userId: string;
  status: CartStatus;
  lines: SeededCartLine[];
  /** What checkout would price this cart at right now, in integer cents. */
  subtotal: number;
}

/**
 * One cart with its lines, written straight into the database.
 *
 * Seeded rather than filled over HTTP on purpose. `CartService.addItem`
 * refuses a line above availability, so a cart that outgrew its stock — the
 * arrangement the `stock-unavailable` refusal needs — cannot be built through
 * the API at all. Seeding also keeps a case's arrangement to one statement
 * instead of one request per line.
 *
 * `activeUserId` mirrors `userId` while the cart is ACTIVE and is null once
 * it is not: that is the whole of `uq_carts_user_active`, and a seeded cart
 * that ignored it would let a user hold two active carts, which the
 * application can never produce.
 */
export async function seedCart(
  e2e: E2eApp,
  options: SeedCartOptions,
): Promise<SeededCart> {
  const status = options.status ?? CartStatus.ACTIVE;
  const cartId = newId();
  const lines: SeededCartLine[] = (options.lines ?? []).map((line) => ({
    skuId: line.sku.id,
    quantity: line.quantity,
    unitPrice: line.sku.price,
    lineTotal: line.sku.price * line.quantity,
  }));

  await e2e.prisma.cart.create({
    data: {
      id: cartId,
      userId: options.userId,
      status,
      activeUserId: status === CartStatus.ACTIVE ? options.userId : null,
      items: {
        create: lines.map((line) => ({
          id: newId(),
          skuId: line.skuId,
          quantity: line.quantity,
        })),
      },
    },
  });

  return {
    id: cartId,
    userId: options.userId,
    status,
    lines,
    subtotal: lines.reduce((sum, line) => sum + line.lineTotal, 0),
  };
}

/**
 * An ACTIVE cart with no lines: a client who opened a cart and took
 * everything back out. Checkout refuses it with `cart-not-checkoutable`, the
 * same problem a client with no cart at all receives.
 */
export function seedEmptyCart(
  e2e: E2eApp,
  userId: string,
): Promise<SeededCart> {
  return seedCart(e2e, { userId, lines: [] });
}

// ─── Payments ─────────────────────────────────────────────────────────────

export interface SeedPaymentOptions {
  /** Defaults to `intentIdFor(orderId)`, which is the id the stub answers with. */
  intentId?: string | null;
  /** Integer cents. Defaults to the order's total. */
  amount?: number;
  status?: PaymentStatus;
  method?: PaymentMethod;
}

export interface SeededPayment {
  id: string;
  orderId: string;
  stripePaymentIntentId: string | null;
  amount: number;
  status: PaymentStatus;
  method: PaymentMethod;
}

/**
 * The row checkout writes once Stripe has answered: the attempt, PENDING,
 * carrying the intent's id.
 *
 * It is what `intentToCancel` looks for. With this row a lapsed order's
 * intent is *read* and cancelled; without it, and inside
 * `IDEMPOTENCY_KEY_TTL_MS`, the intent is asked for again — the same one
 * comes back because the order's id is the idempotency key — and only then
 * cancelled. The two paths differ by one call to `createPaymentIntent`, which
 * `StripeStub.createdFor` counts.
 */
export async function seedPayment(
  e2e: E2eApp,
  order: { id: string; total: number },
  options: SeedPaymentOptions = {},
): Promise<SeededPayment> {
  const row = {
    id: newId(),
    orderId: order.id,
    method: options.method ?? PaymentMethod.PAYMENT_INTENT,
    status: options.status ?? PaymentStatus.PENDING,
    amount: options.amount ?? order.total,
    stripePaymentIntentId:
      options.intentId === undefined ? intentIdFor(order.id) : options.intentId,
  };

  await e2e.prisma.payment.create({ data: row });

  return row;
}

// ─── Pending orders, live and lapsed ──────────────────────────────────────

/**
 * How far past its expiry a lapsed order stands. Fifteen minutes is
 * arbitrary and only has to be positive: what matters is that `expiresAt` is
 * in the past by the time the request runs.
 */
export const LAPSED_BY_MS = 15 * 60 * 1_000;

/**
 * How long ago a lapsed order was placed by default: the pending TTL plus
 * `LAPSED_BY_MS`, so `seedOrder`'s own `placedAt + PENDING_ORDER_TTL_MS`
 * expiry lands fifteen minutes ago.
 */
export const LAPSED_PLACED_AGO_MS = PENDING_ORDER_TTL_MS + LAPSED_BY_MS;

/**
 * How long ago an order has to have been placed for its idempotency key to
 * be gone. One hour past `IDEMPOTENCY_KEY_TTL_MS`, so an order with no
 * recorded intent is beyond recovery and nothing may be released for it.
 */
export const STALE_PLACED_AGO_MS = IDEMPOTENCY_KEY_TTL_MS + 60 * 60 * 1_000;

export interface SeedPendingOrderOptions {
  userId: string;
  lines: { sku: SeededSku; quantity: number }[];
  /**
   * Whether a `Payment` row records the intent. True by default, which is
   * what a checkout that ran to completion leaves behind; false reproduces
   * the window between the order's commit and that row.
   */
  withRecordedIntent?: boolean;
  /** Defaults to `LAPSED_PLACED_AGO_MS`. */
  placedAgoMs?: number;
}

export interface SeededPendingOrder {
  order: SeededOrder;
  /** The instant the order stops holding its stock. */
  expiresAt: Date;
  /** The recorded attempt, or null when none was seeded. */
  payment: SeededPayment | null;
}

/**
 * A PENDING order whose expiry has already passed, holding its lines'
 * reservations.
 *
 * This is the returning customer's obstacle: `stopLapsedPayment` finds it,
 * stops its payment, and only then may `settlePendingOrder` cancel it and
 * give its units back. Seeded rather than checked out and waited on, because
 * the pending TTL is thirty minutes and no suite can wait that long.
 */
export async function seedLapsedPendingOrder(
  e2e: E2eApp,
  options: SeedPendingOrderOptions,
): Promise<SeededPendingOrder> {
  const placedAt = new Date(
    Date.now() - (options.placedAgoMs ?? LAPSED_PLACED_AGO_MS),
  );
  const seeded = await seedPending(e2e, options, placedAt);

  if (seeded.expiresAt > new Date()) {
    throw new Error(
      `seedLapsedPendingOrder: expiry ${seeded.expiresAt.toISOString()} has not passed`,
    );
  }

  return seeded;
}

/**
 * A PENDING order placed just now, whose expiry is still ahead of it.
 *
 * Checkout must refuse a second order while this one stands, and the refusal
 * carries the instant on `expiresAt` so the client can choose between paying
 * and waiting.
 */
export async function seedLivePendingOrder(
  e2e: E2eApp,
  options: SeedPendingOrderOptions,
): Promise<SeededPendingOrder> {
  const seeded = await seedPending(e2e, options, new Date());

  if (seeded.expiresAt <= new Date()) {
    throw new Error(
      `seedLivePendingOrder: expiry ${seeded.expiresAt.toISOString()} has already passed`,
    );
  }

  return seeded;
}

async function seedPending(
  e2e: E2eApp,
  options: SeedPendingOrderOptions,
  placedAt: Date,
): Promise<SeededPendingOrder> {
  const order = await seedOrder(e2e, {
    userId: options.userId,
    status: OrderStatus.PENDING,
    placedAt,
    lines: options.lines,
  });

  const row = await e2e.prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { expiresAt: true },
  });
  if (!row.expiresAt) {
    throw new Error('seedPending: a pending order was written with no expiry');
  }

  const payment =
    (options.withRecordedIntent ?? true) ? await seedPayment(e2e, order) : null;

  return { order, expiresAt: row.expiresAt, payment };
}

// ─── Reading back what the request wrote ──────────────────────────────────

export interface SkuCounts {
  stock: number;
  reserved: number;
  /** `stock - reserved`, the number `src/catalog/views.ts` calls available. */
  available: number;
}

/**
 * The two counters a reservation moves, plus the difference between them.
 *
 * Read through `availableOf` rather than subtracted here, so a change to what
 * "available" means reaches the suite instead of being restated in it.
 */
export async function skuCountsOf(
  e2e: E2eApp,
  skuId: string,
): Promise<SkuCounts> {
  const sku = await e2e.prisma.sku.findUniqueOrThrow({
    where: { id: skuId },
    select: { stock: true, reserved: true },
  });

  return { ...sku, available: availableOf(sku) };
}

/**
 * Moves the shelf under a cart that was filled earlier: the arrangement
 * `CartService` refuses to build, and the one checkout's own re-read of the
 * SKU exists to catch.
 */
export async function setSkuCounts(
  e2e: E2eApp,
  sku: SeededSku,
  counts: { stock?: number; reserved?: number },
): Promise<SkuCounts> {
  await e2e.prisma.sku.update({ where: { id: sku.id }, data: counts });

  return skuCountsOf(e2e, sku.id);
}

/**
 * Takes a SKU's product off sale under a cart that already names it.
 *
 * Two ways, because `placeOrder` refuses both and they are different columns:
 * `isActive: false` is a manager unpublishing, `deletedAt` is a soft delete.
 * Either one turns the line into the `item-withdrawn` refusal, and neither is
 * reachable through the cart routes — `CartService.addItem` filters
 * soft-deleted products out before a line can be created.
 */
export async function withdrawProduct(
  e2e: E2eApp,
  sku: SeededSku,
  how: { deactivate?: boolean; softDelete?: boolean } = { deactivate: true },
): Promise<void> {
  await e2e.prisma.product.update({
    where: { id: sku.productId },
    data: {
      ...(how.deactivate ? { isActive: false } : {}),
      ...(how.softDelete ? { deletedAt: new Date() } : {}),
    },
  });
}

/** The order row as the database holds it, or null when nothing was written. */
export function orderRowOf(e2e: E2eApp, orderId: string) {
  return e2e.prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, statusHistory: { orderBy: { sequence: 'asc' } } },
  });
}

/** Every order one user has, newest first — the count checkout must not inflate. */
export function ordersOf(e2e: E2eApp, userId: string) {
  return e2e.prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

/** The cart row, for the CHECKED_OUT status and the cleared mirror column. */
export function cartRowOf(e2e: E2eApp, cartId: string) {
  return e2e.prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: true },
  });
}

/** The caller's active cart, or null once checkout has spent it. */
export function activeCartOf(e2e: E2eApp, userId: string) {
  return e2e.prisma.cart.findFirst({
    where: { userId, status: CartStatus.ACTIVE },
    include: { items: true },
  });
}

/** Every payment attempt on one order, newest first. */
export function paymentsOf(e2e: E2eApp, orderId: string) {
  return e2e.prisma.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
  });
}

// ─── Sessions ─────────────────────────────────────────────────────────────

/**
 * A signed-in user of one role.
 *
 * The role is set on the row before signing in, deliberately: `JwtAuthGuard`
 * takes it from the access token and never re-reads the user, so a promotion
 * afterwards would leave a token that still says CLIENT.
 */
export async function signInWithRole(
  e2e: E2eApp,
  role: UserRole,
): Promise<Session> {
  const credentials = await signUpVerified(e2e, someCredentials());

  if (role !== UserRole.CLIENT) {
    await e2e.prisma.user.update({
      where: { liveEmail: credentials.email },
      data: { role },
    });
  }

  return signIn(e2e, credentials);
}

/** A CLIENT with no cart and no orders: the caller checkout has nothing to sell. */
export function signInClient(e2e: E2eApp): Promise<Session> {
  return signInWithRole(e2e, UserRole.CLIENT);
}

// ─── The scene ────────────────────────────────────────────────────────────

export interface CheckoutScene {
  /** The CLIENT whose active cart `cart` describes. */
  shopper: Session;
  /** Another CLIENT, with an active cart of their own and no claim on the shopper's. */
  stranger: Session;
  skus: { tee: SeededSku; cap: SeededSku };
  /** The shopper's: 2 tees and 3 caps, subtotal 12 500. */
  cart: SeededCart;
  /** The stranger's: 1 tee, subtotal 4 000, on the same SKU as the shopper's. */
  strangerCart: SeededCart;
}

/**
 * Two shoppers, two active carts and two SKUs with room to spare.
 *
 *   sku   price (cents)   stock   reserved   the shopper's cart   the stranger's
 *   tee           4 000      10          0            2 units          1 unit
 *   cap           1 500      10          0            3 units               —
 *
 * so the shopper's cart prices at 2 x 4 000 + 3 x 1 500 = 12 500 cents and
 * the stranger's at 4 000.
 *
 * The stranger's line is on the *same* tee on purpose. A cart is not a
 * reservation, so after the shopper checks out `tee.reserved` is 2 and not 3:
 * an implementation that reserved on adding to a cart would be caught by that
 * one number, and one that consumed whatever active cart it found first would
 * be caught by the stranger's cart still being ACTIVE with its line intact.
 *
 * Stock is ten against a cart of five, so nothing here is near the boundary.
 * The `stock-unavailable` refusal moves the shelf with `setSkuCounts` instead,
 * which states in the case itself what number the refusal is about.
 */
export async function arrangeCheckout(e2e: E2eApp): Promise<CheckoutScene> {
  const shopper = await signIn(e2e, await signUpVerified(e2e));
  const stranger = await signIn(e2e, await signUpVerified(e2e));

  const tee = await seedSku(e2e, {
    productName: 'E2E Checkout Tee',
    price: CHECKOUT_PRICES.tee,
    stock: CHECKOUT_STOCK.tee,
  });
  const cap = await seedSku(e2e, {
    productName: 'E2E Checkout Cap',
    price: CHECKOUT_PRICES.cap,
    stock: CHECKOUT_STOCK.cap,
    size: Size.L,
  });

  const cart = await seedCart(e2e, {
    userId: shopper.user.id,
    lines: [
      { sku: tee, quantity: CHECKOUT_QUANTITIES.tee },
      { sku: cap, quantity: CHECKOUT_QUANTITIES.cap },
    ],
  });
  const strangerCart = await seedCart(e2e, {
    userId: stranger.user.id,
    lines: [{ sku: tee, quantity: STRANGER_QUANTITIES.tee }],
  });

  const scene: CheckoutScene = {
    shopper,
    stranger,
    skus: { tee, cap },
    cart,
    strangerCart,
  };

  await assertScene(e2e, scene);

  return scene;
}

/**
 * The table in the doc comment above is what every case name in
 * `checkout.e2e-spec.ts` quotes. A drift between the two would leave the
 * stubs naming totals and counters the data no longer produces, so the
 * arithmetic is checked once, here, where a wrong fixture fails as a wrong
 * fixture rather than as a mysteriously red assertion.
 */
async function assertScene(e2e: E2eApp, scene: CheckoutScene): Promise<void> {
  if (scene.cart.subtotal !== CHECKOUT_TOTAL) {
    throw new Error(
      `arrangeCheckout: the cart prices at ${scene.cart.subtotal}, expected ${CHECKOUT_TOTAL}`,
    );
  }
  if (scene.strangerCart.subtotal !== STRANGER_CART_TOTAL) {
    throw new Error(
      `arrangeCheckout: the stranger's cart prices at ${scene.strangerCart.subtotal}, expected ${STRANGER_CART_TOTAL}`,
    );
  }

  for (const [name, sku, wanted] of [
    ['tee', scene.skus.tee, CHECKOUT_QUANTITIES.tee],
    ['cap', scene.skus.cap, CHECKOUT_QUANTITIES.cap],
  ] as const) {
    const counts = await skuCountsOf(e2e, sku.id);
    if (counts.reserved !== 0) {
      throw new Error(
        `arrangeCheckout: ${name} starts with ${counts.reserved} reserved, expected none`,
      );
    }
    if (counts.available < wanted) {
      throw new Error(
        `arrangeCheckout: ${name} has ${counts.available} available, the cart wants ${wanted}`,
      );
    }
  }
}
