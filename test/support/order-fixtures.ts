import { Color, OrderStatus, Size } from '@prisma/client';
import { newId } from '../../src/common/ids';
import { releasesStock } from '../../src/orders/order-state-machine';
import { PENDING_ORDER_TTL_MS } from '../../src/orders/orders.service';
import type { E2eApp } from './app';
import {
  promoteToManager,
  signIn,
  signUpVerified,
  someCredentials,
  type Session,
} from './fixtures';

/**
 * Order rows written straight into the e2e database, for the flows that read
 * order history.
 *
 * These are not `src/testing/factories.ts`. Those build in-memory rows for a
 * mocked Prisma in the unit tests; these open a connection and insert, because
 * an end-to-end suite has to ask the real database for the real page.
 *
 * Nothing here goes through checkout on purpose. Checkout is one order, from
 * one active cart, priced now — so building five orders across five statuses,
 * five dates and five totals through it is impossible, and the one date it
 * could produce is `now()`, which is exactly the column the date filter reads.
 * Seeding is what makes a date range, a status filter and a price range
 * assertable at all.
 *
 * As in `fixtures.ts`, a builder that cannot produce what it promises throws:
 * that is setup integrity, not an assertion about behaviour. The assertions
 * live in the *.e2e-spec.ts files and are the student's (CLAUDE.md, Tests).
 */

/** The shipping address every seeded order carries unless one is passed. */
export const SEEDED_ADDRESS = {
  recipientName: 'E2E Recipient',
  line1: '1 Test Street',
  line2: null as string | null,
  city: 'Testville',
  region: null as string | null,
  postalCode: '00000',
};

export type SeededAddress = typeof SEEDED_ADDRESS;

/** A product with exactly one SKU: the least an order line needs to exist. */
export interface SeededSku {
  id: string;
  productId: string;
  /** The name `OrderItem.productName` is frozen from. */
  productName: string;
  /** Integer cents, as money is everywhere in this codebase. */
  price: number;
  stock: number;
}

export interface SeedSkuOptions {
  productName?: string;
  /** Integer cents. */
  price?: number;
  stock?: number;
  size?: Size;
  color?: Color;
}

let seededSkus = 0;

/**
 * One product, one SKU. Each call makes its own product, so the
 * `uq_skus_product_size_color` unique never collides however many SKUs a test
 * asks for with the same size and colour.
 */
export async function seedSku(
  e2e: E2eApp,
  options: SeedSkuOptions = {},
): Promise<SeededSku> {
  seededSkus += 1;
  const productId = newId();
  const skuId = newId();
  const productName = options.productName ?? `E2E product ${seededSkus}`;
  const price = options.price ?? 2_599;
  const stock = options.stock ?? 100;

  await e2e.prisma.product.create({
    data: {
      id: productId,
      name: productName,
      description: 'Seeded by the end-to-end order fixtures.',
      skus: {
        create: {
          id: skuId,
          size: options.size ?? Size.M,
          color: options.color ?? Color.BLACK,
          price,
          stock,
        },
      },
    },
  });

  return { id: skuId, productId, productName, price, stock };
}

export interface SeedOrderLine {
  sku: SeededSku;
  quantity: number;
  /**
   * The price frozen onto the line, in integer cents. Defaults to the SKU's
   * current price, which is what checkout copies; pass it to seed an order
   * placed before a price change.
   */
  unitPrice?: number;
}

export interface SeedOrderOptions {
  /** The buyer. `Order.userId` is the column the CLIENT ability scopes on. */
  userId: string;
  lines: SeedOrderLine[];
  status?: OrderStatus;
  /**
   * What `Order.createdAt` becomes. `@default(now())` would land every seeded
   * order in the same instant, which is exactly what a date-range filter
   * cannot be tested against.
   */
  placedAt?: Date;
  /**
   * Defaults the way checkout writes it: `placedAt` plus the pending TTL while
   * the order is PENDING, null once it is not. An order seeded as PENDING with
   * a `placedAt` in the past is therefore a *lapsed* one; pass a future date
   * for a pending order that still holds its stock.
   */
  expiresAt?: Date | null;
  deliveredById?: string | null;
  deliveredAt?: Date | null;
  /** Integer cents subtracted from the subtotal to reach the total. */
  discount?: number;
  address?: Partial<SeededAddress>;
  /**
   * Whether the SKUs' `reserved` counters move, mirroring checkout. On by
   * default and faithful to the writes the application makes: checkout
   * increments `reserved`, and only a move to CANCELLED gives it back
   * (`releasesStock`). Order history reads none of this; the checkout suite
   * will.
   */
  holdsStock?: boolean;
}

