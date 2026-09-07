import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { PromoCodesController } from './promo-codes.controller';
import { PromoCodesService } from './promo-codes.service';

@Module({
  controllers: [PromoCodesController],
  providers: [PromoCodesService, AppAbilityFactory, PoliciesGuard],
})
export class PromoCodesModule {}
