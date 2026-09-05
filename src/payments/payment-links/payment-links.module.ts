import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../../auth/guards/policies.guard';
import { PaymentsModule } from '../payments.module';
import { PaymentLinkCheckoutService } from './payment-link-checkout.service';
import { PaymentLinksController } from './payment-links.controller';
import { PaymentLinksService } from './payment-links.service';

/**
 * `PaymentLinkCheckoutService` is exported and has no controller of its own,
 * because the route that feeds it is not this module's: `POST /webhooks/stripe`
 * verifies the signature and deduplicates the event, then calls
 * `settleCheckoutSession`. Importing this module is how that dispatcher — in
 * the API tree or in the worker's — reaches it.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [PaymentLinksController],
  providers: [
    PaymentLinksService,
    PaymentLinkCheckoutService,
    AppAbilityFactory,
    PoliciesGuard,
  ],
  exports: [PaymentLinkCheckoutService],
})
export class PaymentLinksModule {}
