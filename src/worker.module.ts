import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { MailModule } from './mail/mail.module';
import { MailTransport } from './mail/mail.transport';
import { OrdersSweepService } from './orders/orders-sweep.service';
import { PaymentsModule } from './payments/payments.module';
import { SettlementService } from './payments/webhooks/settlement.service';
import { PrismaModule } from './prisma/prisma.module';
import { MailProcessor } from './queue/processors/mail.processor';
import { MaintenanceProcessor } from './queue/processors/maintenance.processor';
import { SettlementProcessor } from './queue/processors/settlement.processor';
import { QueueModule } from './queue/queue.module';
import { SweepScheduler } from './queue/sweep.scheduler';

/**
 * What the worker process loads, and nothing more.
 *
 * It is not `AppModule`. The API's module tree pulls in controllers, guards,
 * the throttler and the HTTP pipeline, none of which a process with no
 * server needs — and importing it would also mean any future change to the
 * request path could break the worker for reasons that have nothing to do
 * with jobs.
 *
 * The split runs the other way too: the processors are declared here and
 * never in `AppModule`, so the API enqueues and the worker consumes. Both
 * halves import `QueueModule`, which carries the connection and the queues
 * and no consumer at all.
 *
 * Processors arrive one at a time as their jobs do.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    QueueModule,
    PaymentsModule,
    // Settlement confirms a paid order by email, so the worker produces mail
    // as well as consuming it. The module carries the producer and nothing
    // else; the transport below is what actually sends.
    MailModule,
  ],
  providers: [
    OrdersSweepService,
    MaintenanceProcessor,
    SweepScheduler,
    MailTransport,
    MailProcessor,
    SettlementService,
    SettlementProcessor,
  ],
})
export class WorkerModule {}
