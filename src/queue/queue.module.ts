import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import {
  MAIL_JOB_OPTIONS,
  QueueName,
  SETTLEMENT_JOB_OPTIONS,
  STOCK_NOTIFICATION_JOB_OPTIONS,
  SWEEP_JOB_OPTIONS,
} from './queue.constants';

/**
 * The producer side, and only the producer side.
 *
 * This module registers the connection and the four queues so anything can
 * enqueue. It deliberately registers **no processor**: consumers live in
 * `worker.module.ts`, which only `worker.ts` imports. If a processor were
 * declared here the API process would consume its own jobs, and the two
 * processes the architecture write-up describes would be one process
 * wearing two hats — the queue would still work and the deploy would still
 * have a worker service, doing nothing.
 *
 * `@nestjs/bullmq` is pinned to 11: see `dependencies.spec.ts` for what
 * version 12 does to the test suite.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          // BullMQ requires this: with a retry limit, a command issued while
          // Redis is briefly unreachable throws instead of waiting, and a
          // job that was never enqueued is indistinguishable from one that
          // was never asked for.
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QueueName.Mail, defaultJobOptions: MAIL_JOB_OPTIONS },
      { name: QueueName.Maintenance, defaultJobOptions: SWEEP_JOB_OPTIONS },
      { name: QueueName.Settlement, defaultJobOptions: SETTLEMENT_JOB_OPTIONS },
      {
        name: QueueName.StockNotification,
        defaultJobOptions: STOCK_NOTIFICATION_JOB_OPTIONS,
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
