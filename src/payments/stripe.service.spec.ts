import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from './stripe.service';

const paymentIntents = {
  create: jest.fn(),
  cancel: jest.fn(),
  retrieve: jest.fn(),
};
const refunds = { create: jest.fn() };
// Typed, because a case below reads the buffer back out of `mock.calls` to
// prove it was handed over rather than re-encoded, and an untyped double
// makes that read an `any`.
const webhooks = {
  constructEvent: jest.fn<unknown, [Buffer, string, string]>(),
};

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({ paymentIntents, refunds, webhooks })),
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
      refunds,
      webhooks,
    }));
  });

  /** The service under a given configuration, defaults filled in. */
  const makeService = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      STRIPE_SECRET_KEY: 'a-test-key',
      STRIPE_WEBHOOK_SECRET: 'a-test-webhook-secret',
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

  /**
   * Silences the logger for the cancel path, which logs its refusals.
   *
   * The return type is inferred rather than declared: annotating it
   * `jest.SpyInstance` widens `mock.calls` to `any`, and the lint rule
   * against unsafe member access then fires on reading the logged message.
   */
  const withQuietLogger = () =>
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

  it('keys the intent on the order id, so asking twice cannot make two charges', async () => {
    const service = makeService();
    const order = anOrder({ id: 'order-idempotent' });
    paymentIntents.create.mockResolvedValue(anIntent());

    await service.createPaymentIntent(order);

    expect(paymentIntents.create).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: order.id,
    });
  });

  it('sends the order total in cents, with nothing rounded or converted', async () => {
    const service = makeService();
    const order = anOrder({ total: 4_599 });
    paymentIntents.create.mockResolvedValue(anIntent());

    await service.createPaymentIntent(order);

    expect(paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 4_599 }),
      expect.any(Object),
    );
  });

  it('sends the configured currency rather than one written into the code', async () => {
    const service = makeService({ STRIPE_CURRENCY: 'eur' });
    paymentIntents.create.mockResolvedValue(anIntent());

    await service.createPaymentIntent(anOrder());

    expect(paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'eur' }),
      expect.any(Object),
    );
  });

  it('puts the order id in the metadata, so an intent can be traced back without our row', async () => {
    const service = makeService();
    const order = anOrder({ id: 'order-metadata' });
    paymentIntents.create.mockResolvedValue(anIntent());

    await service.createPaymentIntent(order);

    expect(paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { orderId: order.id } }),
      expect.any(Object),
    );
  });

  it('reports success when Stripe accepts the cancellation', async () => {
    const service = makeService();
    paymentIntents.cancel.mockResolvedValue(anIntent());

    await expect(service.cancelPaymentIntent('pi_cancel')).resolves.toBe(true);
    expect(paymentIntents.cancel).toHaveBeenCalledWith('pi_cancel');
  });

  it('reports failure instead of raising when Stripe refuses to cancel, because the caller is a batch', async () => {
    const service = makeService();
    const logger = withQuietLogger();
    paymentIntents.cancel.mockRejectedValue(new Error('already succeeded'));

    await expect(service.cancelPaymentIntent('pi_refused')).resolves.toBe(
      false,
    );
    expect(logger).toHaveBeenCalled();
    logger.mockRestore();
  });

  it('releases when Stripe refuses because the intent is already cancelled', async () => {
    const service = makeService();
    const logger = withQuietLogger();
    paymentIntents.cancel.mockRejectedValue(new Error('already canceled'));
    paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    await expect(service.cancelPaymentIntent('pi_gone')).resolves.toBe(true);
    logger.mockRestore();
  });

  it('refuses to release when the intent succeeded, because the money arrived', async () => {
    const service = makeService();
    const logger = withQuietLogger();
    paymentIntents.cancel.mockRejectedValue(new Error('cannot cancel'));
    paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

    await expect(service.cancelPaymentIntent('pi_paid')).resolves.toBe(false);
    logger.mockRestore();
  });

  it('refuses to release when the state cannot be read at all', async () => {
    const service = makeService();
    const logger = withQuietLogger();
    paymentIntents.cancel.mockRejectedValue(new Error('cannot cancel'));
    paymentIntents.retrieve.mockRejectedValue(new Error('unreachable'));

    await expect(service.cancelPaymentIntent('pi_unknown')).resolves.toBe(
      false,
    );
    logger.mockRestore();
  });

  it('names the intent in the log when a cancellation fails, since the sweep leaves the order alone on that answer', async () => {
    const service = makeService();
    const logger = withQuietLogger();
    paymentIntents.cancel.mockRejectedValue(new Error('already succeeded'));
    paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

    await service.cancelPaymentIntent('pi_named');

    expect(String(logger.mock.calls[0]?.[0])).toContain('pi_named');
    logger.mockRestore();
  });

  /**
   * The two calls the rest of this suite could not see.
   *
   * Every other spec on this branch replaces `StripeService` wholesale, so
   * until now nothing executed either of these — including the one line the
   * whole "a cancelled order is not refunded twice" argument rests on. A
   * change that dropped the refund's idempotency key would have broken that
   * guarantee with every test still green.
   */
  describe('the refund, which must not happen twice', () => {
    it('keys the refund on the intent, so a retried settlement refunds once', () => {
      const service = makeService();
      refunds.create.mockResolvedValue({ id: 're_1' });

      void service.refundPaymentIntent('pi_paid');

      expect(refunds.create).toHaveBeenCalledWith(
        { payment_intent: 'pi_paid' },
        { idempotencyKey: 'refund:pi_paid' },
      );
    });

    it('derives that key from the intent rather than reusing one', () => {
      const service = makeService();
      refunds.create.mockResolvedValue({ id: 're_1' });

      void service.refundPaymentIntent('pi_other');

      expect(refunds.create).toHaveBeenCalledWith(expect.anything(), {
        idempotencyKey: 'refund:pi_other',
      });
    });

    it('answers with the refund id, which is what the payment row records', async () => {
      const service = makeService();
      refunds.create.mockResolvedValue({ id: 're_recorded' });

      await expect(service.refundPaymentIntent('pi_paid')).resolves.toBe(
        're_recorded',
      );
    });

    it('lets a refusal out, because a refund that did not happen must fail its job', async () => {
      const service = makeService();
      refunds.create.mockRejectedValue(new Error('cannot refund'));

      await expect(service.refundPaymentIntent('pi_paid')).rejects.toThrow(
        'cannot refund',
      );
    });
  });

  describe('the signature, which is the whole of the webhook authentication', () => {
    it('verifies the raw payload against the configured secret', () => {
      const service = makeService();
      const payload = Buffer.from('{"id":"evt_1"}');
      webhooks.constructEvent.mockReturnValue({ id: 'evt_1' });

      service.constructWebhookEvent(payload, 't=1,v1=abc');

      expect(webhooks.constructEvent).toHaveBeenCalledWith(
        payload,
        't=1,v1=abc',
        'a-test-webhook-secret',
      );
    });

    it('hands over the buffer it was given, not a copy of its text', () => {
      const service = makeService();
      const payload = Buffer.from('{"id":"evt_1"}');
      webhooks.constructEvent.mockReturnValue({ id: 'evt_1' });

      service.constructWebhookEvent(payload, 't=1,v1=abc');

      // `toBe`, not `toEqual`: a re-encoded buffer is deeply equal and
      // verifies to a different signature, so an equality that accepted one
      // would accept the bug this case exists to catch.
      expect(webhooks.constructEvent.mock.calls[0]?.[0]).toBe(payload);
    });

    it('raises what Stripe raises, so an unverified body never reaches a handler', () => {
      const service = makeService();
      webhooks.constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      expect(() =>
        service.constructWebhookEvent(Buffer.from('{}'), 'bad'),
      ).toThrow('No signatures found');
    });
  });
});
