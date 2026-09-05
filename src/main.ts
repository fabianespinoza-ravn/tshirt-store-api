import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { setupSwagger } from './common/swagger';

async function bootstrap() {
  // `rawBody` keeps the untouched request body alongside the parsed one, and
  // the Stripe webhook is the reason it is on. A signature is computed over
  // the exact bytes Stripe sent: once `express.json()` has parsed and
  // re-serialised them, key order and whitespace are no longer guaranteed to
  // match, and `constructEvent` rejects every delivery. The SDK's own error
  // says as much, which is the failure this option prevents.
  //
  // It is a `NestFactory.create` option rather than something `configureApp`
  // could add, because the body parser is wired while the application is
  // being built. Any harness that stands an application up by hand has to
  // pass it too, or the webhook route answers 400 to a signature that is
  // in fact valid.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

  configureApp(app, config);
  setupSwagger(app, config);

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