export interface SeededOrderLine {
  skuId: string;
  productName: string;
  /** Integer cents. */
  unitPrice: number;
  quantity: number;
  /** `unitPrice * quantity`, in integer cents. */
  lineTotal: number;
}

export interface SeededOrder {
  id: string;
  userId: string;
  status: OrderStatus;
  /** The instant written to `createdAt`; the date filter compares against it. */
  placedAt: Date;
  /** Integer cents. */
  subtotal: number;
  /** Integer cents. */
  discount: number;
  /** Integer cents; `subtotal - discount`. */
  total: number;
  lines: SeededOrderLine[];
}

/**
 * One order with its lines and its first status-history row, written in a
 * single nested create so `OrderItem.orderId` never references a parent that
 * does not exist yet.
 */
export async function seedOrder(
  e2e: E2eApp,
  options: SeedOrderOptions,
): Promise<SeededOrder> {
  if (options.lines.length === 0) {
    throw new Error('seedOrder: an order with no lines is not a real order');
  }

  const status = options.status ?? OrderStatus.PENDING;
  const placedAt = options.placedAt ?? new Date();
  const orderId = newId();

  const lines: SeededOrderLine[] = options.lines.map((line) => {
    const unitPrice = line.unitPrice ?? line.sku.price;
    return {
      skuId: line.sku.id,
      productName: line.sku.productName,
      unitPrice,
      quantity: line.quantity,
      lineTotal: unitPrice * line.quantity,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const discount = options.discount ?? 0;
  const total = subtotal - discount;

  await e2e.prisma.order.create({
    data: {
      id: orderId,
      userId: options.userId,
      status,
      createdAt: placedAt,
      expiresAt:
        options.expiresAt !== undefined
          ? options.expiresAt
          : defaultExpiryFor(status, placedAt),
      subtotal,
      orderDiscountAmount: discount,
      total,
      ...SEEDED_ADDRESS,
      ...options.address,
      deliveredById: options.deliveredById ?? null,
      deliveredAt: options.deliveredAt ?? null,
      items: {
        create: lines.map((line) => ({
          id: newId(),
          skuId: line.skuId,
          productName: line.productName,
          unitPrice: line.unitPrice,
          quantity: line.quantity,
          createdAt: placedAt,
        })),
      },
      // `recordStatus` numbers from zero for the first status an order takes,
      // and the seeded order has taken exactly one.
      statusHistory: {
        create: { id: newId(), status, sequence: 0, createdAt: placedAt },
      },
    },
  });

  if ((options.holdsStock ?? true) && !releasesStock(status)) {
    for (const line of lines) {
      await e2e.prisma.sku.update({
        where: { id: line.skuId },
        data: { reserved: { increment: line.quantity } },
      });
    }
  }

  return {
    id: orderId,
    userId: options.userId,
    status,
    placedAt,
    subtotal,
    discount,
    total,
    lines,
  };
}

function defaultExpiryFor(status: OrderStatus, placedAt: Date): Date | null {
  return status === OrderStatus.PENDING
    ? new Date(placedAt.getTime() + PENDING_ORDER_TTL_MS)
    : null;
}

/**
 * The three SKUs the seeded history is priced from. Fixed prices, in integer
 * cents, so every total below is arithmetic a reader can check.
 */
export const HISTORY_PRICES = {
  tee: 4_000,
  hoodie: 12_500,
  cap: 1_500,
};

/**
 * The instant each seeded order was placed. Absolute dates, not offsets from
 * `now()`: a range filter asserted against "three days ago" moves every time
 * the suite runs, and a boundary case has to name an exact instant.
 */
export const HISTORY_DATES = {
  cancelled: new Date('2025-01-10T10:00:00.000Z'),
  delivered: new Date('2025-02-20T10:00:00.000Z'),
  shipped: new Date('2025-03-15T10:00:00.000Z'),
  paid: new Date('2025-04-05T10:00:00.000Z'),
  pending: new Date('2025-05-30T10:00:00.000Z'),
};

export interface OrderHistory {
  /** The five orders newest first — the order `GET /orders` sorts them into. */
  all: SeededOrder[];
  /** 2025-05-30, 5 caps, total 7 500. */
  pending: SeededOrder;
  /** 2025-04-05, 2 hoodies, total 25 000: the dearest and the newest but one. */
  paid: SeededOrder;
  /** 2025-03-15, 2 tees and 3 caps, total 12 500: the only two-line order. */
  shipped: SeededOrder;
  /** 2025-02-20, 1 tee, total 4 000. */
  delivered: SeededOrder;
  /** 2025-01-10, 1 cap, total 1 500: the cheapest and the oldest. */
  cancelled: SeededOrder;
  skus: { tee: SeededSku; hoodie: SeededSku; cap: SeededSku };
}

/**
 * One buyer's history: five orders, five statuses, five dates and five
 * distinct totals, built so each filter has a non-trivial answer.
 *
 *   status   placed       lines                  total (cents)
 *   PENDING    2025-05-30   5 x cap                      7 500
 *   PAID       2025-04-05   2 x hoodie                  25 000
 *   SHIPPED    2025-03-15   2 x tee + 3 x cap           12 500
 *   DELIVERED  2025-02-20   1 x tee                      4 000
 *   CANCELLED  2025-01-10   1 x cap                      1 500
 *
 * Chosen so that the three filters separate different subsets and their
 * combination narrows to exactly one row:
 *
 *   placedFrom 2025-02-01 to placedTo 2025-04-30 -> DELIVERED, SHIPPED, PAID
 *   minTotal 4000 to maxTotal 12500              -> DELIVERED, PENDING, SHIPPED
 *   status SHIPPED                               -> SHIPPED
 *   all three together                           -> SHIPPED alone
 *
 * SHIPPED is also the only order with two lines and with quantities above
 * one, which is what makes it the subject of the detail case.
 */
export async function seedOrderHistory(
  e2e: E2eApp,
  userId: string,
): Promise<OrderHistory> {
  const tee = await seedSku(e2e, {
    productName: 'E2E Classic Tee',
    price: HISTORY_PRICES.tee,
  });
  const hoodie = await seedSku(e2e, {
    productName: 'E2E Hoodie',
    price: HISTORY_PRICES.hoodie,
    size: Size.L,
  });
  const cap = await seedSku(e2e, {
    productName: 'E2E Cap',
    price: HISTORY_PRICES.cap,
    color: Color.NAVY,
  });

  const cancelled = await seedOrder(e2e, {
    userId,
    status: OrderStatus.CANCELLED,
    placedAt: HISTORY_DATES.cancelled,
    lines: [{ sku: cap, quantity: 1 }],
  });
  const delivered = await seedOrder(e2e, {
    userId,
    status: OrderStatus.DELIVERED,
    placedAt: HISTORY_DATES.delivered,
    lines: [{ sku: tee, quantity: 1 }],
  });
  const shipped = await seedOrder(e2e, {
    userId,
    status: OrderStatus.SHIPPED,
    placedAt: HISTORY_DATES.shipped,
    lines: [
      { sku: tee, quantity: 2 },
      { sku: cap, quantity: 3 },
    ],
  });
  const paid = await seedOrder(e2e, {
    userId,
    status: OrderStatus.PAID,
    placedAt: HISTORY_DATES.paid,
    lines: [{ sku: hoodie, quantity: 2 }],
  });
  const pending = await seedOrder(e2e, {
    userId,
    status: OrderStatus.PENDING,
    placedAt: HISTORY_DATES.pending,
    lines: [{ sku: cap, quantity: 5 }],
  });

  const history: OrderHistory = {
    all: [pending, paid, shipped, delivered, cancelled],
    pending,
    paid,
    shipped,
    delivered,
    cancelled,
    skus: { tee, hoodie, cap },
  };

  assertSeeded(history);

  return history;
}

/**
 * The table in the doc comment above is what every case name in
 * `order-history.e2e-spec.ts` quotes. A drift between the two would leave the
 * stubs naming subsets the data no longer produces, so the arithmetic is
 * checked once, here, where a wrong fixture fails as a wrong fixture rather
 * than as a mysteriously red assertion.
 */
function assertSeeded(history: OrderHistory): void {
  const expected: [OrderStatus, number][] = [
    [OrderStatus.PENDING, 7_500],
    [OrderStatus.PAID, 25_000],
    [OrderStatus.SHIPPED, 12_500],
    [OrderStatus.DELIVERED, 4_000],
    [OrderStatus.CANCELLED, 1_500],
  ];

  history.all.forEach((order, index) => {
    const [status, total] = expected[index];
    if (order.status !== status || order.total !== total) {
      throw new Error(
        `seedOrderHistory: order ${index} is ${order.status} at ${order.total}, expected ${status} at ${total}`,
      );
    }
  });

  const placed = history.all.map((order) => order.placedAt.getTime());
  const descending = placed.every(
    (time, index) => index === 0 || placed[index - 1] > time,
  );
  if (!descending) {
    throw new Error('seedOrderHistory: the seeded orders are not newest first');
  }
}

/** The collection the order-history flow reads. */
export const ORDERS_ROUTE = '/api/v1/orders';

/** A UUID no row carries, for the "does not exist" half of the 404 pair. */
export const UNKNOWN_ORDER_ID = '00000000-0000-7000-8000-000000000000';

/** Not a UUID at all, for the case `ParseUUIDPipe` refuses. */
export const MALFORMED_ORDER_ID = 'not-a-uuid';

export interface OrderHistoryScene {
  /** The CLIENT whose five orders `history` describes. */
  owner: Session;
  /** Another CLIENT, with one order of their own and no claim on the owner's. */
  stranger: Session;
  /** A MANAGER, who by the matrix sees every order in the store. */
  manager: Session;
  history: OrderHistory;
  /**
   * The stranger's single order, PAID, placed 2025-06-15, total 12 500 — the
   * same total as the owner's SHIPPED one on purpose, so a filter that
   * matched it would be caught by the count and not only by the identifier.
   */
  strangerOrder: SeededOrder;
}

/** The instant the stranger's one order was placed. */
export const STRANGER_ORDER_DATE = new Date('2025-06-15T10:00:00.000Z');

/**
 * The whole cast for the order-history flow, signed in and seeded.
 *
 * Three sessions, because the endpoint answers differently to each: the owner
 * reads their own five, the stranger reads only their one, and the manager
 * reads all six. The stranger exists so "a client sees only their own" is
 * asserted against rows that really are in the table — a filter that leaks
 * nothing because nothing else was seeded proves nothing.
 *
 * The manager is promoted before signing in, deliberately: `JwtAuthGuard`
 * takes the role from the access token and never re-reads the row, so a
 * promotion after sign-in would leave a token that still says CLIENT.
 */
export async function arrangeOrderHistory(
  e2e: E2eApp,
): Promise<OrderHistoryScene> {
  const owner = await signIn(e2e, await signUpVerified(e2e));
  const stranger = await signIn(e2e, await signUpVerified(e2e));

  const managerCredentials = await signUpVerified(e2e, someCredentials());
  await promoteToManager(e2e, managerCredentials.email);
  const manager = await signIn(e2e, managerCredentials);

  const history = await seedOrderHistory(e2e, owner.user.id);

  const strangerSku = await seedSku(e2e, {
    productName: 'E2E Stranger Tee',
    price: HISTORY_PRICES.hoodie,
  });
  const strangerOrder = await seedOrder(e2e, {
    userId: stranger.user.id,
    status: OrderStatus.PAID,
    placedAt: STRANGER_ORDER_DATE,
    lines: [{ sku: strangerSku, quantity: 1 }],
  });

  return { owner, stranger, manager, history, strangerOrder };
}

/**
 * Moves the catalogue out from under an order that was already placed:
 * renames the product and reprices the SKU.
 *
 * `OrderItem.productName` and `OrderItem.unitPrice` are columns written at
 * checkout, not a join through `sku`, and this is the fixture that makes the
 * difference observable. Without it "the line is a snapshot" and "the line
 * reads the SKU" produce the same response, and the case asserts nothing.
 */
export async function repriceAndRename(
  e2e: E2eApp,
  sku: SeededSku,
  changes: { productName: string; price: number },
): Promise<SeededSku> {
  await e2e.prisma.product.update({
    where: { id: sku.productId },
    data: { name: changes.productName },
  });
  await e2e.prisma.sku.update({
    where: { id: sku.id },
    data: { price: changes.price },
  });

  return { ...sku, productName: changes.productName, price: changes.price };
}
