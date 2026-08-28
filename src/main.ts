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

  // Sin lista, desarrollo refleja el origen y producción no permite ninguno.
  // El fallo seguro es no permitir, no permitirlo todo.
  return config.get<string>('NODE_ENV') === NodeEnv.Development;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api/v1');

  app.use(helmet());
  // /auth/refresh y /auth/sign-out se autentican con la cookie httpOnly, asi
  // que sin esto request.cookies llega vacio y las dos responden 401.
  app.use(cookieParser());
  app.enableCors({ origin: corsOrigin(config), credentials: true });

  // whitelist descarta lo no declarado en el DTO y forbidNonWhitelisted lo
  // rechaza con 400. transform aplica los tipos del DTO a la petición.
  //
  // Sobre la query esto rechaza cualquier parámetro extra, un `utm_source`
  // incluido. Es deliberado por ahora: es lo mismo que impide que `customerId`
  // se ignore en silencio. Ver el hallazgo 35 de ATAQUE-DISENO.md.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Va después del pipe a propósito: es quien traduce sus 400 al documento
  // RFC 9457 que declara el contrato.
  app.useGlobalFilters(new ProblemDetailsFilter());

  setupSwagger(app, config);

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
