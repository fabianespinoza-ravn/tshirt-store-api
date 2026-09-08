import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * The second process. Same image as the API, no HTTP server.
 *
 * The file is `worker.ts` because the Railway worker starts with
 * `node dist/worker`; a name that compiled elsewhere would leave a deploy
 * that builds and never starts. CI and the Dockerfile both assert this exact
 * entrypoint.
 *
 * `createApplicationContext` rather than `create`: there is nothing to
 * listen on. The process stays alive because BullMQ's workers hold the event
 * loop, and it ends when the platform sends SIGTERM — which `enableShutdownHooks`
 * turns into Nest's shutdown, so a job in flight finishes instead of being
 * cut in half.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    // The API logs the same way; a second process with a different format
    // would make the two impossible to read together.
    bufferLogs: false,
  });

  app.enableShutdownHooks();

  // A worker that says nothing on boot is indistinguishable from one that
  // crashed on boot, and the deploy shows both as "running".
  logger.log('Worker started; waiting for jobs.');
}

void bootstrap();
