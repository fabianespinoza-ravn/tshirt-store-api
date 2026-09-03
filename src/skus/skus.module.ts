import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { ProductsModule } from '../products/products.module';
import { SkusController } from './skus.controller';
import { SkusService } from './skus.service';

@Module({
  imports: [ProductsModule],
  controllers: [SkusController],
  providers: [SkusService, AppAbilityFactory, PoliciesGuard],
})
export class SkusModule {}
