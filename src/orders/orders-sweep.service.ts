import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
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
  /** How many it actually cancelled — the rest were taken by someone else. */
  cancelled: number;
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
@Injectable()
export class OrdersSweepService {
  private readonly logger = new Logger(OrdersSweepService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    for (const order of expired) {
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
    }

    // Only when it did something: this runs 1,440 times a day and a line per
    // run would bury everything else in the worker's output.
    if (cancelled > 0) {
      this.logger.log(
        `Swept ${cancelled} expired order(s) of ${expired.length} examined.`,
      );
    }

    return { examined: expired.length, cancelled };
  }
}
