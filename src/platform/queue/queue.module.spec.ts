import { ConfigService } from '@nestjs/config';
import { queueRootOptions } from './queue.module';

describe('queueRootOptions', () => {
  it('authenticates BullMQ when the Redis deployment provides a password', () => {
    const options = queueRootOptions(
      new ConfigService({
        QUEUE_PREFIX: 'railway',
        REDIS_HOST: 'redis.railway.internal',
        REDIS_PORT: 6379,
        REDIS_PASSWORD: 'redis-password',
      }),
    );

    expect(options).toEqual({
      prefix: 'railway',
      connection: {
        host: 'redis.railway.internal',
        port: 6379,
        password: 'redis-password',
        maxRetriesPerRequest: null,
      },
    });
  });

  it('omits authentication when Redis has no password', () => {
    const options = queueRootOptions(
      new ConfigService({
        REDIS_HOST: 'localhost',
        REDIS_PORT: 6380,
      }),
    );

    expect(options).toEqual({
      prefix: 'tshirt',
      connection: {
        host: 'localhost',
        port: 6380,
        maxRetriesPerRequest: null,
      },
    });
  });
});
