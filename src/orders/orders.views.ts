import type { OrderStatus, PaymentMethod, Prisma } from '@prisma/client';

/**
 * An order line is a snapshot, and that is the declared difference from a
 * cart line. `productName` and `unitPrice` are columns on `OrderItem`,
 * written when the order was placed, so the history survives a rename, a
 * price change or a soft-deleted product. Reading either of them through
 * the `sku` relation would quietly undo that.
 */
export interface OrderItemView {
  id: string;
  skuId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface ShippingAddressView {
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  items: OrderItemView[];
  subtotal: number;
  discount: number;
  total: number;
  shippingAddress: ShippingAddressView;
  /**
   * How the order was paid, once it was. Checkout now writes a `Payment` row
   * as it creates the intent, so a freshly placed order already reads
   * `PAYMENT_INTENT` here — the row records the attempt, and its `status`,
   * not this field, says whether the money arrived.
   */
  paymentMethod: PaymentMethod | null;
  /** When a PENDING order stops holding its stock. Null once it is not PENDING. */
  expiresAt: string | null;
  createdAt: string;
}

/**
 * What checkout answers with, which is an order plus the one thing that only
 * exists at checkout.
 *
 * The secret is not on `OrderView` because it is not a property of the
 * order: it is a short-lived credential for one payment attempt, handed to
 * the browser so the card details go to Stripe and never through this API.
 * Putting it on the shared view would leak it into `GET /orders`, where
 * every past order would carry a credential nobody needs.
 */
export interface CheckoutOrderView extends OrderView {
  clientSecret: string;
}

export const ORDER_INCLUDE = {
  items: true,
  // Ordered, because `Payment[]` allows more than one attempt and an
  // unordered relation would make `paymentMethod` depend on whatever the
  // database happened to return. Newest first, so the view reads the first
  // element rather than trusting a position.
  payments: {
    select: { method: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

export function toOrderItem(item: OrderRow['items'][number]): OrderItemView {
  return {
    id: item.id,
    skuId: item.skuId,
    productName: item.productName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineTotal: item.unitPrice * item.quantity,
  };
}

export function toOrder(order: OrderRow): OrderView {
  return {
    id: order.id,
    status: order.status,
    items: order.items.map(toOrderItem),
    subtotal: order.subtotal,
    discount: order.orderDiscountAmount,
    total: order.total,
    shippingAddress: {
      recipientName: order.recipientName,
      line1: order.line1,
      line2: order.line2,
      city: order.city,
      region: order.region,
      postalCode: order.postalCode,
    },
    // The most recent payment is the one that describes the order, and the
    // include above is what makes "most recent" mean anything. A succeeded
    // one would be the better answer, but `uq_payments_order_succeeded_partial`
    // is still pending, so nothing yet guarantees there is at most one.
    paymentMethod: order.payments[0]?.method ?? null,
    expiresAt: order.expiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * One entry of an order's status history.
 *
 * `sequence` is the contract, not decoration. `recordStatus` numbers every
 * row it appends inside the same transaction that moves the order, so a
 * reader can order the transitions without trusting insertion order or a
 * timestamp: two rows written in the same millisecond still have distinct
 * sequences, and `uq_order_status_history_order_sequence` is what makes that
 * a database guarantee rather than a hope.
 *
 * The row's surrogate `id` is deliberately absent. Nothing addresses a
 * history entry on its own — there is no route for one — so publishing an
 * identifier would invent a resource the contract does not have, and
 * `(orderId, sequence)` already names the row uniquely.
 *
 * `occurredAt` is the row's `createdAt`, renamed because it is the only
 * date an event carries and calling it `createdAt` next to `OrderView`'s
 * would invite reading it as when the order was placed.
 *
 * What is NOT here is `deliveredById`. See the route's own comment in
 * `orders.controller.ts` for why the courier's identity stays out.
 */
export interface OrderStatusEventView {
  status: OrderStatus;
  sequence: number;
  occurredAt: string;
}

/**
 * Exactly the three columns the view publishes. A `select` rather than the
 * whole row, so a column added to `OrderStatusHistory` later does not reach
 * a client because nobody remembered to narrow the query.
 */
export const ORDER_STATUS_EVENT_SELECT = {
  status: true,
  sequence: true,
  createdAt: true,
} satisfies Prisma.OrderStatusHistorySelect;

export type OrderStatusEventRow = Prisma.OrderStatusHistoryGetPayload<{
  select: typeof ORDER_STATUS_EVENT_SELECT;
}>;

export function toOrderStatusEvent(
  event: OrderStatusEventRow,
): OrderStatusEventView {
  return {
    status: event.status,
    sequence: event.sequence,
    occurredAt: event.createdAt.toISOString(),
  };
}
