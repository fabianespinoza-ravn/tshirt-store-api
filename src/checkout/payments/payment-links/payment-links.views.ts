import type { PaymentLink } from '@prisma/client';

/**
 * What a manager gets back after creating a link.
 *
 * `unitPrice` is `PaymentLink.unitPriceAtCreation` and not the SKU's current
 * price, because they are allowed to differ and the difference is the point:
 * the link outlives a price edit and keeps charging what it was published
 * with. Publishing the live price here would hide exactly the fact the
 * column was added to record.
 *
 * `stripePaymentLinkId` is included because the manager who created the link
 * is the person who will look it up in the Stripe dashboard when a purchase
 * goes wrong. It is not a credential — anyone holding the `url` can already
 * pay — and the route is MANAGER-only anyway.
 */
export interface PaymentLinkView {
  id: string;
  skuId: string;
  stripePaymentLinkId: string;
  url: string;
  unitPrice: number;
  isActive: boolean;
  createdAt: string;
}

export function toPaymentLink(row: PaymentLink): PaymentLinkView {
  return {
    id: row.id,
    skuId: row.skuId,
    stripePaymentLinkId: row.stripePaymentLinkId,
    url: row.url,
    unitPrice: row.unitPriceAtCreation,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}
