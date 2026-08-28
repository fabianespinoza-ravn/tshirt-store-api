import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'api/v1/docs';

// La fuente de verdad es info.version en W2-API/openapi.yaml: servir el documento con otra versión es una divergencia con el entregable, no un detalle.
const CONTRACT_VERSION = '1.0.2';

export function setupSwagger(app: INestApplication, env: ConfigService): void {
  const config = new DocumentBuilder()
    .setTitle('T-Shirt Store API')
    .setVersion(CONTRACT_VERSION)
    .setDescription(
      'REST contract for the T-Shirt Store. JSON over the /api/v1 base path, ' +
        'camelCase fields, UUID identifiers. Monetary amounts are integers in ' +
        'the minor unit of the single currency. Errors are RFC 9457 problem ' +
        'documents served as application/problem+json.',
    )
    // El puerto sale de la configuración, no de una constante: anunciar uno que
    // no es el que escucha manda a cualquiera que use el documento a la nada.
    .addServer(
      `http://localhost:${env.get<number>('PORT', 3000)}/api/v1`,
      'Local development',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearerAuth',
    )
    .addCookieAuth(
      'refreshToken',
      { type: 'apiKey', in: 'cookie' },
      'cookieAuth',
    )
    .addTag('Authentication')
    .addTag('Catalog')
    .addTag('Cart')
    .addTag('Orders')
    .addTag('Payment links')
    .addTag('Promotions')
    .addTag('Webhooks')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document);
}
