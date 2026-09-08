import { Controller, Get, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { configureApp } from '../app.setup';
import { NodeEnv } from '../config/env.validation';
import { setupSwagger } from './swagger';

@Controller('probe')
class ProbeController {
  @Get()
  read(): void {}
}

describe('Swagger setup', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    const config = {
      get: <T>(key: string, fallback?: T): T | undefined =>
        (({ NODE_ENV: NodeEnv.Test, PORT: 8080 })[key] as T | undefined) ??
        fallback,
    } as ConfigService;

    app = moduleRef.createNestApplication();
    configureApp(app, config);
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves globally-prefixed paths relative to the current host', async () => {
    const response = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/api/v1/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;

    expect(document.servers).toEqual([]);
    expect(document.paths).toHaveProperty('/api/v1/probe');
  });
});
