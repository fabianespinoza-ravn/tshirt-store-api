import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments.module';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * The producer half of settlement: the route, its verification, and the
 * enqueue.
 *
 * `SettlementService` and its processor are deliberately absent — they are
 * declared in `worker.module.ts` and nowhere else, so importing this module
 * cannot turn the API into the process that moves orders and refunds
 * charges. `QueueModule` is global, which is where the settlement queue
 * comes from.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [StripeWebhookController],
  providers: [StripeWebhookService],
})
export class StripeWebhookModule {}
