import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { newId } from '../../common/ids';
import { MailService } from '../../mail/mail.service';
import {
  StockNotificationsService,
  type StockChange,
} from '../../notifications/stock-notifications.service';
import { recordStatus } from '../../orders/order-writes';
import { consumePromoCodeReservation } from '../../promo-codes/promo-code-writes';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe.service';
import { PaymentLinkCheckoutService } from '../payment-links/payment-link-checkout.service';
import {
  SettlementEventType,
  type PaymentIntentSettlementJobData,
  type SettlementJobData,
} from './settlement.jobs';

/** What one settlement job did, so the queue's completed set says something. */
export enum SettlementOutcome {
  /** PENDING to PAID: the reservation became a decrement and the money is recorded. */
  Paid = 'paid',
  /** The order had already been cancelled, so the charge was refunded. */
  Refunded = 'refunded',
  /** Somebody else had already moved the order. Nothing was written. */
  AlreadySettled = 'already-settled',
  /** A paid Checkout Session produced or recovered a payment-link order. */
  PaymentLinkSettled = 'payment-link-settled',
  /** An event type this worker does not act on. */
  Ignored = 'ignored',
}

/**
 * Just enough of an order to settle it and to confirm it.
 *
 * The buyer is joined for one column. It is read here, in the same query
 * that already fetches the order, rather than in a second one after the
 * commit: settlement has exactly one place where it can fail without
 * consequence, and adding a round trip to the database inside it would give
 * the confirmation a second way to be lost for no gain. `select` and not
 * `include`, because the row also holds a password hash and a live email,
 * and nothing here has any business with either.
 */
