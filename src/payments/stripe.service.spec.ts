import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from './stripe.service';

const paymentIntents = { create: jest.fn(), cancel: jest.fn() };

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({ paymentIntents })),
);

/**
 * Two properties here are worth more than the rest of the file.
 *
 * **The idempotency key is the order's id.** Checkout commits the order
 * before it calls Stripe, so every recovery path — a retried request, the
 * sweep reaching for an intent whose row was never written — depends on
 * asking again returning the *same* intent. Without the key, asking again
 * creates a second one, and a second intent against one order is a second
 * charge waiting to happen. Nothing else in this service prevents that.
 *
 * **Cancelling reports rather than raises.** The caller is a sweep working
 * through a batch, and an intent Stripe refuses to cancel — because it has
 * already succeeded — is not an error to abort on: it is the answer, and it
 * means the stock must stay reserved.
 *
 * The amount is passed straight through. `Order.total` is already an integer
 * number of cents and Stripe wants the minor unit, so a test that sees any
 * arithmetic here has found a bug.
 */
describe('StripeService', () => {
  const getOrThrow = jest.fn<unknown, [string]>();
  const config = { getOrThrow } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    (Stripe as unknown as jest.Mock).mockImplementation(() => ({
      paymentIntents,
    }));
  });

  /** The service under a given configuration, defaults filled in. */
  const makeService = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      STRIPE_SECRET_KEY: 'a-test-key',
      STRIPE_CURRENCY: 'usd',
      ...overrides,
    };
    getOrThrow.mockImplementation((key: string) => values[key]);

    return new StripeService(config);
  };

  /** An order the way `startPayment` hands one over: id and total in cents. */
  const anOrder = (overrides: Partial<{ id: string; total: number }> = {}) => ({
    id: 'order-1',
    total: 4_599,
    ...overrides,
  });

  const anIntent = (id = 'pi_1') => ({ id, client_secret: `${id}_secret` });

  /** Silences the logger for the cancel path, which logs its refusals. */
  const withQuietLogger = (): jest.SpyInstance =>
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

  it.todo(
    'keys the intent on the order id, so asking twice cannot make two charges',
  );

  it.todo('sends the order total in cents, with nothing rounded or converted');

  it.todo(
    'sends the configured currency rather than one written into the code',
  );

  it.todo(
    'puts the order id in the metadata, so an intent can be traced back without our row',
  );

  it.todo('reports success when Stripe accepts the cancellation');

  it.todo(
    'reports failure instead of raising when Stripe refuses to cancel, because the caller is a batch',
  );

  it.todo(
    'names the intent in the log when a cancellation fails, since the sweep leaves the order alone on that answer',
  );

  // Referenced so the scaffolding is not reported as unused while the cases
  // are still stubs. Delete this line with the last `it.todo`.
  void [makeService, anOrder, anIntent, withQuietLogger, paymentIntents];
});
