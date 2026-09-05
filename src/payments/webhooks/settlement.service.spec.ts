import { Logger } from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { anOrder, anOrderItem, aSku, aUser } from '../../testing/factories';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { SettlementEventType, type SettlementJobData } from './settlement.jobs';
import { SettlementOutcome, SettlementService } from './settlement.service';

/* Jest's asymmetric matchers are typed as `any`; these are partial checks of
 * Prisma calls and are never values passed to production code. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const buyer = aUser();
const sku = aSku('018f3b6f-0000-7000-8000-0000000000ff', {
  stock: 10,
  reserved: 3,
});

/**
 * The order as settlement reads it: its rows, its lines and the one column
 * of the buyer the confirmation needs, in one object.
 *
 * `user` is the joined `select`, not the whole row — the service asks for
 * the address and nothing else, and a fixture that handed it a full `User`
 * would let a change start reading a password hash without the suite
 * noticing.
 */
export const aSettleableOrder = (
  overrides: Parameters<typeof anOrder>[1] = {},
  quantity = 3,
) => {
  const order = anOrder(buyer.id, overrides);

  return {
    ...order,
    items: [anOrderItem(order.id, sku.id, { quantity })],
    user: { email: buyer.email },
  };
};

/**
 * The job the webhook produced. Identifiers only, which is what
 * `SETTLEMENT_JOB_OPTIONS` keeping failures forever obliges the payload to
 * be.
 */
export const aSettlementJob = (
  overrides: Partial<SettlementJobData> = {},
): SettlementJobData => ({
  webhookEventId: '018f3b6f-0000-7000-8000-000000000010',
  stripeEventId: 'evt_delivered_once',
  eventType: SettlementEventType.PaymentIntentSucceeded,
  paymentIntentId: 'pi_settled_by_the_suite',
  orderId: '018f3b6f-0000-7000-8000-000000000001',
  ...overrides,
});

/**
 * The one file in this block where a missing assertion costs money, and the
 * cases are named accordingly.
 *
 * **The stock write is new behaviour and the reason the block exists.** Until
 * now a PAID order kept its units in `reserved` forever, so `stock -
 * reserved` understated availability for the rest of the SKU's life. What
 * has to be asserted is that both columns move, by the same amount, in the
 * same statement — a version that decremented only `reserved` would give the
 * units back to the shelf it had already sold them from, and one that
 * decremented only `stock` would leave the reservation stranded exactly as
 * before. Assert the Prisma call, not the returned row: the call is what
 * says which columns the code asked the database to change.
 *
 * **Every precondition has to be back in the `where`.** The sweep cancels
 * the same orders from the other direction, so the two race by design and
 * the only thing that keeps them safe is that each writes `status: PENDING`
 * into its own update and acts on the count. A settlement that read the
 * status and then wrote unconditionally passes every happy-path test and
 * decrements stock the sweep has already released.
 *
 * **The refund branch must record nothing before Stripe agrees.** A
 * `stripe_refund_id` written first is, afterwards, indistinguishable from
 * money that was actually returned — and the monitoring query that looks
 * for succeeded payments on cancelled orders with no refund id would then
 * read healthy over a customer who was never paid back. Order of calls is
 * the assertion, not the resulting row.
 */
