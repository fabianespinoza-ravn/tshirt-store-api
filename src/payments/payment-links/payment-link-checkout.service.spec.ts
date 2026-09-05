import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
  UserState,
  type PaymentLink,
  type Product,
  type Sku,
} from '@prisma/client';
import type Stripe from 'stripe';
import { newId } from '../../common/ids';
import { ProblemException } from '../../common/problem/problem.exception';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { aProduct, aSku } from '../../testing/factories';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { PAYMENT_LINK_QUANTITY } from '../stripe.service';
import { PaymentLinkCheckoutService } from './payment-link-checkout.service';

/* Jest's asymmetric matchers are typed as `any`; the assertions below are
 * deliberately partial Prisma-call checks, not values passed to production. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

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
    // A real session always carries one, and the settlement now compares it:
    // both amounts are minor units, so 2599 of another currency would equal
    // 2599 here while being a different sum of money.
    currency: 'usd',
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

/** The order row as this service writes it, past Prisma's create-input union. */
interface OrderCreateData {
  id: string;
  userId: string;
  status: OrderStatus;
  expiresAt: Date | null;
  subtotal: number;
  orderDiscountAmount: number;
  total: number;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  items: {
    create: {
      id: string;
      sku: { connect: { id: string } };
      productName: string;
      unitPrice: number;
      quantity: number;
    }[];
  };
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
    // With the product, because the re-read inside the transaction is what
    // decides whether the sale can be fulfilled and the service reaches for
    // `sku.product` on the row it gets back.
    harness.prisma.sku.findUnique.mockResolvedValue({
      ...sku,
      product,
    } as never);
    harness.prisma.user.findUnique.mockResolvedValue(null);
    harness.prisma.orderStatusHistory.count.mockResolvedValue(0);
  });

  const settle = (
    session: Stripe.Checkout.Session = aCompletedSession(),
    type = 'checkout.session.completed',
  ) => harness.service.settleCheckoutSession(aCheckoutEvent(session, type));

  /** The nth `order.create` payload, past the Prisma create-input union. */
  const orderData = (call = 0): OrderCreateData =>
    harness.prisma.order.create.mock.calls[call][0]
      .data as unknown as OrderCreateData;

  describe('the events it does not own', () => {
    it('answers null for an event type other than checkout.session.completed', async () => {
      await expect(
        settle(aCompletedSession(), 'checkout.session.expired'),
      ).resolves.toBeNull();
    });

    it('answers null for a completed session whose payment_status is not paid', async () => {
      await expect(
        settle(aCompletedSession({ payment_status: 'unpaid' })),
      ).resolves.toBeNull();
    });

    it('settles checkout.session.async_payment_succeeded rather than answering null', async () => {
      const settlement = await settle(
        aCompletedSession(),
        'checkout.session.async_payment_succeeded',
      );

      expect(settlement).not.toBeNull();
      expect(harness.prisma.order.create).toHaveBeenCalledTimes(1);
      expect(settlement?.orderId).toBe(orderData().id);
    });

    it('settles checkout.session.async_payment_succeeded to the same order status and the same stock movement as the completion event', async () => {
      const settlement = await settle(
        aCompletedSession(),
        'checkout.session.async_payment_succeeded',
      );

      expect(settlement?.status).toBe(OrderStatus.PAID);
      expect(orderData().status).toBe(OrderStatus.PAID);
      expect(harness.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: link.skuId },
        data: { stock: { decrement: PAYMENT_LINK_QUANTITY } },
      });
    });

    it('answers null for a session that names no payment link', async () => {
      await expect(
        settle(aCompletedSession({ payment_link: null })),
      ).resolves.toBeNull();
    });

    it('answers null for a payment link this API never wrote a row for', async () => {
      harness.prisma.paymentLink.findUnique.mockResolvedValue(null);

      await expect(settle()).resolves.toBeNull();
      expect(harness.prisma.paymentLink.findUnique).toHaveBeenCalledWith({
        where: { stripePaymentLinkId: 'plink-1' },
        include: { sku: { include: { product: true } } },
      });
    });

    it('writes nothing at all for any of those', async () => {
      const notOurs: (() => Promise<unknown>)[] = [
        () => settle(aCompletedSession(), 'checkout.session.expired'),
        () => settle(aCompletedSession({ payment_status: 'unpaid' })),
        () => settle(aCompletedSession({ payment_link: null })),
        () => {
          harness.prisma.paymentLink.findUnique.mockResolvedValue(null);
          return settle();
        },
      ];

      for (const arrange of notOurs) {
        await expect(arrange()).resolves.toBeNull();
      }

      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
      expect(harness.prisma.order.create).not.toHaveBeenCalled();
      expect(harness.prisma.payment.create).not.toHaveBeenCalled();
      expect(harness.prisma.user.create).not.toHaveBeenCalled();
      expect(harness.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('the order it creates', () => {
    it('writes the order as PAID when the SKU has stock', async () => {
      await settle();

      expect(orderData().status).toBe(OrderStatus.PAID);
    });

    it('prices the line from PaymentLink.unitPriceAtCreation, not from the SKU current price', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        price: 9999,
        product,
      } as never);

      await settle();

      expect(orderData().items.create[0].unitPrice).toBe(
        link.unitPriceAtCreation,
      );
      expect(orderData().total).toBe(link.unitPriceAtCreation);
    });

    it('writes one line of PAYMENT_LINK_QUANTITY units', async () => {
      await settle();

      const lines = orderData().items.create;

      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual(
        expect.objectContaining({
          quantity: PAYMENT_LINK_QUANTITY,
          sku: { connect: { id: link.skuId } },
        }),
      );
    });

    it('snapshots the product name onto the order line', async () => {
      // Renamed between the link being published and the money arriving, so
      // a line that copied `link.sku.product.name` instead of the row read in
      // the transaction says the old name.
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        product: { ...product, name: 'Renamed before the money arrived' },
      } as never);

      await settle();

      expect(orderData().items.create[0].productName).toBe(
        'Renamed before the money arrived',
      );
    });

    it('writes subtotal and total equal, with no discount', async () => {
      await settle();

      expect(orderData()).toEqual(
        expect.objectContaining({
          subtotal: link.unitPriceAtCreation,
          total: link.unitPriceAtCreation,
          orderDiscountAmount: 0,
        }),
      );
    });

    it('writes expiresAt null, because the order was never PENDING', async () => {
      await settle();

      expect(orderData().expiresAt).toBeNull();
    });

    it('writes the address from customer_details and blanks the fields Stripe omitted', async () => {
      await settle();

      expect(orderData()).toEqual(
        expect.objectContaining({
          recipientName: 'Ada Lovelace',
          line1: '1 Analytical Street',
          line2: null,
          city: 'London',
          region: null,
          postalCode: 'E1 6AN',
        }),
      );

      // Nothing but the email: the empty string and a warning rather than a
      // refusal, because the money has already arrived.
      await settle(
        aCompletedSession({
          id: 'cs-2',
          customer_details: { email: BUYER_EMAIL } as never,
        }),
      );

      expect(orderData(1)).toEqual(
        expect.objectContaining({
          recipientName: BUYER_EMAIL,
          line1: '',
          line2: null,
          city: '',
          region: null,
          postalCode: '',
        }),
      );
    });

    it('appends the order status history row for the status it wrote', async () => {
      await settle();

      const order = orderData();

      // The status the order was written with, read off the order itself:
      // which status that is belongs to the cases about fulfilment, and this
      // one only asserts that the history says the same thing the order does.
      expect(harness.prisma.orderStatusHistory.count).toHaveBeenCalledWith({
        where: { orderId: order.id },
      });
      expect(harness.prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          orderId: order.id,
          status: order.status,
          sequence: 0,
        },
      });
    });

    it('opens one Serializable transaction for the whole settlement', async () => {
      await settle();

      expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(harness.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    });
  });

  describe('the stock it moves', () => {
    it('decrements Sku.stock by the quantity sold', async () => {
      await settle();

      expect(harness.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: link.skuId },
        data: { stock: { decrement: PAYMENT_LINK_QUANTITY } },
      });
    });

    it('leaves Sku.reserved untouched, because a paid order holds nothing', async () => {
      await settle();

      expect(harness.prisma.sku.update.mock.calls[0]?.[0].data).toEqual({
        stock: { decrement: PAYMENT_LINK_QUANTITY },
      });
    });

    it('reads the SKU again inside the transaction rather than trusting the link row', async () => {
      await settle();

      expect(harness.prisma.sku.findUnique).toHaveBeenCalledWith({
        where: { id: link.skuId },
        include: { product: true },
      });

      // Inside, not before: a read taken outside the transaction is not in
      // its read set and Serializable has nothing to protect.
      const [read] = harness.prisma.sku.findUnique.mock.invocationCallOrder;
      const [transaction] =
        harness.prisma.$transaction.mock.invocationCallOrder;

      expect(read).toBeGreaterThan(transaction);
    });

    it('treats availability as stock minus reserved, so units held by a pending order are not sold twice', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        stock: PAYMENT_LINK_QUANTITY,
        reserved: PAYMENT_LINK_QUANTITY,
        product,
      } as never);

      const settlement = await settle();

      expect(settlement?.status).toBe(OrderStatus.FAILED);
      expect(harness.prisma.sku.update).not.toHaveBeenCalled();
    });
  });

  describe('the purchases it refuses to fulfil', () => {
    it('writes the order as FAILED when availability is below the quantity', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        stock: 0,
        reserved: 0,
        product,
      } as never);

      await settle();

      expect(orderData().status).toBe(OrderStatus.FAILED);
    });

    it('writes FAILED when the units are only held by a reservation, not sold', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        stock: PAYMENT_LINK_QUANTITY,
        reserved: PAYMENT_LINK_QUANTITY,
        product,
      } as never);

      await settle();

      expect(orderData().status).toBe(OrderStatus.FAILED);
    });

    it('writes FAILED when the product has been soft-deleted', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        product: { ...product, deletedAt: new Date() },
      } as never);

      await settle();

      expect(orderData().status).toBe(OrderStatus.FAILED);
    });

    it('writes FAILED when the product is no longer active', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        product: { ...product, isActive: false },
      } as never);

      await settle();

      expect(orderData().status).toBe(OrderStatus.FAILED);
    });

    it('writes FAILED when Stripe charged an amount the link does not account for', async () => {
      await settle(aCompletedSession({ amount_total: 9999 }));

      expect(orderData().status).toBe(OrderStatus.FAILED);
      expect(harness.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('moves no stock in any of those cases', async () => {
      const cases: (() => void)[] = [
        () => {
          harness.prisma.sku.findUnique.mockResolvedValue({
            ...sku,
            stock: 0,
            product,
          } as never);
        },
        () => {
          harness.prisma.sku.findUnique.mockResolvedValue({
            ...sku,
            stock: PAYMENT_LINK_QUANTITY,
            reserved: PAYMENT_LINK_QUANTITY,
            product,
          } as never);
        },
        () => {
          harness.prisma.sku.findUnique.mockResolvedValue({
            ...sku,
            product: { ...product, deletedAt: new Date() },
          } as never);
        },
        () => {
          harness.prisma.sku.findUnique.mockResolvedValue({
            ...sku,
            product: { ...product, isActive: false },
          } as never);
        },
      ];

      for (const arrange of cases) {
        resetPrismaMock(harness.prisma);
        harness.prisma.payment.findUnique.mockResolvedValue(null);
        harness.prisma.paymentLink.findUnique.mockResolvedValue({
          ...link,
          sku: { ...sku, product },
        } as never);
        harness.prisma.user.findUnique.mockResolvedValue(null);
        harness.prisma.orderStatusHistory.count.mockResolvedValue(0);
        arrange();
        await settle();
        expect(harness.prisma.sku.update).not.toHaveBeenCalled();
      }

      resetPrismaMock(harness.prisma);
      harness.prisma.payment.findUnique.mockResolvedValue(null);
      harness.prisma.paymentLink.findUnique.mockResolvedValue({
        ...link,
        sku: { ...sku, product },
      } as never);
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        product,
      } as never);
      harness.prisma.user.findUnique.mockResolvedValue(null);
      harness.prisma.orderStatusHistory.count.mockResolvedValue(0);
      await settle(aCompletedSession({ amount_total: 9999 }));
      expect(harness.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('still writes the payment as SUCCEEDED, because the money did arrive', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        stock: 0,
        product,
      } as never);

      await settle();

      expect(harness.prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: PaymentStatus.SUCCEEDED,
          method: PaymentMethod.PAYMENT_LINK,
        }),
      });
    });

    it('answers with the FAILED status so the caller can act on it', async () => {
      harness.prisma.sku.findUnique.mockResolvedValue({
        ...sku,
        stock: 0,
        product,
      } as never);

      await expect(settle()).resolves.toEqual(
        expect.objectContaining({ status: OrderStatus.FAILED }),
      );
    });
  });

  describe('the payment row', () => {
    it('writes method PAYMENT_LINK', async () => {
      await settle();

      expect(harness.prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          method: PaymentMethod.PAYMENT_LINK,
          orderId: orderData().id,
        }),
      });
    });

    it('writes the checkout session id and the payment intent id', async () => {
      await settle();

      expect(harness.prisma.payment.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({
          stripeCheckoutSessionId: 'cs-1',
          stripePaymentIntentId: 'pi-1',
        }),
      });

      // The SDK types the intent as an id or the expanded object, and a
      // webhook payload can carry either.
      await settle(
        aCompletedSession({
          id: 'cs-2',
          payment_intent: { id: 'pi-2' } as never,
        }),
      );

      expect(harness.prisma.payment.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          stripeCheckoutSessionId: 'cs-2',
          stripePaymentIntentId: 'pi-2',
        }),
      });

      await settle(aCompletedSession({ id: 'cs-3', payment_intent: null }));

      expect(harness.prisma.payment.create).toHaveBeenNthCalledWith(3, {
        data: expect.objectContaining({
          stripeCheckoutSessionId: 'cs-3',
          stripePaymentIntentId: null,
        }),
      });
    });

    it('writes the amount Stripe charged rather than the amount the link records', async () => {
      await settle(aCompletedSession({ amount_total: 3000 }));

      expect(harness.prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 3000 }),
      });
    });
  });

  describe('the buyer', () => {
    it('creates a GUEST user with no password hash and no reserved address', async () => {
      await settle();

      expect(harness.prisma.user.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          email: BUYER_EMAIL,
          liveEmail: null,
          passwordHash: null,
          role: UserRole.CLIENT,
          state: UserState.GUEST,
          emailVerifiedAt: null,
        },
      });

      const created = harness.prisma.user.create.mock.calls[0][0]
        .data as never as { id: string };

      expect(orderData().userId).toBe(created.id);
    });

    it('refuses a session that reports no amount, rather than vouching for it', async () => {
      // The absent case used to pass the comparison, which turned the one
      // detector this settlement has into nothing whenever Stripe left the
      // field out — and `Payment.amount` would then hold the expected figure
      // instead of the charged one, which is the column a refund reads.
      await settle(aCompletedSession({ amount_total: null }));

      expect(orderData().status).toBe(OrderStatus.FAILED);
      expect(harness.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('refuses an amount that matches in number but not in currency', async () => {
      await settle(aCompletedSession({ currency: 'eur' }));

      expect(orderData().status).toBe(OrderStatus.FAILED);
      expect(harness.prisma.sku.update).not.toHaveBeenCalled();
    });

    it('never looks for an account by the address the payer typed', async () => {
      await settle();

      // The whole of the fix. `session.customer_details.email` is written by
      // whoever paid, so a lookup on it lets anyone put a stranger's address
      // into Stripe Checkout and have the order appear in that stranger's
      // history — the CLIENT scope reads by `userId` and would hand it over.
      expect(harness.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('makes a fresh guest even when an account already holds that address', async () => {
      const existing = { id: newId() };
      harness.prisma.user.findUnique.mockResolvedValue(existing as never);

      await settle();

      const created = harness.prisma.user.create.mock.calls[0][0]
        .data as never as { id: string };

      expect(orderData().userId).toBe(created.id);
      expect(orderData().userId).not.toBe(existing.id);
    });

    it('throws a plain Error, not a ProblemException, when the session carries no customer email', async () => {
      const refused: unknown = await settle(
        aCompletedSession({
          customer_details: { email: null, name: 'Ada Lovelace' } as never,
        }),
      ).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(ProblemException);
      expect((refused as object).constructor).toBe(Error);
      expect((refused as Error).message).toContain('carries no customer email');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('a redelivered event', () => {
    // A status that is neither PAID nor FAILED, so this reads as the
    // passthrough it is: whatever the first settlement recorded is what comes
    // back, and this case decides nothing about it.
    const settled = {
      id: newId(),
      orderId: newId(),
      order: { status: OrderStatus.SHIPPED },
    };

    it('answers with the existing settlement when a Payment already has the session id', async () => {
      harness.prisma.payment.findUnique.mockResolvedValue(settled as never);

      await expect(settle()).resolves.toEqual({
        orderId: settled.orderId,
        paymentId: settled.id,
        status: OrderStatus.SHIPPED,
      });
      expect(harness.prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { stripeCheckoutSessionId: 'cs-1' },
        include: { order: { select: { status: true } } },
      });
    });

    it('creates no second order on redelivery', async () => {
      harness.prisma.payment.findUnique.mockResolvedValue(settled as never);

      await settle();

      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
      expect(harness.prisma.order.create).not.toHaveBeenCalled();
      expect(harness.prisma.payment.create).not.toHaveBeenCalled();
      expect(harness.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('moves no stock on a redelivery, so the units the first settlement sold are not decremented twice', async () => {
      harness.prisma.payment.findUnique.mockResolvedValue(settled as never);

      await settle();

      expect(harness.prisma.sku.update).not.toHaveBeenCalled();
    });
  });
});
