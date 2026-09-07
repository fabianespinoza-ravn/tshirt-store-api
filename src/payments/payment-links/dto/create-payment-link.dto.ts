import { IsUUID } from 'class-validator';

/**
 * A Payment Link is created for exactly one variant, and the body says which.
 *
 * There is no price here on purpose. The amount a link charges is the SKU's
 * price at the moment of creation, read from the row inside the service and
 * frozen into `PaymentLink.unitPriceAtCreation`; letting the caller name an
 * amount would make the published link and the catalogue two independent
 * numbers, which is the drift that column exists to prevent.
 *
 * There is no quantity either: the link is created without Stripe's
 * `adjustable_quantity`, so every purchase through it is one unit. See
 * `PAYMENT_LINK_QUANTITY` in `payments/stripe.service.ts`.
 */
export class CreatePaymentLinkDto {
  @IsUUID()
  skuId!: string;
}
