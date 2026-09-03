import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { setupSwagger } from './common/swagger';
import { NodeEnv } from './config/env.validation';

function corsOrigin(config: ConfigService): string[] | boolean {
  const raw = config.get<string>('CORS_ORIGINS')?.trim();

  if (raw) {
    return raw.split(',').map((origin) => origin.trim());
  }

  // With no list, development reflects the origin and production allows
  // none. The safe failure is to deny, not to allow everything.
  return config.get<string>('NODE_ENV') === NodeEnv.Development;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api/v1');

  app.use(helmet());
  // /auth/refresh and /auth/sign-out authenticate with the httpOnly cookie,
  // so without this request.cookies arrives empty and both respond 401.
  app.use(cookieParser());
  app.enableCors({ origin: corsOrigin(config), credentials: true });

  // whitelist drops anything not declared in the DTO, and forbidNonWhitelisted
  // rejects it with 400. transform applies the DTO's types to the request.
  //
  // On the query string this rejects any extra parameter, `utm_source`
  // included. That's deliberate for now: it's the same thing that stops
  // `customerId` from being silently ignored. See finding 35 of
  // ATAQUE-DISENO.md.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Goes after the pipe on purpose: it's what translates its 400s into the
  // RFC 9457 document the contract declares.
  app.useGlobalFilters(new ProblemDetailsFilter());

  setupSwagger(app, config);

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
