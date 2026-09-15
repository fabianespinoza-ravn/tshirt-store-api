import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '@auth/auth.module';
import { CartModule } from '@checkout/cart/cart.module';
import { CategoriesModule } from '@catalog/categories/categories.module';
import { ImagesModule } from '@catalog/images/images.module';
import { LikesModule } from '@catalog/likes/likes.module';
import { MailModule } from '@platform/mail/mail.module';
import { GuestOrdersModule } from '@checkout/orders/guest-orders/guest-orders.module';
import { NotificationsModule } from '@platform/notifications/notifications.module';
import { OrdersModule } from '@checkout/orders/orders.module';
import { PaymentLinksModule } from '@checkout/payments/payment-links/payment-links.module';
import { PrismaModule } from '@platform/prisma/prisma.module';
import { PromoCodesModule } from '@checkout/promo-codes/promo-codes.module';
import { StripeWebhookModule } from '@checkout/payments/webhooks/stripe-webhook.module';
import { ProductsModule } from '@catalog/products/products.module';
import { QueueModule } from '@platform/queue/queue.module';
import { SkusModule } from '@catalog/skus/skus.module';
import { StorageModule } from '@platform/storage/storage.module';
import { validateEnv } from '@shared/config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // The module is registered but NOT its global guard: the limit is applied
    // per operation with @RateLimited(), because the contract only declares
    // 429 where it declares it. See common/decorators/rate-limited.decorator.ts.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('THROTTLE_TTL', 60_000),
            limit: config.get<number>('THROTTLE_LIMIT', 10),
          },
        ],
      }),
    }),
    PrismaModule,
    QueueModule,
    MailModule,
    NotificationsModule,
    StorageModule,
    AuthModule,
    CategoriesModule,
    ProductsModule,
    SkusModule,
    ImagesModule,
    LikesModule,
    CartModule,
    OrdersModule,
    GuestOrdersModule,
    PaymentLinksModule,
    PromoCodesModule,
    StripeWebhookModule,
  ],
})
export class AppModule {}
