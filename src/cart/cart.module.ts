import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { StorageModule } from '../storage/storage.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  imports: [StorageModule],
  controllers: [CartController],
  providers: [CartService, AppAbilityFactory, PoliciesGuard],
})
export class CartModule {}
