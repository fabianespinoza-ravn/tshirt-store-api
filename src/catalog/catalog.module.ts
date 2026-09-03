import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { ProductsModule } from '../products/products.module';
import { CatalogController } from './catalog.controller';
import { ImagesService } from './images.service';
import { SkusService } from './skus.service';

@Module({
  imports: [ProductsModule],
  controllers: [CatalogController],
  providers: [ImagesService, SkusService, AppAbilityFactory, PoliciesGuard],
})
export class CatalogModule {}
