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

  it('drains a whole chain of reactions, which a single await would not', async () => {
    // A one-deep chain proves nothing: awaiting any already-resolved promise
    // would let it run, so the case would pass against a `flushMicrotasks`
    // that had become `Promise.resolve()` — and every gated assertion built
    // on it would then be holding for the wrong reason. Verified: with the
    // helper reduced to that, an earlier version of this case still passed.
    // A chain only drains if the wait crosses to the next macrotask.
    const order: string[] = [];
    void Promise.resolve()
      .then(() => order.push('first'))
      .then(() => order.push('second'))
      .then(() => order.push('third'));

    await flushMicrotasks();
    order.push('after flush');

    expect(order).toEqual(['first', 'second', 'third', 'after flush']);
  });
});
