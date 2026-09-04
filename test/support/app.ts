import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MailTransport } from '../../src/mail/mail.transport';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SweepScheduler } from '../../src/queue/sweep.scheduler';
import { WorkerModule } from '../../src/worker.module';
import { resetDatabase } from './database';
import { MailRecorder } from './mail-recorder';
import { ResettableThrottlerStorage } from './throttler-storage';

export type HttpClient = ReturnType<typeof request>;

export interface E2eApp {
  app: INestApplication;
  /** The worker process, in-process: this is what consumes the jobs. */
  worker: INestApplicationContext;
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
 * The real application plus the real worker, in one process.
 *
 * Two Nest contexts are built, exactly as production runs two: `AppModule`
 * produces and `WorkerModule` consumes. That is more machinery than
 * replacing `MailService` and it buys the thing that matters — the queue,
 * the job, the processor and the rendering all run, so a suite that passes
 * has proved the two halves talk to each other.
 *
 * Three providers are replaced and no more. `MailTransport`, so nothing
 * reaches a real server and a test can read what would have been sent.
 * The throttler's storage, so counters reset between tests. And
 * `SweepScheduler`, because a suite has no business registering a
 * repeatable job that would outlive it in Redis.
 */
export async function createE2eApp(): Promise<E2eApp> {
  const mail = new MailRecorder();
  const throttler = new ResettableThrottlerStorage();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ThrottlerStorage)
    .useValue(throttler)
    .compile();

  const app = moduleFixture.createNestApplication();
  configureApp(app, app.get(ConfigService));
  await app.init();

  const prisma = app.get(PrismaService);

  // The consumer half. It has to be initialised for BullMQ to start pulling
  // jobs, which is what makes the wait in MailRecorder resolve.
  const workerFixture = await Test.createTestingModule({
    imports: [WorkerModule],
  })
    .overrideProvider(MailTransport)
    .useValue(mail)
    .overrideProvider(SweepScheduler)
    .useValue({ onApplicationBootstrap: () => Promise.resolve() })
    .compile();

  const worker = await workerFixture.init();

  const resetData = async (): Promise<void> => {
    await resetDatabase(prisma);
    mail.reset();
  };

  return {
    app,
    worker,
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
    // The worker first: a context still holding Redis connections keeps
    // the Jest process alive after the suite finishes.
    close: async () => {
      await worker.close();
      await app.close();
    },
  };
}
