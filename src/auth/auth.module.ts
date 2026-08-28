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
          // En segundos y no como cadena: `@nestjs/jwt` 12 tipa `expiresIn` con
          // el literal de `ms`, que una `string` cualquiera no satisface. Pasar
          // el número evita el cast y deja la unidad a la vista, y de paso
          // `parseDuration` valida el formato al arrancar en vez de al firmar.
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
    // Autenticación global. Se abre con @Public(); la autorización va aparte.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
