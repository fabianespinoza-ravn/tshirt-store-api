import { applyDecorators, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { ProblemKind } from './problem/problem.catalog';

export const SWAGGER_PATH = 'api/v1/docs';

/**
 * Declares an operation's error responses in the document from the catalog,
 * instead of repeating the code and text at every endpoint. Problems are
 * grouped by status because OpenAPI only allows one response per code: 403
 * can mean missing permission or an unverified email, and both have to
 * appear under the same 403.
 */
export function ApiProblems(...kinds: ProblemKind[]) {
  const titlesByStatus = new Map<number, string[]>();

  for (const kind of kinds) {
    titlesByStatus.set(kind.status, [
      ...(titlesByStatus.get(kind.status) ?? []),
      kind.title,
    ]);
  }

  return applyDecorators(
    ...[...titlesByStatus].map(([status, titles]) =>
      ApiResponse({ status, description: titles.join(' · ') }),
    ),
  );
}

// The source of truth is info.version in W2-API/openapi.yaml: serving the
// document with another version is a divergence from the deliverable, not a
// detail.
const CONTRACT_VERSION = '1.0.3';

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
    // The port comes from configuration, not from a constant: announcing one
    // that isn't the one actually listening sends anyone using the document
    // nowhere.
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
