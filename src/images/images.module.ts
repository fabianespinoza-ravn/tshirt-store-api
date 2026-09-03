import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { ProductsModule } from '../products/products.module';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

@Module({
  imports: [ProductsModule],
  controllers: [ImagesController],
  providers: [ImagesService, AppAbilityFactory, PoliciesGuard],
})
export class ImagesModule {}
