import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  CONFIRMATION_OUTBOX_DRAIN_EVERY_MS,
  JobName,
  QueueName,
} from './queue.constants';

/**
 * A stable id, so the scheduler is replaced rather than duplicated on every
 * boot — the same reason `SWEEP_SCHEDULER_ID` is stable. Changing the
 * interval means upserting under the same id; changing this string means
 * running two drains.
 */
export const CONFIRMATION_OUTBOX_SCHEDULER_ID = 'order-confirmation-outbox';

/**
 * Registers the repeatable confirmation outbox drain, and lives in the
 * worker for the same reason `SweepScheduler` does: the schedule belongs
 * with the process that performs the work, not with however many API
 * instances happen to be deployed.
 */
@Injectable()
export class ConfirmationOutboxScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConfirmationOutboxScheduler.name);

  constructor(
    @InjectQueue(QueueName.ConfirmationOutbox) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CONFIRMATION_OUTBOX_SCHEDULER_ID,
      { every: CONFIRMATION_OUTBOX_DRAIN_EVERY_MS },
      { name: JobName.DrainConfirmationOutbox },
    );

    this.logger.log(
      `Confirmation outbox drain scheduled every ${CONFIRMATION_OUTBOX_DRAIN_EVERY_MS / 1000}s as "${CONFIRMATION_OUTBOX_SCHEDULER_ID}".`,
    );
  }
}
