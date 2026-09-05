import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';

/**
 * Exported rather than kept private because both trees need it: the API
 * creates intents at checkout, and the worker cancels and refunds them.
 */
@Module({
  providers: [StripeService],
  exports: [StripeService],
})
export class PaymentsModule {}
