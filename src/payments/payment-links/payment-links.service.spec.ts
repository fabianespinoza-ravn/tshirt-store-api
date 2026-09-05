import type { PaymentLink, Product, Sku } from '@prisma/client';
import type Stripe from 'stripe';
import { newId } from '../../common/ids';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { aProduct, aSku } from '../../testing/factories';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { PaymentLinksService } from './payment-links.service';
import type { StripeService } from '../stripe.service';

const now = () => new Date('2026-08-28T12:00:00.000Z');

/**
 * Local fixtures rather than additions to `testing/factories.ts`: nothing
 * outside this module builds a `PaymentLink` yet, and a factory nobody else
 * calls is a shared file changed for one caller's benefit.
 */
function aPaymentLinkRow(
  skuId: string,
  overrides: Partial<PaymentLink> = {},
): PaymentLink {
  return {
    id: newId(),
    skuId,
    stripePaymentLinkId: 'plink-existing',
    url: 'https://pay.stripe.test/plink-existing',
    unitPriceAtCreation: 2599,
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

/**
 * The two fields this service reads off Stripe's answer, in the shape the
 * SDK returns them. The cast is the same one `testing/build-service.ts` uses
 * for the payment intent: a real `Stripe.PaymentLink` has some ninety fields
 * and none of the others is reachable from here.
 */
function aStripeLink(overrides: Partial<Stripe.PaymentLink> = {}) {
  return {
    id: 'plink-new',
    url: 'https://pay.stripe.test/plink-new',
    ...overrides,
  } as Awaited<ReturnType<StripeService['createPaymentLink']>>;
}

describe('PaymentLinksService', () => {
  let harness: ServiceHarness<PaymentLinksService>;
  let product: Product;
  let sku: Sku;

  beforeAll(async () => {
    harness = await buildService(PaymentLinksService);
  });

  beforeEach(() => {
    resetPrismaMock(harness.prisma);
    jest.clearAllMocks();

    product = aProduct();
    sku = aSku(product.id, { price: 2599 });

    // The ordinary run: a live SKU with no link yet, and a Stripe that
    // answers. Every case below states only the fact it changes.
    harness.prisma.sku.findFirst.mockResolvedValue({
      ...sku,
      product,
    } as never);
    harness.prisma.paymentLink.findFirst.mockResolvedValue(null);
    harness.prisma.paymentLink.create.mockResolvedValue(
      aPaymentLinkRow(sku.id, {
        stripePaymentLinkId: 'plink-new',
        url: 'https://pay.stripe.test/plink-new',
      }),
    );
    harness.stripe.createPaymentLink.mockResolvedValue(aStripeLink());
    harness.stripe.deactivatePaymentLink.mockResolvedValue(true);
  });

  describe('creating a link', () => {
    it.todo(
      'asks Prisma for the SKU by id joined to a product that is not soft-deleted',
    );

    it.todo(
      'sends Stripe the SKU price in cents, the product name and the SKU id as metadata',
    );

    it.todo(
      'uses the id it is about to write as the Stripe idempotency key, so a retry reaches one link',
    );

    it.todo(
      'writes stripePaymentLinkId, url and unitPriceAtCreation from the SKU price read before the call',
    );

    it.todo('writes the row with isActive true');

    it.todo('answers created true so the controller can send 201');
  });

  describe('the one active link per SKU', () => {
    it.todo(
      'returns the existing active link with created false and never calls Stripe',
    );

    it.todo(
      'queries paymentLink.findFirst on skuId and isActive true, not on the SKU alone',
    );

    it.todo(
      'checks again inside the Serializable transaction, after Stripe has answered',
    );

    it.todo(
      'deactivates the link it just created at Stripe when the second check finds one',
    );

    it.todo(
      'still answers with the winning row when the deactivation at Stripe fails',
    );

    it.todo(
      'deactivates the Stripe link and re-raises when the write transaction throws',
    );

    it.todo(
      'leaves no payable Stripe link unrecorded on a P2034 from the write transaction',
    );

    it.todo('opens the write transaction at Serializable isolation');
  });

  describe('a SKU that cannot carry a link', () => {
    it.todo('answers 404 when the SKU does not exist');

    it.todo('answers 404 when the SKU belongs to a soft-deleted product');

    it.todo('answers 404 when the SKU belongs to an inactive product');

    it.todo('never calls Stripe for a SKU it refused');
  });

  describe('when Stripe refuses', () => {
    it.todo('answers 503 for a rate-limited or unavailable Stripe');

    it.todo(
      'answers 500 for a Stripe 4xx, because an upstream status is never ours',
    );

    it.todo('writes no PaymentLink row when the Stripe call failed');
  });

  describe('the price the link records', () => {
    it.todo(
      'records unitPriceAtCreation from the SKU read, not from a later re-read',
    );

    it.todo(
      'publishes unitPriceAtCreation in the view rather than the SKU current price',
    );
  });
});
