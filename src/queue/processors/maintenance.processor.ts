import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  OrdersSweepService,
  type SweepOutcome,
} from '../../orders/orders-sweep.service';
import { JobName, QueueName } from '../queue.constants';

/**
 * The maintenance consumer. It exists only in the worker's module tree, so
 * the API never processes what it enqueues.
 *
 * An unknown job name throws rather than being ignored. A queue quietly
 * dropping work it does not recognise is how a renamed job stops running
 * while every dashboard still reports the queue as healthy — and with
 * `removeOnFail: false` the unrecognised job stays in the failed set, where
 * somebody can see what it was.
 */
@Processor(QueueName.Maintenance)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private readonly sweep: OrdersSweepService) {
    super();
  }

  async process(job: Job): Promise<SweepOutcome> {
    // BullMQ types a job's name as a bare string, so the enum member is
    // widened rather than compared across types — the comparison is the
    // same, and the name still comes from one place.
    const sweepJob: string = JobName.SweepExpiredOrders;

    if (job.name !== sweepJob) {
      throw new Error(`Unknown maintenance job: ${job.name}`);
    }

    return this.sweep.sweep();
  }

  /**
   * The sweep is the one job that does not retry, so a failure here is the
   * whole story of that run. It is logged because the alternative — a job
   * that fails silently every minute while the queue looks busy — is the
   * failure mode this block exists to avoid.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(`${job.name} failed: ${error.message}`, error.stack);
  }
}
