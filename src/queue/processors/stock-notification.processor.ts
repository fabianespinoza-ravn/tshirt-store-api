import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { StockNotificationDispatcher } from '../../notifications/stock-notification.dispatcher';
import type {
  StockNotificationJobData,
  StockNotificationOutcome,
} from '../../notifications/stock-notification.jobs';
import { JobName, QueueName } from '../queue.constants';

/**
 * The consumer for the crossing the brief marks (MUST), and — like the other
 * two — it exists only in the worker's module tree, so the process that
 * takes the payment never fans out the emails it caused.
 *
 * It is thin on purpose. Everything that decides anything lives in
 * `StockNotificationDispatcher`, which needs no queue to run; what is left
 * here is the queue's own contract: recognise the job name, refuse the ones
 * it does not know, and leave a usable line behind when a run fails.
 *
 * An unknown name throws for the reason the maintenance processor gives:
 * a queue that quietly drops work it does not recognise is how a renamed job
 * stops running while every dashboard still reports the queue as healthy.
 */
@Processor(QueueName.StockNotification)
export class StockNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(StockNotificationProcessor.name);

  constructor(private readonly dispatcher: StockNotificationDispatcher) {
    super();
  }

  async process(
    job: Job<StockNotificationJobData>,
  ): Promise<StockNotificationOutcome> {
    // BullMQ types a job's name as a bare string, so the enum member is
    // widened rather than compared across types.
    const notifyJob: string = JobName.NotifyRestock;

    if (job.name !== notifyJob) {
      throw new Error(`Unknown stock notification job: ${job.name}`);
    }

    return this.dispatcher.dispatch(job.data);
  }

  /**
   * `STOCK_NOTIFICATION_JOB_OPTIONS` discards a failed job, so this line is
   * the only record that a crossing went unannounced.
   *
   * Its payload may be named, and that is the difference from the mail
   * queue: it holds two identifiers and no address, no name and no token.
   * The addresses this job produces live in the *mail* jobs it enqueues, and
   * those must never be logged from here or anywhere else.
   *
   * The job is optional because BullMQ types it that way — a stalled job is
   * moved to the failed set and `removeOnFail: true` deletes it in the same
   * breath, which is exactly this queue's policy — and dereferencing a
   * missing one would throw inside the listener and destroy the one artefact
   * the failure leaves.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<StockNotificationJobData> | undefined, error: Error): void {
    const what = job
      ? `Sku ${job.data.skuId} (cycle ${job.data.restockCycle})`
      : 'A removed stock notification job';

    this.logger.error(
      `${what} failed after ${job?.attemptsMade ?? 0} attempt(s): ${error.message}`,
      error.stack,
    );
  }
}
