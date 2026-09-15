import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './shared/config/env.validation';
import { MailModule } from './platform/mail/mail.module';
import { MailTransport } from './platform/mail/mail.transport';
import { NotificationsModule } from './platform/notifications/notifications.module';
import { StockNotificationDispatcher } from './platform/notifications/stock-notification.dispatcher';
import { OrdersSweepService } from './checkout/orders/orders-sweep.service';
import { PaymentsModule } from './checkout/payments/payments.module';
import { PaymentLinksModule } from './checkout/payments/payment-links/payment-links.module';
import { OrderConfirmationOutboxService } from './checkout/payments/webhooks/order-confirmation-outbox.service';
import { SettlementService } from './checkout/payments/webhooks/settlement.service';
import { PrismaModule } from './platform/prisma/prisma.module';
import { ConfirmationOutboxScheduler } from './platform/queue/confirmation-outbox.scheduler';
import { ConfirmationOutboxProcessor } from './platform/queue/processors/confirmation-outbox.processor';
import { MailProcessor } from './platform/queue/processors/mail.processor';
import { MaintenanceProcessor } from './platform/queue/processors/maintenance.processor';
import { SettlementProcessor } from './platform/queue/processors/settlement.processor';
import { StockNotificationProcessor } from './platform/queue/processors/stock-notification.processor';
import { QueueModule } from './platform/queue/queue.module';
import { SweepScheduler } from './platform/queue/sweep.scheduler';
import { StorageModule } from './platform/storage/storage.module';

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
    PaymentLinksModule,
    // Settlement confirms a paid order by email, so the worker produces mail
    // as well as consuming it. The module carries the producer and nothing
    // else; the transport below is what actually sends.
    MailModule,
    // The stock notification is the first job that reads an object back out
    // of S3 — the product's image travels inside the message rather than as
    // a link — so the worker needs storage for the first time.
    StorageModule,
    NotificationsModule,
  ],
  providers: [
    OrdersSweepService,
    MaintenanceProcessor,
    SweepScheduler,
    MailTransport,
    MailProcessor,
    SettlementService,
    SettlementProcessor,
    StockNotificationDispatcher,
    StockNotificationProcessor,
    OrderConfirmationOutboxService,
    ConfirmationOutboxProcessor,
    ConfirmationOutboxScheduler,
  ],
})
export class WorkerModule {}
