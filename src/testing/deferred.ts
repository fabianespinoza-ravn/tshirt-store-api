/**
 * A promise a test controls the settling of.
 *
 * It exists because `mock.invocationCallOrder` answers a weaker question than
 * it looks like it does: it records when a mock was *called*, not when the
 * work behind it finished. Comparing the order of two calls therefore cannot
 * tell "after the transaction committed" from "inside the transaction" —
 * `$transaction` is invoked before anything in its own callback, so a
 * comparison against it holds either way and the case passes while the code
 * does the thing it was written to forbid.
 *
 * Gating one side and asserting the other has *not* happened yet is the
 * question actually worth asking.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

/**
 * Lets every microtask already queued run.
 *
 * A gated promise is only useful if the code under test has had the chance to
 * reach the call being asserted absent; without this the assertion would pass
 * because nothing had run at all.
 */
export const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
