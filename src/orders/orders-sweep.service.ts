import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { StripeService } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { recordStatus, releaseReservations } from './order-writes';

/**
 * How many expired orders one run will settle.
 *
 * Bounded so a backlog cannot turn a single run into an unbounded one that
 * holds a connection for minutes; whatever it does not reach is still
 * expired sixty seconds later, and the next run continues from the oldest.
 */
export const SWEEP_BATCH_SIZE = 100;

export interface SweepOutcome {
  /** Expired orders this run looked at. */
  examined: number;
  /** How many it actually cancelled. */
  cancelled: number;
  /**
   * How many it could not settle because their transaction was rejected —
   * a conflict with a concurrent checkout, almost always. Reported rather
   * than swallowed, so a run that quietly settled nothing is
   * distinguishable from one that had nothing to settle.
   */
  failed: number;
}

/**
 * The sweep, which is the half of expiry that `OrdersService` cannot do.
 *
 * That service releases a lapsed order when its owner comes back to buy
 * again. This one handles the owner who never comes back, whose units would
 * otherwise stay reserved against everybody else forever.
 *
 * It takes no `AuthenticatedUser` and applies no ability scope, and that is
 * the point rather than an omission: the sweep is a system actor. There is
 * nobody whose rows these are, and running it through a scope built for a
 * caller would either need a fake caller or a rule granting one user every
 * order — both of which would be a lie in the authorization model.
 */
/**
 * How long Stripe keeps an idempotency key, and therefore how long asking
 * for an order's intent again returns the same one rather than making a new
 * one. Documented by Stripe as 24 hours.
 */
const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class OrdersSweepService {
  private readonly logger = new Logger(OrdersSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  /**
   * Stops the order's payment from landing, and answers whether the stock is
   * now safe to release.
   *
   * **Cancel before releasing, never after.** Released first, a payment
   * confirming inside the window leaves a charged order whose units have
   * already been sold to somebody else — money taken for goods that are
   * gone. So this runs first, and a `false` here means the caller leaves the
   * order alone entirely: still PENDING, still holding its stock, swept
   * again next minute.
   *
   * Stripe is called outside the transaction for the reason checkout gives:
   * a third party's latency must not be held inside a `Serializable`
   * transaction's locks.
   *
   * The branch with no recorded intent is the interesting one. Checkout
   * commits the order before it calls Stripe, so an order can exist whose
   * intent was created and whose `Payment` row never was — a charge nothing
   * in this database knows about. Asking for the intent again under the
   * order's id as the idempotency key returns *that* intent rather than a
   * new one, so it can be cancelled. When no intent was ever created the
   * same call makes one, which is then cancelled unused; a cancelled intent
   * costs nothing, and paying that to close the window is the trade. This
   * only works while the key is still live — Stripe keeps one for 24 hours
   * and `PENDING_ORDER_TTL_MS` is 30 minutes, so the sweep always arrives
   * well inside it.
   *
   * An intent that has already succeeded refuses to cancel, which is exactly
   * the answer wanted: the money arrived, the stock stays reserved, and
   * settlement deals with it.
   */
  private async stopPayment(
    order: { id: string; total: number; createdAt: Date },
    now: Date,
  ): Promise<boolean> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id, stripePaymentIntentId: { not: null } },
      select: { stripePaymentIntentId: true },
      orderBy: { createdAt: 'desc' },
    });

    if (payment?.stripePaymentIntentId) {
      return this.stripe.cancelPaymentIntent(payment.stripePaymentIntentId);
    }

    // Recovery only works while the idempotency key is live. Past that,
    // asking again does not return the original intent — it creates a
    // second one, which this would then cancel while the first stayed
    // active, releasing the stock with a live charge still pointed at it.
    // That is worse than doing nothing, so past the window the order is
    // left alone and said out loud. It normally cannot happen:
    // `PENDING_ORDER_TTL_MS` is thirty minutes against a key that lives a
    // day, so only a worker down for most of that day gets here.
    if (now.getTime() - order.createdAt.getTime() > IDEMPOTENCY_KEY_TTL_MS) {
      this.logger.error(
        `Expired order ${order.id} is older than Stripe's idempotency window, so its original intent can no longer be reached by key. Left PENDING with its stock reserved; cancel the intent by hand.`,
      );

      return false;
    }

    const recovered = await this.stripe.createPaymentIntent(order);

    return this.stripe.cancelPaymentIntent(recovered.id);
  }

  /**
   * One transaction per order, deliberately, and not one for the batch.
   *
   * A `Serializable` transaction spanning a hundred orders would touch a
   * hundred SKUs, conflict with essentially every checkout running at the
   * same time, and lose the whole run to one collision. Per order the
   * contention is the size of one order, a conflict costs that order and
   * not the batch, and the work already done stays done.
   *
   * The write repeats the conditions it was selected by. `status: PENDING`
   * is what makes this safe against `OrdersService.settlePendingOrder`,
   * which cancels the same rows from the other direction — whoever moves the
   * row owns its reservations, and the loser returns nothing. `expiresAt`
   * is repeated too, so an order whose expiry was extended between the read
   * and the write is left alone rather than cancelled on stale grounds.
   */
  async sweep(now: Date = new Date()): Promise<SweepOutcome> {
    const expired = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        expiresAt: { not: null, lte: now },
      },
      include: { items: true },
      // Oldest first, so a backlog drains in the order it built up rather
      // than starving whatever happened to expire earliest.
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
    });

    let cancelled = 0;
    let failed = 0;

    for (const order of expired) {
      // Each order's failure is caught here, and that is what makes the
      // sentence above true. `Serializable` rejects a conflicting
      // transaction as P2034, and an uncaught rejection would leave the
      // loop at the first collision — the batch abandoned, and the orders
      // behind it still holding their stock until a later run happens to
      // reach them. The job runs once with no retries precisely because
      // the next minute's run is the retry; that only works if a single
      // conflict costs one order.
      try {
        // Before anything is released. The whole ordering argument is on
        // `stopPayment`; what matters here is that a refusal skips the
        // order rather than falling through to the release below.
        if (!(await this.stopPayment(order, now))) {
          failed += 1;
          this.logger.warn(
            `Left expired order ${order.id} alone: its payment could not be cancelled, so releasing its stock could oversell.`,
          );
          continue;
        }

        const settled = await this.prisma.$transaction(
          async (tx) => {
            const moved = await tx.order.updateMany({
              where: {
                id: order.id,
                status: OrderStatus.PENDING,
                expiresAt: { lte: now },
              },
              data: { status: OrderStatus.CANCELLED, expiresAt: null },
            });

            if (moved.count === 0) return false;

            await releaseReservations(tx, order.items);
            await recordStatus(tx, order.id, OrderStatus.CANCELLED);
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (settled) cancelled += 1;
      } catch (error) {
        failed += 1;
        // Logged per order rather than counted silently: a sweep that fails
        // on the same order every minute forever is a different problem
        // from one that loses a race occasionally, and only the message
        // tells them apart.
        this.logger.warn(
          `Could not settle expired order ${order.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Only when it did something: this runs 1,440 times a day and a line per
    // run would bury everything else in the worker's output.
    if (cancelled > 0) {
      this.logger.log(
        `Swept ${cancelled} expired order(s) of ${expired.length} examined.`,
      );
    }

    return { examined: expired.length, cancelled, failed };
  }
}
