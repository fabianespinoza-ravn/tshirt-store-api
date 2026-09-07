import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  OrderConfirmationOutboxService,
  type ConfirmationOutboxDrainOutcome,
} from '../../payments/webhooks/order-confirmation-outbox.service';
import { JobName, QueueName } from '../queue.constants';

/**
 * The confirmation outbox consumer, like the other four scheduled by this
 * worker: it exists only in the worker's module tree, so the API that
 * settles a payment never drains what it wrote.
 *
 * It holds no logic of its own, for the reason `SettlementProcessor` gives —
 * everything about what gets retried and how lives in
 * `OrderConfirmationOutboxService`, next to the rows it reads.
 *
 * An unrecognised job name throws, same as the maintenance and settlement
 * processors: a queue that quietly drops work it does not recognise is how a
 * renamed job stops running while every dashboard still reads healthy, and
 * here that would mean confirmations silently piling up PENDING forever.
 */
@Processor(QueueName.ConfirmationOutbox)
export class ConfirmationOutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(ConfirmationOutboxProcessor.name);

  constructor(private readonly outbox: OrderConfirmationOutboxService) {
    super();
  }

  async process(job: Job): Promise<ConfirmationOutboxDrainOutcome> {
    // BullMQ types a job's name as a bare string, so the enum member is
    // widened rather than compared across types.
    const drainJob: string = JobName.DrainConfirmationOutbox;

    if (job.name !== drainJob) {
      throw new Error(`Unknown confirmation outbox job: ${job.name}`);
    }

    return this.outbox.drain();
  }

  /**
   * The sweep's own reasoning applies here without change: this queue does
   * not retry, so a failure here is the whole story of that run, and a
   * drain that fails every minute while the queue looks busy is exactly the
   * failure mode this line exists to surface.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      `${job?.name ?? 'A removed confirmation outbox job'} failed: ${error.message}`,
      error.stack,
    );
  }
}
