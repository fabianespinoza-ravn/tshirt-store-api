import { deferred, flushMicrotasks } from './deferred';

/**
 * These two are load-bearing in a way that is easy to miss: the gated
 * assertions in the order suites read "this has not happened yet", and if
 * `flushMicrotasks` returned before the queued reactions ran, those
 * assertions would hold for the wrong reason and pass against code that
 * does the thing they forbid. A helper that quietly stops working turns
 * every case built on it into a decoration.
 */
describe('the synchronisation helpers', () => {
  it('stays pending until it is resolved', async () => {
    const gate = deferred<string>();
    let settled: string | null = null;

    void gate.promise.then((value) => {
      settled = value;
    });
    await flushMicrotasks();

    expect(settled).toBeNull();

    gate.resolve('let through');
    await gate.promise;

    expect(settled).toBe('let through');
  });

  it('carries the value it was resolved with', async () => {
    const gate = deferred<number>();
    gate.resolve(42);

    await expect(gate.promise).resolves.toBe(42);
  });

  it('lets queued reactions run, which is the whole reason it exists', async () => {
    const order: string[] = [];
    void Promise.resolve().then(() => order.push('reaction'));

    await flushMicrotasks();
    order.push('after flush');

    expect(order).toEqual(['reaction', 'after flush']);
  });
});
