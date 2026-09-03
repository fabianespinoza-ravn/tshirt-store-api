import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { CatalogController } from './catalog.controller';
import { ImagesService } from './images.service';
import { ProductsService } from './products.service';
import { SkusService } from './skus.service';

@Module({
  controllers: [CatalogController],
  providers: [
    ProductsService,
    ImagesService,
    SkusService,
    AppAbilityFactory,
    PoliciesGuard,
  ],
  exports: [ProductsService],
})
export class CatalogModule {}
