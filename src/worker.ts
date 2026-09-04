import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * The second process. Same image as the API, no HTTP server.
 *
 * The file is `worker.ts` and not `main.worker.ts` because `render.yaml`
 * already declares `dockerCommand: node dist/worker` for the worker service,
 * and a name that compiled to `dist/main.worker.js` would leave a deploy
 * that builds and never starts. `npm run build` emitting this path is
 * checked in CI next to the API's entrypoint, for the same reason that check
 * exists at all: a build can succeed while putting the file somewhere else.
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
