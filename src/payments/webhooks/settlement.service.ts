import { Injectable, Logger } from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { newId } from '../../common/ids';
import { recordStatus } from '../../orders/order-writes';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe.service';
import { SettlementEventType, type SettlementJobData } from './settlement.jobs';

/** What one settlement job did, so the queue's completed set says something. */
export enum SettlementOutcome {
  /** PENDING to PAID: the reservation became a decrement and the money is recorded. */
  Paid = 'paid',
  /** The order had already been cancelled, so the charge was refunded. */
  Refunded = 'refunded',
  /** Somebody else had already moved the order. Nothing was written. */
  AlreadySettled = 'already-settled',
  /** An event type this worker does not act on. */
  Ignored = 'ignored',
}

/** Just enough of an order to settle it. */
type SettleableOrder = Prisma.OrderGetPayload<{ include: { items: true } }>;

/**
 * The half of the payment flow the webhook route deliberately does not do.
 *
 * It runs in the worker, behind a queue that persisted the job before this
 * ran, so a deploy or an OOM kill between "Stripe confirmed the charge" and
 * "the order moved to PAID" re-delivers the job instead of losing it. That
 * is the requirement `docs/ARQUITECTURA.md` gives for choosing BullMQ over
 * an in-process emitter, and this class is what it was chosen for.
 *
 * Two branches, and they are not symmetrical. A PENDING order is settled:
 * the reservation it has been holding is converted into a real decrement of
 * stock, which is the write that stops `stock - reserved` from understating
 * availability forever. A CANCELLED order is refunded and left alone: the
 * sweep already released its units to somebody else, so moving it to PAID
 * would sell the same units twice.
 *
 * Every precondition is repeated inside the `where` of the write it guards.
 * Reading a status and then writing on the strength of what was read is not
 * made safe by `Serializable` — the isolation level protects the rows the
 * transaction touched, and a row read before it opened is not one of them.
 * `OrdersSweepService` is written the same way, and for the same reason: the
 * two move the same orders in opposite directions and whoever moves the row
 * owns its reservations.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async settle(
    data: SettlementJobData,
    now: Date = new Date(),
  ): Promise<SettlementOutcome> {
    if (data.eventType !== SettlementEventType.PaymentIntentSucceeded) {
      // Not an error: the producer only enqueues types this branches on, so
      // reaching here means a type was added to the enum and not to this
      // method. Answering `Ignored` keeps the job out of the failed set,
      // and the log line is what says the gap exists.
      this.logger.warn(
        // `String` because the enum has a single member today, so the
        // narrowing above leaves the type as `never` and a template literal
        // refuses it. A second member removes the need for this.
        `Nothing settles ${String(data.eventType)}; Stripe event ${data.stripeEventId} was left recorded and unhandled.`,
      );
      return SettlementOutcome.Ignored;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      include: { items: true },
    });

    if (!order) {
      // Thrown rather than logged and swallowed. Checkout commits the order
      // before it asks Stripe for an intent, so a succeeded intent whose
      // `metadata.orderId` names no order means the two databases disagree
      // about money that has already moved. The job retries for the best
      // part of a day and then parks in the failed set, where the monitoring
      // this queue exists for can find it.
      throw new Error(
        `Stripe event ${data.stripeEventId} settles order ${data.orderId}, which does not exist.`,
      );
    }

    if (order.status === OrderStatus.CANCELLED) {
      return this.refund(order, data, now);
    }

    if (order.status !== OrderStatus.PENDING) {
      // A duplicate delivery of an event already settled, almost always.
      // Nothing to do and nothing wrong: the row moved once, which is the
      // whole guarantee.
      this.logger.log(
        `Order ${order.id} is already ${order.status}; Stripe event ${data.stripeEventId} settles nothing.`,
      );
      await this.markProcessed(this.prisma, data, now);

      return SettlementOutcome.AlreadySettled;
    }

    return this.pay(order, data, now);
  }

  /**
   * PENDING to PAID, and the reservation spent rather than released.
   *
   * The stock write is the point of the whole block. Until now a PAID order
   * kept its `reserved` units forever: `availableOf` is `stock - reserved`,
   * so every completed sale permanently understated what was on the shelf
   * and the shop slowly sold itself out of stock it still had. Settling
   * decrements both columns in the same statement — the units leave the
   * reservation and leave the shelf at the same instant, so no reader ever
   * sees a moment where they are counted twice or not at all.
   *
   * `updateMany` and not `update`, because the count is the answer to "did
   * this transaction move the row, or did something else get there first?".
   * Zero means the order stopped being PENDING between the read above and
   * this write, and nothing else in this transaction may then run: whoever
   * moved it owns its reservations now, and decrementing stock underneath
   * them would sell units that were just released to another customer.
   *
   * **Zero throws, where the sweep merely skips.** The sweep can afford to
   * leave an order for the next minute's run; nothing runs again here, so a
   * job that reported success on a settlement it did not perform would be a
   * charge that quietly never lands anywhere. Failing sends it back through
   * `SETTLEMENT_JOB_OPTIONS`' backoff, and the retry re-reads the order and
   * takes whichever branch its new status calls for — the refund one, if
   * what got there first was a cancellation.
   */
  private async pay(
    order: SettleableOrder,
    data: SettlementJobData,
    now: Date,
  ): Promise<SettlementOutcome> {
    const settled = await this.prisma.$transaction(
      async (tx) => {
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.PENDING },
          // `expiresAt` is cleared in the same write: a paid order has no
          // expiry, and leaving a past one behind would keep it in the
          // sweep's own `findMany` forever.
          data: { status: OrderStatus.PAID, expiresAt: null },
        });

        if (moved.count === 0) return false;

        await consumeReservations(tx, order.items);
        await recordStatus(tx, order.id, OrderStatus.PAID);
        await this.recordCharge(tx, order, data, {});
        await this.markProcessed(tx, data, now);

        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (!settled) {
      throw new Error(
        `Order ${order.id} stopped being ${OrderStatus.PENDING} while Stripe event ${data.stripeEventId} was settling it; nothing was written and the job must run again.`,
      );
    }

    // The confirmation mail belongs here, after the commit, so a message is
    // never sent for a transaction that rolled back.
    //
    // **Extension point — the mail kind does not exist yet.** `MailKind`
    // (src/mail/mail.jobs.ts) declares the four account messages and no
    // order confirmation, and `renderMail` has no branch for one, so there
    // is nothing this can enqueue that would not deliver the wrong message
    // to a customer. What it needs is a new `MailKind` member, its body in
    // `mail.content.ts`, and an `MailService` method taking the order's id
    // and the buyer's address; the enqueue is then one line at this point,
    // and it must stay outside the transaction above.
    this.logger.log(`Settled order ${order.id} as ${OrderStatus.PAID}.`);

    return SettlementOutcome.Paid;
  }

  /**
   * The charge arrived for an order that no longer exists to be paid.
   *
   * **Refund first, record second.** A `stripe_refund_id` written before
   * Stripe agreed to the refund is indistinguishable afterwards from money
   * that was actually returned, and the alert that looks for succeeded
   * payments on cancelled orders without a refund id would read healthy over
   * a customer who was never paid back. So Stripe is called outside the
   * transaction — for the reason checkout gives, that a third party's
   * latency must not be held inside `Serializable` locks — and it throws on
   * failure, which fails the job and retries it.
   *
   * The order is not moved. It is CANCELLED, the sweep released its units to
   * whoever bought them next, and there is nothing about a refunded charge
   * that should change its status.
   */
  private async refund(
    order: SettleableOrder,
    data: SettlementJobData,
    now: Date,
  ): Promise<SettlementOutcome> {
    const refundId = await this.stripe.refundPaymentIntent(
      data.paymentIntentId,
    );

    await this.prisma.$transaction(
      async (tx) => {
        // `SUCCEEDED` and not `FAILED`: the charge did succeed, and the
        // refund is a second fact about it rather than a contradiction of
        // the first. The monitoring query in `docs/ARQUITECTURA.md` reads
        // exactly this shape — succeeded, cancelled order, refund id
        // present or missing — so writing anything else here would make that
        // alert blind.
        await this.recordCharge(tx, order, data, {
          stripeRefundId: refundId,
          refundedAt: now,
        });
        await this.markProcessed(tx, data, now);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    this.logger.warn(
      `Refunded ${refundId} for cancelled order ${order.id}: its payment landed after it was cancelled.`,
    );

    return SettlementOutcome.Refunded;
  }

  /**
   * Marks the payment succeeded, creating the row when checkout never got to
   * write one.
   *
   * The missing-row case is real and not defensive coding: checkout creates
   * the intent and then records it in two separate steps, so a process that
   * dies between them leaves a charge whose only trace is at Stripe. The
   * event carries the intent's id, which is what makes the row
   * reconstructable here.
   *
   * `updateMany` repeats every condition the row was chosen by — the order,
   * the intent, and a refund not already recorded — and the count decides
   * what happens next. The unique index on `stripe_payment_intent_id` is
   * what stops two concurrent settlements from both creating a row: the
   * loser's transaction is rejected and its job retries, which is the
   * correct outcome rather than two payment rows for one charge.
   *
   * **A count of zero is asked about rather than assumed.** It has two
   * meanings — no row at all, or a row the `refundedAt: null` filter
   * excluded — and creating on the second would hit that unique index and
   * fail the job for good on what is actually a job doing its work twice.
   * The extra read separates them, and it is inside the transaction, so the
   * answer cannot change under it. What it protects is the first refund's
   * timestamp: a retried job refunds through the same idempotency key and
   * gets the same refund back, and the moment worth keeping is when the
   * money was returned, not when a retry confirmed it again.
   */
  private async recordCharge(
    tx: Prisma.TransactionClient,
    order: SettleableOrder,
    data: SettlementJobData,
    refund: { stripeRefundId?: string; refundedAt?: Date },
  ): Promise<void> {
    const identity = {
      orderId: order.id,
      stripePaymentIntentId: data.paymentIntentId,
    };

    const updated = await tx.payment.updateMany({
      where: { ...identity, refundedAt: null },
      data: { status: PaymentStatus.SUCCEEDED, ...refund },
    });

    if (updated.count > 0) return;

    if ((await tx.payment.count({ where: identity })) > 0) return;

    await tx.payment.create({
      data: {
        id: newId(),
        orderId: order.id,
        method: PaymentMethod.PAYMENT_INTENT,
        status: PaymentStatus.SUCCEEDED,
        // The order's own total, never an amount read out of the event: one
        // opinion about what was owed, and it is the one the customer
        // agreed to at checkout.
        amount: order.total,
        stripePaymentIntentId: data.paymentIntentId,
        ...refund,
      },
    });
  }

  /**
   * Stamps the recorded event as settled, in the same transaction as the
   * settlement itself.
   *
   * `processed_at` is not bookkeeping: the alert on "webhook events recorded
   * but not settled for more than N minutes" reads this column, so a stamp
   * written outside the transaction that moved the order would let it say
   * settled about work that rolled back. `processedAt: null` in the `where`
   * keeps the first stamp rather than overwriting it with the time of a
   * duplicate delivery.
   */
  private async markProcessed(
    // `PrismaService` is assignable to this, which is what lets the branch
    // with nothing to write use it without opening a transaction.
    tx: Prisma.TransactionClient,
    data: SettlementJobData,
    now: Date,
  ): Promise<void> {
    await tx.webhookEvent.updateMany({
      where: { id: data.webhookEventId, processedAt: null },
      data: { processedAt: now },
    });
  }
}

/**
 * Spends an order's reservation: the units leave `reserved` and leave
 * `stock` in the same statement.
 *
 * The mirror of `releaseReservations` in `src/orders/order-writes.ts`, and
 * the same warning applies twice over — only the writer that actually moved
 * the order out of PENDING may call this, because a second call would
 * decrement stock that has already been sold.
 *
 * It lives here rather than beside its mirror because settlement is the only
 * caller today; the moment a second one appears, the two belong in the same
 * file so they cannot disagree about how a reservation ends.
 */
async function consumeReservations(
  tx: Prisma.TransactionClient,
  items: readonly { skuId: string; quantity: number }[],
): Promise<void> {
  for (const item of items) {
    await tx.sku.update({
      where: { id: item.skuId },
      data: {
        reserved: { decrement: item.quantity },
        stock: { decrement: item.quantity },
      },
    });
  }
}
