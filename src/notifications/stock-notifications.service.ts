import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { JobName, QueueName } from '../queue/queue.constants';
import type { StockNotificationJobData } from './stock-notification.jobs';
import { fallsToThreshold, risesAboveThreshold } from './stock-threshold';

/**
 * The two numbers a crossing needs, plus the identity of what crossed.
 *
 * `previousStock` is the caller's to supply because only the caller has it.
 * Prisma's `update` returns the row *after* the write, so a decrement that
 * used `{ stock: { decrement: n } }` reconstructs the previous value as
 * `updated.stock + n`; a write that read the row first already has it.
 */
export interface StockChange {
  skuId: string;
  previousStock: number;
  newStock: number;
  /** `Sku.restockCycle` as it stands after the write. */
  restockCycle: number;
}

/**
 * The producer half of the stock notification, and the only part of it that
 * runs anywhere near a write that moves stock.
 *
 * **Where the crossing is observed, and why there.** Not in a read, not on a
 * schedule, and not in the consumer: in the transaction that changes the
 * number. A poll asking "which SKUs are at or below three?" cannot tell a
 * SKU that just arrived there from one that has been sitting there for a
 * week, so it either notifies every cycle or needs a marker that is exactly
 * this crossing written down after the fact. A caller that has just written
 * the row has both values for free and needs no marker at all.
 *
 * That places it at payment settlement. Stock is the count of physical
 * units, and the only thing that removes a unit for good is a sale being
 * settled — order creation moves `reserved`, not `stock`, so
 * `availableOf()` falls at checkout while `stock` does not, and settlement
 * decrements both together so `availableOf()` does *not* move there. The
 * brief says "the stock of a product", so `stock` is the counter that is
 * watched and settlement is the moment it drops.
 *
 * What this method does **not** do is find recipients or send anything. It
 * enqueues, so a settlement that has already taken the money is never held
 * up, retried or rolled back on account of an email.
 */
@Injectable()
export class StockNotificationsService {
  private readonly logger = new Logger(StockNotificationsService.name);

  constructor(
    @InjectQueue(QueueName.StockNotification)
    private readonly queue: Queue<StockNotificationJobData>,
  ) {}

  /**
   * Call this **after the transaction that changed the stock has
   * committed.** Enqueuing inside it would publish a job for a write that
   * may still roll back, and the job would then dispatch against a stock
   * level that never existed.
   *
   * Returns whether a job was enqueued, so a caller can log the crossing
   * without repeating the rule.
   *
   * The job id collapses the duplicates it can: two settlements landing on
   * the same SKU in the same cycle describe one crossing, and BullMQ refuses
   * the second `add` while the first job is still known. It is a narrowing,
   * not a guarantee — `STOCK_NOTIFICATION_JOB_OPTIONS` removes a job on
   * completion, which frees the id — so the real "notify once" lives in
   * `uq_stock_notifications_user_sku_cycle` and is enforced by the consumer.
   */
  async observeStockChange(change: StockChange): Promise<boolean> {
    if (!fallsToThreshold(change.previousStock, change.newStock)) return false;

    await this.queue.add(
      JobName.NotifyRestock,
      { skuId: change.skuId, restockCycle: change.restockCycle },
      { jobId: `${change.skuId}:${change.restockCycle}` },
    );

    this.logger.log(
      `Sku ${change.skuId} fell from ${change.previousStock} to ${change.newStock}; notifying cycle ${change.restockCycle}.`,
    );

    return true;
  }

  /**
   * The other half of the rule, for whoever owns the write that raises
   * stock — today `SkusService.update`, tomorrow a restock route.
   *
   * It takes the transaction client rather than using its own, because the
   * cycle must advance in the same statement batch as the stock it
   * describes. A cycle bumped after the commit leaves a window in which a
   * sale can cross the threshold and be recorded against the old cycle,
   * which is the one row that would then block the real notification.
   *
   * Returns whether the cycle advanced.
   */
  async openCycleOnRestock(
    tx: Prisma.TransactionClient,
    skuId: string,
    previousStock: number,
    newStock: number,
  ): Promise<boolean> {
    if (!risesAboveThreshold(previousStock, newStock)) return false;

    await tx.sku.update({
      where: { id: skuId },
      data: { restockCycle: { increment: 1 } },
    });

    return true;
  }
}
