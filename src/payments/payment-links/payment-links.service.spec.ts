import {
  Prisma,
  type PaymentLink,
  type Product,
  type Sku,
} from '@prisma/client';
import type Stripe from 'stripe';
import { newId } from '../../common/ids';
import { Problems } from '../../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { aProduct, aSku } from '../../testing/factories';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { PaymentLinksService } from './payment-links.service';
import type { StripeService } from '../stripe.service';

/* Jest's asymmetric matchers are typed as `any`; the assertions below are
 * deliberately partial Prisma-call checks, not values passed to production. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

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

/** A refusal from Stripe, in the duck-typed shape `stripe.translator.ts` reads. */
const aStripeError = (type: string, statusCode?: number) =>
  statusCode === undefined ? { type } : { type, statusCode };

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
    it('asks Prisma for the SKU by id joined to a product that is not soft-deleted', async () => {
      await harness.service.create({ skuId: sku.id });

      expect(harness.prisma.sku.findFirst).toHaveBeenCalledWith({
        where: { id: sku.id, product: { deletedAt: null } },
        include: { product: true },
      });
    });

    it('sends Stripe the SKU price in cents, the product name and the SKU id as metadata', async () => {
      await harness.service.create({ skuId: sku.id });

      // Exact and not `objectContaining`: the currency, the quantity and the
      // `metadata` wrapper are `StripeService`'s to add, and this is the whole
      // of what the service is allowed to hand it.
      expect(harness.stripe.createPaymentLink).toHaveBeenCalledWith({
        requestId: expect.any(String),
        skuId: sku.id,
        productName: product.name,
        unitAmount: sku.price,
      });
    });

    it('uses the id it is about to write as the Stripe idempotency key, so a retry reaches one link', async () => {
      await harness.service.create({ skuId: sku.id });

      const [stripeParams] = harness.stripe.createPaymentLink.mock.calls[0];
      const [createArgs] = harness.prisma.paymentLink.create.mock.calls[0];

      expect(typeof stripeParams.requestId).toBe('string');
      expect(createArgs.data.id).toBe(stripeParams.requestId);
    });

    it('writes stripePaymentLinkId, url and unitPriceAtCreation from the SKU price read before the call', async () => {
      await harness.service.create({ skuId: sku.id });

      expect(harness.prisma.paymentLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          skuId: sku.id,
          stripePaymentLinkId: 'plink-new',
          url: 'https://pay.stripe.test/plink-new',
          unitPriceAtCreation: sku.price,
        }),
      });
    });

    it('writes the row with isActive true', async () => {
      await harness.service.create({ skuId: sku.id });

      expect(harness.prisma.paymentLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isActive: true }),
      });
    });

    it('answers created true so the controller can send 201', async () => {
      await expect(
        harness.service.create({ skuId: sku.id }),
      ).resolves.toMatchObject({ created: true });
    });
  });

  describe('the one active link per SKU', () => {
    it('returns the existing active link with created false and never calls Stripe', async () => {
      const existing = aPaymentLinkRow(sku.id);
      harness.prisma.paymentLink.findFirst.mockResolvedValue(existing);

      const { link, created } = await harness.service.create({
        skuId: sku.id,
      });

      expect(created).toBe(false);
      expect(link.id).toBe(existing.id);
      expect(link.stripePaymentLinkId).toBe(existing.stripePaymentLinkId);
      expect(harness.stripe.createPaymentLink).not.toHaveBeenCalled();
      expect(harness.prisma.paymentLink.create).not.toHaveBeenCalled();
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('queries paymentLink.findFirst on skuId and isActive true, not on the SKU alone', async () => {
      await harness.service.create({ skuId: sku.id });

      expect(harness.prisma.paymentLink.findFirst).toHaveBeenCalledWith({
        where: { skuId: sku.id, isActive: true },
      });
    });

    it('checks again inside the Serializable transaction, after Stripe has answered', async () => {
      await harness.service.create({ skuId: sku.id });

      expect(harness.prisma.paymentLink.findFirst).toHaveBeenCalledTimes(2);

      // Directional, so it cannot hold whichever order the code happens to
      // use: the first check is before Stripe, the transaction is opened
      // after Stripe answered, and the second check is inside it.
      const [firstCheck, secondCheck] =
        harness.prisma.paymentLink.findFirst.mock.invocationCallOrder;
      const [stripeCall] =
        harness.stripe.createPaymentLink.mock.invocationCallOrder;
      const [transaction] =
        harness.prisma.$transaction.mock.invocationCallOrder;

      expect(firstCheck).toBeLessThan(stripeCall);
      expect(stripeCall).toBeLessThan(transaction);
      expect(transaction).toBeLessThan(secondCheck);
    });

    it('deactivates the link it just created at Stripe when the second check finds one', async () => {
      const raced = aPaymentLinkRow(sku.id, {
        stripePaymentLinkId: 'plink-raced',
      });
      harness.prisma.paymentLink.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raced);

      const { link, created } = await harness.service.create({
        skuId: sku.id,
      });

      expect(harness.stripe.deactivatePaymentLink).toHaveBeenCalledWith(
        'plink-new',
      );
      expect(harness.prisma.paymentLink.create).not.toHaveBeenCalled();
      expect(created).toBe(false);
      expect(link.stripePaymentLinkId).toBe('plink-raced');
    });

    it('still answers with the winning row when the deactivation at Stripe fails', async () => {
      const raced = aPaymentLinkRow(sku.id, {
        stripePaymentLinkId: 'plink-raced',
      });
      harness.prisma.paymentLink.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raced);
      harness.stripe.deactivatePaymentLink.mockResolvedValue(false);

      const { link, created } = await harness.service.create({
        skuId: sku.id,
      });

      expect(created).toBe(false);
      expect(link.id).toBe(raced.id);
    });

    it('deactivates the Stripe link and re-raises when the write transaction throws', async () => {
      const failure = new Error('the write transaction failed');
      harness.prisma.$transaction.mockRejectedValue(failure);

      await expect(harness.service.create({ skuId: sku.id })).rejects.toBe(
        failure,
      );
      expect(harness.stripe.deactivatePaymentLink).toHaveBeenCalledWith(
        'plink-new',
      );
      expect(harness.stripe.deactivatePaymentLink).toHaveBeenCalledTimes(1);
    });

    it('leaves no payable Stripe link unrecorded on a P2034 from the write transaction', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to a write conflict',
        { code: 'P2034', clientVersion: 'from the harness' },
      );
      harness.prisma.$transaction.mockRejectedValue(conflict);

      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({ code: 'P2034' });

      // The link that was published and never written down is the one thing
      // this branch owes: turned off at Stripe, and the error still raised so
      // the translator can answer the manager.
      expect(harness.stripe.deactivatePaymentLink).toHaveBeenCalledWith(
        'plink-new',
      );
    });

    it('opens the write transaction at Serializable isolation', async () => {
      await harness.service.create({ skuId: sku.id });

      expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(harness.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    });
  });

  describe('a SKU that cannot carry a link', () => {
    it('answers 404 when the SKU does not exist', async () => {
      harness.prisma.sku.findFirst.mockResolvedValue(null);

      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
        detail: 'The variant does not exist, or its product has been deleted.',
      });
    });

    it('answers 404 when the SKU belongs to a soft-deleted product', async () => {
      // The refusal is the `where`, so the `where` is half the assertion: a
      // soft-deleted product is a row Postgres never hands back.
      harness.prisma.sku.findFirst.mockResolvedValue(null);

      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({ kind: Problems.notFound });
      expect(harness.prisma.sku.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ product: { deletedAt: null } }),
        }),
      );
    });

    it('answers 404 when the SKU belongs to an inactive product', async () => {
      harness.prisma.sku.findFirst.mockResolvedValue({
        ...sku,
        product: { ...product, isActive: false },
      } as never);

      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
        // The detail, so this case cannot pass on the other 404: a product
        // that is not for sale is found and then refused.
        detail: 'The variant belongs to a product that is not for sale.',
      });
    });

    it('never calls Stripe for a SKU it refused', async () => {
      harness.prisma.sku.findFirst.mockResolvedValue(null);
      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({ kind: Problems.notFound });

      harness.prisma.sku.findFirst.mockResolvedValue({
        ...sku,
        product: { ...product, isActive: false },
      } as never);
      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({ kind: Problems.notFound });

      expect(harness.stripe.createPaymentLink).not.toHaveBeenCalled();
      expect(harness.prisma.paymentLink.create).not.toHaveBeenCalled();
    });
  });

  describe('when Stripe refuses', () => {
    it('answers 503 for a rate-limited or unavailable Stripe', async () => {
      const unwell = [
        aStripeError('StripeRateLimitError', 429),
        // A connection error carries no status code at all, which is why the
        // type list exists alongside the status list.
        aStripeError('StripeConnectionError'),
        aStripeError('StripeAPIError', 502),
      ];

      for (const error of unwell) {
        harness.stripe.createPaymentLink.mockRejectedValueOnce(error);

        await expect(
          harness.service.create({ skuId: sku.id }),
        ).rejects.toMatchObject({ kind: Problems.serviceUnavailable });
      }
    });

    it('answers 500 for a Stripe 4xx, because an upstream status is never ours', async () => {
      harness.stripe.createPaymentLink.mockRejectedValue(
        aStripeError('StripeInvalidRequestError', 400),
      );

      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({ kind: Problems.internalError });
    });

    it('writes no PaymentLink row when the Stripe call failed', async () => {
      harness.stripe.createPaymentLink.mockRejectedValue(
        aStripeError('StripeAPIError', 500),
      );

      await expect(
        harness.service.create({ skuId: sku.id }),
      ).rejects.toMatchObject({ kind: Problems.serviceUnavailable });

      expect(harness.prisma.paymentLink.create).not.toHaveBeenCalled();
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
      // Nothing was published, so there is nothing to turn off either.
      expect(harness.stripe.deactivatePaymentLink).not.toHaveBeenCalled();
    });
  });

  describe('the price the link records', () => {
    it('records unitPriceAtCreation from the SKU read, not from a later re-read', async () => {
      // The first read is the one the amount comes from; any later read of the
      // same SKU answers with a price edited in between, so a service that
      // re-read would send Stripe 9999 and write it down.
      harness.prisma.sku.findFirst
        .mockResolvedValueOnce({ ...sku, price: 2599, product } as never)
        .mockResolvedValue({ ...sku, price: 9999, product } as never);

      await harness.service.create({ skuId: sku.id });

      expect(harness.stripe.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ unitAmount: 2599 }),
      );
      expect(harness.prisma.paymentLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ unitPriceAtCreation: 2599 }),
      });
    });

    it('publishes unitPriceAtCreation in the view rather than the SKU current price', async () => {
      harness.prisma.paymentLink.create.mockResolvedValue(
        aPaymentLinkRow(sku.id, {
          stripePaymentLinkId: 'plink-new',
          url: 'https://pay.stripe.test/plink-new',
          unitPriceAtCreation: 1999,
        }),
      );

      const { link } = await harness.service.create({ skuId: sku.id });

      expect(link.unitPrice).toBe(1999);
      expect(link.unitPrice).not.toBe(sku.price);
    });
  });

  describe('losing the race to a concurrent create', () => {
    /**
     * Two managers asking at once is an ordinary thing, not a server fault.
     * The transaction that loses is rejected — `Serializable` refusing a
     * conflicting write — and answering 500 for that told the caller
     * something had gone wrong while the SKU did have exactly what they
     * asked for. Only an SKU left with no link at all is a real failure.
     */
    it.todo(
      'answers with the winning link and created false when the transaction is rejected',
    );

    it.todo(
      'deactivates its own orphan link at Stripe before answering with the winner',
    );

    it.todo(
      'raises the original error when the rejection left the SKU with no active link',
    );
  });
});
