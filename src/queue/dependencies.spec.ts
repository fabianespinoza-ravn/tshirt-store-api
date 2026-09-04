import { BullModule } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createTransport } from 'nodemailer';

/**
 * The `uuid` lesson from week 3, applied before the dependency is fixed
 * rather than after: a package whose `exports` has no usable `require`
 * condition lets the application boot under Node and takes the whole Jest
 * suite down with it, and the suite is what the delivery is judged on.
 *
 * So this asserts nothing about behaviour. It asserts that the four
 * packages block 4 introduces can be imported and constructed inside the
 * CommonJS transform this repository compiles to. If it goes red, the
 * dependency choice changes — which is a decision worth making now and not
 * after the queue is written on top of it.
 *
 * It went red once already, which is why `@nestjs/bullmq` is pinned to 11
 * and not the current 12. Version 12 declares `"type": "module"` and maps
 * the `require` condition of its `exports` to the ESM build, so requiring it
 * fails with "Must use import to load ES Module" — the condition is a lie,
 * not a missing build. Do not raise that major without running this file:
 * the application would still boot and the entire suite would not.
 *
 * `bullmq` and `ioredis` ship CommonJS with no `type` field, and
 * `nodemailer` 10 declares `"type": "module"` but maps `require` to a real
 * CJS build. Those three are fine as they are.
 *
 * `lazyConnect` keeps ioredis from opening a socket: this must pass with no
 * Redis running, or it stops being a check about packaging.
 */
describe('the packages block 4 introduces', () => {
  it('loads under the CommonJS transform Jest uses', () => {
    expect(typeof BullModule.forRoot).toBe('function');
    expect(typeof Queue).toBe('function');
    expect(typeof Worker).toBe('function');
    expect(typeof Redis).toBe('function');
    expect(typeof createTransport).toBe('function');
  });

  it('constructs a redis client without opening a connection', () => {
    const client = new Redis({ lazyConnect: true, port: 6380 });

    expect(client.status).toBe('wait');
  });

  it('constructs a mail transport without sending anything', () => {
    const transport = createTransport({ jsonTransport: true });

    expect(typeof transport.sendMail).toBe('function');
  });
});
