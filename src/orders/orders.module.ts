import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, AppAbilityFactory, PoliciesGuard],
})
export class OrdersModule {}
