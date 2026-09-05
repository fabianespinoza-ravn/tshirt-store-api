import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { SettlementJobData } from '../../payments/webhooks/settlement.jobs';
import {
  SettlementService,
  type SettlementOutcome,
} from '../../payments/webhooks/settlement.service';
import { JobName, QueueName } from '../queue.constants';

/**
 * The settlement consumer, and like the other two it exists only in the
 * worker's module tree — so the API verifies and enqueues, and this process
 * is the only one that moves an order or refunds a charge.
 *
 * It holds no logic of its own on purpose. Everything about the money is in
 * `SettlementService`, where it can be read next to the transaction that
 * performs it; a processor that decided anything would be a second place to
 * look when a payment goes wrong.
 *
 * An unrecognised job name throws, for the reason the maintenance processor
 * gives: a queue that quietly drops work it does not recognise is how a
 * renamed job stops running while every dashboard still reads healthy. Here
 * the stakes are higher than a missed sweep — the dropped work is a payment.
 */
@Processor(QueueName.Settlement)
export class SettlementProcessor extends WorkerHost {
  private readonly logger = new Logger(SettlementProcessor.name);

  constructor(private readonly settlement: SettlementService) {
    super();
  }

  async process(job: Job<SettlementJobData>): Promise<SettlementOutcome> {
    // BullMQ types a job's name as a bare string, so the enum member is
    // widened rather than compared across types.
    const settleJob: string = JobName.SettlePayment;

    if (job.name !== settleJob) {
      throw new Error(`Unknown settlement job: ${job.name}`);
    }

    return this.settlement.settle(job.data);
  }

  /**
   * A failure here is money that has moved at Stripe and not in this
   * database, so the line has to carry enough to act on: which event, which
   * order, and how many attempts have already gone.
   *
   * Unlike mail, this queue keeps its failures — `removeOnFail: false` —
   * so the job itself is still there to inspect and retry by hand. The log
   * exists so that somebody notices before the alert on the dead-letter
   * queue's age does. Its payload is identifiers only, which is why naming
   * them here is safe; the customer's data stayed in `webhook_events`.
   *
   * The job is optional because BullMQ types it that way for an event that
   * arrives after its job was removed.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<SettlementJobData> | undefined, error: Error): void {
    if (!job) {
      this.logger.error(
        `A settlement job failed and was already removed, so the payment it carried is unknown: ${error.message}`,
        error.stack,
      );
      return;
    }

    this.logger.error(
      `Settlement of Stripe event ${job.data.stripeEventId} for order ${job.data.orderId} failed after ${job.attemptsMade} attempt(s): ${error.message}`,
      error.stack,
    );
  }
}
