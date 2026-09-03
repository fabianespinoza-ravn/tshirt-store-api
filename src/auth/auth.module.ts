import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { parseDuration } from '../common/ids';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          // In seconds and not as a string: `@nestjs/jwt` 12 types `expiresIn`
          // with the `ms` literal, which an arbitrary `string` doesn't
          // satisfy. Passing the number avoids the cast and keeps the unit
          // visible, and along the way `parseDuration` validates the format
          // at boot instead of at signing time.
          expiresIn:
            parseDuration(config.get<string>('JWT_ACCESS_TTL', '15m')) / 1000,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    // Global authentication. It's opened up with @Public(); authorization is
    // separate.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
