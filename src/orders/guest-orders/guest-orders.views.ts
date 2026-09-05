import type { OrderStatus, Prisma } from '@prisma/client';

/**
 * What a stranger holding an order id is allowed to see.
 *
 * This is a **separate type and not a narrowed `OrderView`**, for the reason
 * `catalog/views.ts` states about `PublicSkuView` and `ManagerSkuView`: one
 * type with optional fields validates against the contract whichever fields
 * are present, so only distinct types plus a field-by-field test can stop a
 * leak. Building this by deleting keys from an order view would put the
 * whole of `Order` one forgotten `delete` away from the public internet.
 *
 * **What is deliberately absent, and why.** The route is public — the matrix
 * says "the URL is the credential" — so the id *is* the secret and everything
 * this returns is readable by anyone who obtains or guesses one. So:
 *
 *   - No `shippingAddress` and no `recipientName`. A person's name and home
 *     address are the most damaging thing an order carries and the only
 *     fields here that identify a human being. The buyer already knows their
 *     own address; nobody else needs it, and a guessed id must not hand it
 *     over.
 *   - No buyer identity of any kind: no `userId`, no email. A link buyer may
 *     have had an account created for them by the settlement handler, and
 *     confirming that an address has one is itself a disclosure.
 *   - No payment identifiers. `stripeCheckoutSessionId` and
 *     `stripePaymentIntentId` are handles on a real payment at Stripe, and a
 *     public route is the last place to publish one.
 *   - No `expiresAt`. It is null on every order this route can reach, and
 *     publishing a field that is structurally always null only invites a
 *     client to depend on it.
 *
 * What is left is what a buyer checking on a purchase actually needs: what
 * they bought, what it cost, and where the order has got to.
 */
export interface GuestOrderItemView {
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface GuestOrderView {
  id: string;
  status: OrderStatus;
  items: GuestOrderItemView[];
  total: number;
  placedAt: string;
}

/**
 * The columns the query asks for, which are exactly the ones the view
 * publishes.
 *
 * It is a `select` and not an `include` on purpose: an `include` would fetch
 * the whole row and leave the projection as the only thing between the
 * address and the response. With this, the address never leaves Postgres.
 */
export const GUEST_ORDER_SELECT = {
  id: true,
  status: true,
  total: true,
  createdAt: true,
  items: {
    select: { productName: true, quantity: true, unitPrice: true },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.OrderSelect;

export type GuestOrderRow = Prisma.OrderGetPayload<{
  select: typeof GUEST_ORDER_SELECT;
}>;

export function toGuestOrder(order: GuestOrderRow): GuestOrderView {
  return {
    id: order.id,
    status: order.status,
    items: order.items.map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.unitPrice * item.quantity,
    })),
    total: order.total,
    placedAt: order.createdAt.toISOString(),
  };
}
