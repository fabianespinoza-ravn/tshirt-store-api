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
   * How the order was paid, once it was. Null through the whole of block 3
   * because nothing writes a `Payment` row yet; the contract declares the
   * field and this is where it starts carrying a value.
   */
  paymentMethod: PaymentMethod | null;
  /** When a PENDING order stops holding its stock. Null once it is not PENDING. */
  expiresAt: string | null;
  createdAt: string;
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
