import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MailService } from '../../src/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from './database';
import { MailRecorder } from './mail-recorder';
import { ResettableThrottlerStorage } from './throttler-storage';

export type HttpClient = ReturnType<typeof request>;

export interface E2eApp {
  app: INestApplication;
  prisma: PrismaService;
  mail: MailRecorder;
  throttler: ResettableThrottlerStorage;
  /** A Supertest client bound to the application's own HTTP server. */
  request: () => HttpClient;
  /** Empties every table and the recorded mail; leaves the throttler alone. */
  resetData: () => Promise<void>;
  /** `resetData` plus the throttler's counters. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * The real application, compiled the way `main.ts` does it, with exactly
 * two providers replaced: MailService, so a test can read the one-time
 * tokens the flow sends, and the throttler's storage, so counters reset
 * between tests. Prisma is real and points at the e2e database; guards,
 * pipes and the filter are the production ones, via `configureApp`.
 */
export async function createE2eApp(): Promise<E2eApp> {
  const mail = new MailRecorder();
  const throttler = new ResettableThrottlerStorage();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MailService)
    .useValue(mail)
    .overrideProvider(ThrottlerStorage)
    .useValue(throttler)
    .compile();

  const app = moduleFixture.createNestApplication();
  configureApp(app, app.get(ConfigService));
  await app.init();

  const prisma = app.get(PrismaService);

  const resetData = async (): Promise<void> => {
    await resetDatabase(prisma);
    mail.reset();
  };

  return {
    app,
    prisma,
    mail,
    throttler,
    // getHttpServer() is typed `any`; the assertion keeps the client typed
    // without pretending to know more than Nest does about the server.
    request: () =>
      request(app.getHttpServer() as Parameters<typeof request>[0]),
    resetData,
    reset: async () => {
      await resetData();
      throttler.reset();
    },
    close: () => app.close(),
  };
}