describe('SettlementService', () => {
  let h: ServiceHarness<SettlementService>;

  beforeEach(async () => {
    h = await buildService(SettlementService);
    resetPrismaMock(h.prisma);

    // The ordinary settlement: a PENDING order with one line, an update
    // that moves exactly one row, and a refund Stripe would accept. Each
    // stub below changes one of those.
    h.prisma.order.findUnique.mockResolvedValue(
      aSettleableOrder({ id: aSettlementJob().orderId }),
    );
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.orderStatusHistory.count.mockResolvedValue(1);
    h.stripe.refundPaymentIntent.mockResolvedValue('re_refunded_by_the_suite');
  });

  describe('an order that is still PENDING', () => {
    it(`moves it to ${OrderStatus.PAID} and clears its expiry`, async () => {
      const data = aSettlementJob();

      await expect(h.service.settle(data)).resolves.toBe(
        SettlementOutcome.Paid,
      );

      expect(h.prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: data.orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID, expiresAt: null },
      });
    });
    it(`repeats ${OrderStatus.PENDING} in the where of the update, so a sweep that got there first wins`, async () => {
      const data = aSettlementJob();

      await h.service.settle(data);

      expect(h.prisma.order.updateMany.mock.calls[0]?.[0].where).toEqual({
        id: data.orderId,
        status: OrderStatus.PENDING,
      });
    });
    it('writes nothing else when that update moved no row', async () => {
      h.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(h.service.settle(aSettlementJob())).rejects.toThrow();

      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      expect(h.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(h.prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.payment.create).not.toHaveBeenCalled();
      expect(h.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    });
    it('fails the job when that update moved no row, so the retry re-reads the order', async () => {
      const data = aSettlementJob();
      h.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(h.service.settle(data)).rejects.toThrow(
        `Order ${data.orderId} stopped being ${OrderStatus.PENDING} while Stripe event ${data.stripeEventId} was settling it; nothing was written and the job must run again.`,
      );
    });
    it('decrements reserved and stock by the line quantity, in the same sku update', async () => {
      await h.service.settle(aSettlementJob());

      expect(h.prisma.sku.update).toHaveBeenCalledWith({
        where: { id: sku.id },
        data: {
          reserved: { decrement: 3 },
          stock: { decrement: 3 },
        },
      });
    });
    it('decrements each line of a multi-line order', async () => {
      const secondSku = aSku('018f3b6f-0000-7000-8000-0000000000fe', {
        stock: 8,
        reserved: 2,
      });
      const order = aSettleableOrder();
      order.items = [
        order.items[0],
        anOrderItem(order.id, secondSku.id, { quantity: 2 }),
      ];
      h.prisma.order.findUnique.mockResolvedValue(order);

      await h.service.settle(aSettlementJob({ orderId: order.id }));

      expect(h.prisma.sku.update).toHaveBeenNthCalledWith(1, {
        where: { id: sku.id },
        data: { reserved: { decrement: 3 }, stock: { decrement: 3 } },
      });
      expect(h.prisma.sku.update).toHaveBeenNthCalledWith(2, {
        where: { id: secondSku.id },
        data: { reserved: { decrement: 2 }, stock: { decrement: 2 } },
      });
    });
    it(`appends the ${OrderStatus.PAID} row to the status history`, async () => {
      const data = aSettlementJob();

      await h.service.settle(data);

      expect(h.prisma.orderStatusHistory.count).toHaveBeenCalledWith({
        where: { orderId: data.orderId },
      });
      expect(h.prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: data.orderId,
          status: OrderStatus.PAID,
          sequence: 1,
        }),
      });
    });
    it('marks the payment SUCCEEDED with the intent from the job', async () => {
      const data = aSettlementJob({ paymentIntentId: 'pi_from_the_job' });

      await h.service.settle(data);

      expect(h.prisma.payment.updateMany).toHaveBeenCalledWith({
        where: {
          orderId: data.orderId,
          stripePaymentIntentId: data.paymentIntentId,
          refundedAt: null,
        },
        data: { status: PaymentStatus.SUCCEEDED },
      });
    });
    it('creates the payment row when checkout died before recording the intent', async () => {
      const data = aSettlementJob();
      // The same row the settlement reads, so the amount asserted below is
      // the order's total and not whatever the factory happens to default to.
      const order = aSettleableOrder({ id: data.orderId });
      h.prisma.order.findUnique.mockResolvedValue(order);
      h.prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      h.prisma.payment.count.mockResolvedValue(0);

      await h.service.settle(data);

      expect(h.prisma.payment.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          orderId: data.orderId,
          method: PaymentMethod.PAYMENT_INTENT,
          status: PaymentStatus.SUCCEEDED,
          amount: order.total,
          stripePaymentIntentId: data.paymentIntentId,
        },
      });
    });
    it("records the order's total, never an amount read out of the event", async () => {
      const order = aSettleableOrder({ total: 9876, subtotal: 9876 });
      const data = aSettlementJob({ orderId: order.id });
      h.prisma.order.findUnique.mockResolvedValue(order);
      h.prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      h.prisma.payment.count.mockResolvedValue(0);

      await h.service.settle(data);

      expect(h.prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: order.total }),
      });
    });
    it('stamps the webhook event processed inside the same transaction', async () => {
      const now = new Date('2026-09-05T00:00:00.000Z');
      const data = aSettlementJob();

      await h.service.settle(data, now);

      expect(h.prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: { id: data.webhookEventId, processedAt: null },
        data: { processedAt: now },
      });
    });
    it('runs the whole settlement at Serializable', async () => {
      await h.service.settle(aSettlementJob());

      expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    });
    it('opens exactly one transaction', async () => {
      await h.service.settle(aSettlementJob());

      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('an order that was already CANCELLED', () => {
    const cancelledOrder = () =>
      aSettleableOrder({
        id: aSettlementJob().orderId,
        status: OrderStatus.CANCELLED,
      });

    beforeEach(() => {
      h.prisma.order.findUnique.mockResolvedValue(cancelledOrder());
    });

    it('refunds the intent through Stripe', async () => {
      const data = aSettlementJob({ paymentIntentId: 'pi_cancelled' });

      await expect(h.service.settle(data)).resolves.toBe(
        SettlementOutcome.Refunded,
      );

      expect(h.stripe.refundPaymentIntent).toHaveBeenCalledWith('pi_cancelled');
    });
    it('records the refund id and the refunded time on the payment', async () => {
      const now = new Date('2026-09-05T00:00:00.000Z');
      const data = aSettlementJob();

      await h.service.settle(data, now);

      expect(h.prisma.payment.updateMany).toHaveBeenCalledWith({
        where: {
          orderId: data.orderId,
          stripePaymentIntentId: data.paymentIntentId,
          refundedAt: null,
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          stripeRefundId: 're_refunded_by_the_suite',
          refundedAt: now,
        },
      });
    });
    it('records the refund only after Stripe has answered', async () => {
      await h.service.settle(aSettlementJob());

      expect(
        h.stripe.refundPaymentIntent.mock.invocationCallOrder[0],
      ).toBeLessThan(
        h.prisma.payment.updateMany.mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
    });
    it('leaves the order CANCELLED, because the sweep already sold its units to somebody else', async () => {
      await h.service.settle(aSettlementJob());

      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });
    it('gives nothing back to reserved or to stock', async () => {
      await h.service.settle(aSettlementJob());

      expect(h.prisma.sku.update).not.toHaveBeenCalled();
    });
    it('lets a refund Stripe refuses fail the job, so BullMQ retries it', async () => {
      const error = new Error('refund declined');
      h.stripe.refundPaymentIntent.mockRejectedValue(error);

      await expect(h.service.settle(aSettlementJob())).rejects.toBe(error);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });
    it('records no refund id when the refund failed', async () => {
      h.stripe.refundPaymentIntent.mockRejectedValue(
        new Error('refund declined'),
      );

      await expect(h.service.settle(aSettlementJob())).rejects.toThrow(
        'refund declined',
      );

      expect(h.prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.payment.create).not.toHaveBeenCalled();
    });
    it('does not create a second payment row when the only row is one it already refunded', async () => {
      h.prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      h.prisma.payment.count.mockResolvedValue(1);

      await h.service.settle(aSettlementJob());

      expect(h.prisma.payment.create).not.toHaveBeenCalled();
    });
    it('keeps the first refunded time when the job runs again', async () => {
      h.prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      h.prisma.payment.count.mockResolvedValue(1);

      await h.service.settle(
        aSettlementJob(),
        new Date('2026-09-06T00:00:00.000Z'),
      );

      expect(h.prisma.payment.updateMany.mock.calls[0]?.[0].where).toEqual({
        orderId: expect.any(String),
        stripePaymentIntentId: expect.any(String),
        refundedAt: null,
      });
      expect(h.prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('an order in any other status', () => {
    beforeEach(() => {
      h.prisma.order.findUnique.mockResolvedValue(
        aSettleableOrder({
          id: aSettlementJob().orderId,
          status: OrderStatus.PAID,
        }),
      );
    });

    it('settles nothing for an order that is already PAID', async () => {
      await expect(h.service.settle(aSettlementJob())).resolves.toBe(
        SettlementOutcome.AlreadySettled,
      );

      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      expect(h.prisma.payment.updateMany).not.toHaveBeenCalled();
    });
    it('stamps the webhook event processed anyway, so the alert clears', async () => {
      const data = aSettlementJob();

      await h.service.settle(data);

      expect(h.prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: { id: data.webhookEventId, processedAt: null },
        data: { processedAt: expect.any(Date) },
      });
    });
    it('opens no transaction', async () => {
      await h.service.settle(aSettlementJob());

      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses', () => {
    it('throws when the order named by the intent does not exist, rather than swallowing it', async () => {
      const data = aSettlementJob();
      h.prisma.order.findUnique.mockResolvedValue(null);

      // The exact sentence, because the failed set is where a person reads
      // it: "a job failed" is not actionable, "this event settles an order
      // that does not exist" is.
      await expect(h.service.settle(data)).rejects.toThrow(
        `Stripe event ${data.stripeEventId} settles order ${data.orderId}, which does not exist.`,
      );
    });

    it('ignores an event type it has no branch for, without failing', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const data = aSettlementJob({
        // Not a member of the enum today. The producer's filter would never
        // build this job, so reaching the branch means the enum grew and
        // this method did not — which is a gap to log, not a job to fail.
        eventType:
          'checkout.session.completed' as unknown as SettlementEventType,
      });

      await expect(h.service.settle(data)).resolves.toBe(
        SettlementOutcome.Ignored,
      );

      // It stops before it reads anything: an unknown type is not an order
      // this worker has an opinion about.
      expect(h.prisma.order.findUnique).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        `Nothing settles checkout.session.completed; Stripe event ${data.stripeEventId} was left recorded and unhandled.`,
      );
      warn.mockRestore();
    });

    it('does not overwrite the processed stamp of a delivery already settled', async () => {
      const data = aSettlementJob();
      const alreadyProcessed = new Date('2026-09-01T00:00:00.000Z');
      h.prisma.order.findUnique.mockResolvedValue(
        aSettleableOrder({
          id: aSettlementJob().orderId,
          status: OrderStatus.PAID,
        }),
      );
      // What Postgres returns when the row is already stamped: the
      // `processedAt: null` guard matched nothing. Asserting only the call
      // proved the guard was written, never that a zero-row result is a
      // survivable answer — and it is the answer a redelivery produces.
      h.prisma.webhookEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        h.service.settle(data, alreadyProcessed),
      ).resolves.toBeDefined();

      expect(h.prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: { id: data.webhookEventId, processedAt: null },
        data: { processedAt: alreadyProcessed },
      });
    });
  });

  /**
   * The confirmation, and the three properties that make it safe.
   *
   * **It is enqueued only where money actually moved.** A cancelled order
   * that was refunded, a delivery of an event already settled, an event
   * type with no branch — none of those is a purchase to confirm, and a
   * message sent on any of them tells a customer something untrue. `h.mail`
   * is a `MailService` double, so what to assert is the call: the recipient
   * is the buyer's address off the joined row, and the second argument is
   * the order's id.
   *
   * **It happens after the commit and not inside it.** The transaction
   * callback runs against the Prisma mock, so ordering is what the suite
   * can see: `h.prisma.$transaction` has to have resolved before
   * `h.mail.sendOrderConfirmation` was called. A job enqueued inside a
   * transaction that then rolls back is a customer told their order was
   * paid when it was not, and no assertion anywhere else in this file
   * would catch it.
   *
   * **A queue that refuses must not undo the payment.** Reject
   * `h.mail.sendOrderConfirmation` and the settle call still has to resolve
   * `Paid` — if it rejected, `SETTLEMENT_JOB_OPTIONS` would redeliver the
   * job for the best part of a day, find the order no longer PENDING every
   * time, and park a payment that succeeded in the failed set that exists
   * to report lost ones.
   *
   * The stubs below are the student's to fill: the behaviour they name was
   * written by the assistant, so an assistant-written assertion would only
   * agree with whatever it produced.
   */
  describe('the confirmation the customer gets', () => {
    it("sends it to the buyer's address, carrying the order's id and nothing else", async () => {
      const data = aSettlementJob();

      await h.service.settle(data);

      expect(h.mail.sendOrderConfirmation).toHaveBeenCalledWith(
        buyer.email,
        data.orderId,
      );
      expect(h.mail.sendOrderConfirmation).toHaveBeenCalledTimes(1);
    });
    it('enqueues it only after the transaction resolved, never from inside it', async () => {
      let releaseTransaction!: () => void;
      const transactionResolved = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });

      h.prisma.$transaction.mockImplementation((operation: unknown) => {
        if (typeof operation !== 'function') {
          return Promise.all(operation as Promise<unknown>[]);
        }

        return (async () => {
          const result = await (
            operation as (tx: typeof h.prisma) => Promise<unknown>
          )(h.prisma);
          await transactionResolved;
          return result;
        })();
      });

      const settling = h.service.settle(aSettlementJob());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(h.mail.sendOrderConfirmation).not.toHaveBeenCalled();

      releaseTransaction();
      await expect(settling).resolves.toBe(SettlementOutcome.Paid);
      expect(h.mail.sendOrderConfirmation).toHaveBeenCalledTimes(1);
    });
    it(`still answers ${SettlementOutcome.Paid} when the mail queue rejects, so a refused enqueue cannot undo a payment`, async () => {
      h.mail.sendOrderConfirmation.mockRejectedValue(
        new Error('mail queue unavailable'),
      );

      await expect(h.service.settle(aSettlementJob())).resolves.toBe(
        SettlementOutcome.Paid,
      );
    });
    it('logs the refusal against the order id and never the recipient or the payload', async () => {
      const data = aSettlementJob();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      h.mail.sendOrderConfirmation.mockRejectedValue(
        new Error('mail queue unavailable'),
      );

      await h.service.settle(data);

      const log = error.mock.calls.flat().map(String).join(' ');
      expect(log).toContain(data.orderId);
      expect(log).not.toContain(buyer.email);
      expect(log).not.toContain('OrderConfirmation');
      error.mockRestore();
    });
    it('sends nothing when the order was already CANCELLED and refunded', async () => {
      h.prisma.order.findUnique.mockResolvedValue(
        aSettleableOrder({ status: OrderStatus.CANCELLED }),
      );
      h.stripe.refundPaymentIntent.mockResolvedValue('re_refunded');

      await h.service.settle(aSettlementJob());

      expect(h.mail.sendOrderConfirmation).not.toHaveBeenCalled();
    });
    it('sends nothing when the delivery was a duplicate of one already settled', async () => {
      h.prisma.order.findUnique.mockResolvedValue(
        aSettleableOrder({
          id: aSettlementJob().orderId,
          status: OrderStatus.PAID,
        }),
      );

      await h.service.settle(aSettlementJob());

      expect(h.mail.sendOrderConfirmation).not.toHaveBeenCalled();
    });
    it('sends nothing for an event type it has no branch for', async () => {
      const data = aSettlementJob({
        eventType:
          'checkout.session.completed' as unknown as SettlementEventType,
      });

      await expect(h.service.settle(data)).resolves.toBe(
        SettlementOutcome.Ignored,
      );
      expect(h.mail.sendOrderConfirmation).not.toHaveBeenCalled();
    });
  });
});
