import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { PaymentLinksModule } from '../payments/payment-links/payment-links.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [PaymentLinksModule],
  controllers: [ProductsController],
  providers: [ProductsService, AppAbilityFactory, PoliciesGuard],
  exports: [ProductsService],
})
export class ProductsModule {}
