import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobName, QueueName, SWEEP_EVERY_MS } from './queue.constants';

/**
 * A stable id, so the scheduler is replaced rather than duplicated on every
 * boot. Changing the interval means upserting under the same id; changing
 * this string means running two sweeps.
 */
export const SWEEP_SCHEDULER_ID = 'expired-orders';

/**
 * Registers the repeatable sweep, and lives in the **worker** rather than
 * the API.
 *
 * `upsertJobScheduler` is idempotent, so either process could do it without
 * creating duplicates — but the schedule belongs with the process that
 * performs the work. Scaling the API to three instances would otherwise have
 * three of them writing the same schedule on every deploy, and the worker
 * being down would leave a schedule producing jobs nobody consumes.
 *
 * `upsertJobScheduler` is the API in bullmq 6; the `repeat` option on `add`
 * that older guides use is deprecated. Checked against the installed
 * package, not remembered.
 */
@Injectable()
export class SweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SweepScheduler.name);

  constructor(
    @InjectQueue(QueueName.Maintenance) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SWEEP_SCHEDULER_ID,
      { every: SWEEP_EVERY_MS },
      { name: JobName.SweepExpiredOrders },
    );

    this.logger.log(
      `Sweep scheduled every ${SWEEP_EVERY_MS / 1000}s as "${SWEEP_SCHEDULER_ID}".`,
    );
  }
}
