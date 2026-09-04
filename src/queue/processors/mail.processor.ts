import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { renderMail } from '../../mail/mail.content';
import type { MailJobData } from '../../mail/mail.jobs';
import { MailTransport } from '../../mail/mail.transport';
import { JobName, QueueName } from '../queue.constants';

/**
 * The mail consumer. Like the maintenance one, it exists only in the
 * worker's module tree, so the API enqueues and never sends.
 */
@Processor(QueueName.Mail)
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly transport: MailTransport) {
    super();
  }

  async process(job: Job<MailJobData>): Promise<void> {
    // BullMQ types a job's name as a bare string, so the enum member is
    // widened rather than compared across types.
    const sendJob: string = JobName.SendMail;

    if (job.name !== sendJob) {
      throw new Error(`Unknown mail job: ${job.name}`);
    }

    await this.transport.send(renderMail(job.data));
  }

  /**
   * This log is the whole diagnosis, and that is a deliberate consequence.
   *
   * `MAIL_JOB_OPTIONS` discards a failed job outright — its payload carries
   * a live one-time token, and the database keeps only the hash — so there
   * is no failed entry to inspect afterwards. What is left is this line,
   * and it must carry enough to act on and nothing that should not be
   * written down: the kind, the recipient and the error.
   *
   * **Never `job.data`.** It holds the token.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<MailJobData>, error: Error): void {
    this.logger.error(
      `${job.data.kind} to ${job.data.to} failed after ${job.attemptsMade} attempt(s): ${error.message}`,
    );
  }
}
