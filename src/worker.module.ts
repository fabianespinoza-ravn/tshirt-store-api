import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';

/**
 * What the worker process loads, and nothing more.
 *
 * It is not `AppModule`. The API's module tree pulls in controllers, guards,
 * the throttler and the HTTP pipeline, none of which a process with no
 * server needs — and importing it would also mean any future change to the
 * request path could break the worker for reasons that have nothing to do
 * with jobs.
 *
 * The split runs the other way too: the processors are declared here and
 * never in `AppModule`, so the API enqueues and the worker consumes. Both
 * halves import `QueueModule`, which carries the connection and the queues
 * and no consumer at all.
 *
 * Processors arrive one at a time as their jobs do — the sweep next.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    QueueModule,
  ],
})
export class WorkerModule {}
