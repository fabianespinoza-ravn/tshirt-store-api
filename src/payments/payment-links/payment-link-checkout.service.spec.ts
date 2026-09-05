import type { PaymentLink, Product, Sku } from '@prisma/client';
import type Stripe from 'stripe';
import { newId } from '../../common/ids';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { aProduct, aSku } from '../../testing/factories';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { PaymentLinkCheckoutService } from './payment-link-checkout.service';

const now = () => new Date('2026-08-28T12:00:00.000Z');

const BUYER_EMAIL = 'buyer@example.invalid';

function aPaymentLinkRow(
  skuId: string,
  overrides: Partial<PaymentLink> = {},
): PaymentLink {
  return {
    id: newId(),
    skuId,
    stripePaymentLinkId: 'plink-1',
    url: 'https://pay.stripe.test/plink-1',
    unitPriceAtCreation: 2599,
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

/**
 * A completed Checkout Session, cast down to the fields this handler reads.
 *
 * Exported, along with `aCheckoutEvent` below, because nothing reads them
 * until the cases are written: they are the half of the scaffold that is
 * finished, and exporting says so rather than leaving them to be deleted as
 * dead code.
 *
 * Only the fields the service touches are spelled out. A real session
 * carries around eighty more, and listing them would say this test knows
 * something about them that it does not.
 */
export function aCompletedSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs-1',
    payment_status: 'paid',
    payment_link: 'plink-1',
    payment_intent: 'pi-1',
    amount_total: 2599,
    customer_details: {
      email: BUYER_EMAIL,
      name: 'Ada Lovelace',
      address: {
        line1: '1 Analytical Street',
        line2: null,
        city: 'London',
        state: null,
        postal_code: 'E1 6AN',
        country: 'GB',
      },
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

/**
 * The event as the dispatcher will hand it over: already verified against
 * the raw body, already deduplicated on `WebhookEvent.stripeEventId`. The
 * service asserts neither, so neither is modelled here.
 */
export function aCheckoutEvent(
  session: Stripe.Checkout.Session,
  type = 'checkout.session.completed',
): Stripe.Event {
  return {
    id: 'evt-1',
    type,
    data: { object: session },
  } as unknown as Stripe.Event;
}

describe('PaymentLinkCheckoutService', () => {
  let harness: ServiceHarness<PaymentLinkCheckoutService>;
  let product: Product;
  let sku: Sku;
  let link: PaymentLink;

  beforeAll(async () => {
    harness = await buildService(PaymentLinkCheckoutService);
  });

  beforeEach(() => {
    resetPrismaMock(harness.prisma);
    jest.clearAllMocks();

    product = aProduct();
    sku = aSku(product.id, { price: 2599, stock: 10, reserved: 0 });
    link = aPaymentLinkRow(sku.id);

    // The ordinary settlement: our link, stock on the shelf, a buyer with
    // no account yet.
    harness.prisma.payment.findUnique.mockResolvedValue(null);
    harness.prisma.paymentLink.findUnique.mockResolvedValue({
      ...link,
      sku: { ...sku, product },
    } as never);
    harness.prisma.sku.findUnique.mockResolvedValue(sku);
    harness.prisma.user.findUnique.mockResolvedValue(null);
    harness.prisma.orderStatusHistory.count.mockResolvedValue(0);
  });

  describe('the events it does not own', () => {
    it.todo(
      'answers null for an event type other than checkout.session.completed',
    );

    it.todo(
      'answers null for a completed session whose payment_status is not paid',
    );

    it.todo(
      'settles checkout.session.async_payment_succeeded once the delayed method pays',
    );

    it.todo('answers null for a session that names no payment link');

    it.todo('answers null for a payment link this API never wrote a row for');

    it.todo('writes nothing at all for any of those');
  });

  describe('the order it creates', () => {
    it.todo('writes the order as PAID when the SKU has stock');

    it.todo(
      'prices the line from PaymentLink.unitPriceAtCreation, not from the SKU current price',
    );

    it.todo('writes one line of PAYMENT_LINK_QUANTITY units');

    it.todo('snapshots the product name onto the order line');

    it.todo('writes subtotal and total equal, with no discount');

    it.todo('writes expiresAt null, because the order was never PENDING');

    it.todo(
      'writes the address from customer_details and blanks the fields Stripe omitted',
    );

    it.todo('appends the order status history row for the status it wrote');

    it.todo('opens one Serializable transaction for the whole settlement');
  });

  describe('the stock it moves', () => {
    it.todo('decrements Sku.stock by the quantity sold');

    it.todo(
      'leaves Sku.reserved untouched, because a paid order holds nothing',
    );

    it.todo(
      'reads the SKU again inside the transaction rather than trusting the link row',
    );

    it.todo(
      'treats availability as stock minus reserved, so units held by a pending order are not sold twice',
    );
  });

  describe('the purchases it refuses to fulfil', () => {
    it.todo(
      'writes the order as FAILED when availability is below the quantity',
    );

    it.todo(
      'writes FAILED when the units are only held by a reservation, not sold',
    );

    it.todo('writes FAILED when the product has been soft-deleted');

    it.todo('writes FAILED when the product is no longer active');

    it.todo(
      'writes FAILED when Stripe charged an amount the link does not account for',
    );

    it.todo('moves no stock in any of those cases');

    it.todo(
      'still writes the payment as SUCCEEDED, because the money did arrive',
    );

    it.todo('answers with the FAILED status so the caller can act on it');
  });

  describe('the payment row', () => {
    it.todo('writes method PAYMENT_LINK');

    it.todo('writes the checkout session id and the payment intent id');

    it.todo(
      'writes the amount Stripe charged rather than the amount the link records',
    );
  });

  describe('the buyer', () => {
    it.todo('creates a GUEST user with no password hash for a new email');

    it.todo(
      'looks the buyer up by liveEmail, so a soft-deleted row is skipped',
    );

    it.todo('attaches the order to an existing account with the same email');

    it.todo(
      'throws a plain Error, not a ProblemException, when the session carries no customer email',
    );
  });

  describe('a redelivered event', () => {
    it.todo(
      'answers with the existing settlement when a Payment already has the session id',
    );

    it.todo('creates no second order and moves no stock on redelivery');
  });
});