type SettleableOrder = Prisma.OrderGetPayload<{
  include: { items: true; user: { select: { email: true } } };
}> & { redemption?: { promoCodeId: string } | null };

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
    private readonly mail: MailService,
    private readonly paymentLinkCheckout: PaymentLinkCheckoutService,
    private readonly stockNotifications: StockNotificationsService,
  ) {}

  async settle(
    data: SettlementJobData,
    now: Date = new Date(),
  ): Promise<SettlementOutcome> {
    if (
      data.eventType === SettlementEventType.CheckoutSessionCompleted ||
      data.eventType ===
        SettlementEventType.CheckoutSessionAsyncPaymentSucceeded
    ) {
      const event = await this.stripe.retrieveEvent(data.stripeEventId);
      const settlement =
        await this.paymentLinkCheckout.settleCheckoutSession(event);

      await this.markProcessed(this.prisma, data, now);

      return settlement
        ? SettlementOutcome.PaymentLinkSettled
        : SettlementOutcome.Ignored;
    }

    if (data.eventType !== SettlementEventType.PaymentIntentSucceeded) {
      // Not an error: the producer only enqueues types this branches on, so
      // reaching here means a type was added to the enum and not to this
      // method. Answering `Ignored` keeps the job out of the failed set,
      // and the log line is what says the gap exists.
      this.logger.warn(
        `Nothing settles ${String(data.eventType)}; Stripe event ${data.stripeEventId} was left recorded and unhandled.`,
      );
      return SettlementOutcome.Ignored;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      include: {
        items: true,
        user: { select: { email: true } },
        redemption: { select: { promoCodeId: true } },
      },
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
    data: PaymentIntentSettlementJobData,
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

        const stockChanges = await consumeReservations(tx, order.items);
        await consumePromoCodeReservation(tx, order.redemption ?? null);
        await recordStatus(tx, order.id, OrderStatus.PAID);
        await this.recordCharge(tx, order, data, {});
        // The durable half of the confirmation, committed alongside the
        // order it confirms. `confirm` below still makes the first attempt
        // right after the commit, but a queue outage there is no longer the
        // end of it: this row is what `OrderConfirmationOutboxService`
        // rereads on its own schedule, so the retry does not depend on the
        // process that settled this job still being the one that tries
        // again.
        const outbox = await tx.orderConfirmationOutbox.create({
          data: { id: newId(), orderId: order.id, email: order.user.email },
        });
        await this.markProcessed(tx, data, now);

        return { outboxId: outbox.id, stockChanges };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (settled === false) {
      throw new Error(
        `Order ${order.id} stopped being ${OrderStatus.PENDING} while Stripe event ${data.stripeEventId} was settling it; nothing was written and the job must run again.`,
      );
    }

    this.logger.log(`Settled order ${order.id} as ${OrderStatus.PAID}.`);

    await this.observeStockChanges(order.id, settled.stockChanges);

    // After the commit and outside it, which is the whole of why the call
    // is on this line and not four lines up. A job enqueued inside the
    // transaction survives a rollback — BullMQ writes to Redis, which knows
    // nothing about Postgres — so a rolled-back settlement would still tell
    // the customer their order was paid.
    await this.confirm(order, settled.outboxId);

    return SettlementOutcome.Paid;
  }

  private async observeStockChanges(
    orderId: string,
    changes: readonly StockChange[],
  ): Promise<void> {
    for (const change of changes) {
      try {
        await this.stockNotifications.observeStockChange(change);
      } catch (error) {
        this.logger.error(
          `Could not observe the stock change for SKU ${change.skuId} after settling order ${orderId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Tells the buyer their order is paid, and cannot fail the job that paid
   * it.
   *
   * The swallow is the same shape as `AuthService.notify` and it is here
   * for a stronger reason than that one's. There the harm is an oracle: a
   * queue hiccup would answer 500 for a registered address and 202 for
   * every other, turning a uniform response into the disclosure it exists
   * to prevent, and the endpoint can afford to lose the message because the
   * client can ask for another. Here nothing can be asked for again. The
   * transaction above has committed — the order is PAID, the reservation is
   * spent, the charge is recorded and the event is stamped processed — so a
   * rejection escaping this method would fail the job over an email, and
   * `SETTLEMENT_JOB_OPTIONS` would redeliver it for the best part of a day.
   * Every one of those retries re-reads an order that is no longer PENDING,
   * so `pay` never runs again; the job would park in the failed set that
   * exists to be alerted on, announcing a lost payment that was never lost.
   * Trading a confirmation for that is not a trade.
   *
   * `AuthService.signUp` is the case that deliberately does not swallow,
   * and the difference is what has already happened when the call is made.
   * Nothing has, there: an account whose verification link was never
   * enqueued has no way to be verified, and failing the request is more
   * honest than a 201 that promises a message nobody will send.
   *
   * **A refused enqueue no longer ends here.** `outboxId` names the row
   * `pay` committed alongside the order, still PENDING until this method
   * marks it SENT. If `sendOrderConfirmation` rejects, the row is left
   * exactly as it was — nothing to mark, nothing to undo — and
   * `OrderConfirmationOutboxService.drain` retries it independently of
   * this call, this job and this process. A retry that reaches the mark
   * below and fails only leaves a confirmation that was actually sent
   * looking unconfirmed, which the drain's own `status: PENDING` guard
   * turns into a harmless second send rather than a lost one.
   *
   * The log line is the only artefact either way `MailProcessor`'s and the
   * outbox row's own status do not already carry — so it names the order
   * and never the payload. The recipient is a customer's address;
   * `MailProcessor` is the one place with a reason to write one down, and
   * it has already made that argument for itself.
   */
  private async confirm(
    order: SettleableOrder,
    outboxId: string,
  ): Promise<void> {
    try {
      await this.mail.sendOrderConfirmation(order.user.email, order.id);
    } catch (error) {
      this.logger.error(
        `Could not enqueue the confirmation for order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    try {
      await this.prisma.orderConfirmationOutbox.updateMany({
        where: { id: outboxId, status: NotificationStatus.PENDING },
        data: { status: NotificationStatus.SENT, sentAt: new Date() },
      });
      this.logger.log(`Queued the confirmation for order ${order.id}.`);
    } catch (error) {
      // The mail job is already enqueued; only the outbox's own bookkeeping
      // failed. Left PENDING, the drain resends a confirmation that already
      // went out — a duplicate email, not a lost one — rather than this
      // method throwing over a write the settlement itself no longer needs.
      this.logger.error(
        `Enqueued the confirmation for order ${order.id} but could not mark the outbox row sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    data: PaymentIntentSettlementJobData,
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
    data: PaymentIntentSettlementJobData,
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
 * Spends an order's reservations: units leave `reserved` and `stock` in the
 * same statement, and a promo use moves from reserved to settled.
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
): Promise<StockChange[]> {
  const changes: StockChange[] = [];

  for (const item of items) {
    const updated = await tx.sku.update({
      where: { id: item.skuId },
      data: {
        reserved: { decrement: item.quantity },
        stock: { decrement: item.quantity },
      },
    });

    changes.push({
      skuId: updated.id,
      previousStock: updated.stock + item.quantity,
      newStock: updated.stock,
      restockCycle: updated.restockCycle,
    });
  }

  return changes;
}
