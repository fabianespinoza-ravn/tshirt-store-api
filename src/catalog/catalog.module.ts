import { Module } from '@nestjs/common';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import { PoliciesGuard } from '../auth/guards/policies.guard';
import { CatalogController } from './catalog.controller';
import { CategoriesService } from './categories.service';
import { ImagesService } from './images.service';
import { ProductsService } from './products.service';
import { SkusService } from './skus.service';

@Module({
  controllers: [CatalogController],
  providers: [
    CategoriesService,
    ProductsService,
    ImagesService,
    SkusService,
    AppAbilityFactory,
    PoliciesGuard,
  ],
  exports: [ProductsService],
})
export class CatalogModule {}
