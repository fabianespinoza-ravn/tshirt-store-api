import { mockDeep } from 'jest-mock-extended';
import type { StripeService } from '../payments/stripe.service';
import { createPrismaMock, type PrismaMock } from '../testing/prisma.mock';
import { IDEMPOTENCY_KEY_TTL_MS, intentToCancel } from './payment-recovery';

/**
 * The single decision point for money and stock on this branch, and the
 * reason it is single: the sweep and checkout both reclaim lapsed orders,
 * the rule was written twice, and the second copy lost its retention bound.
 * One path was safe and the other was not. These cases pin the rule where it
 * lives rather than once per caller, which is what let the two drift.
 *
 * The bound is the case that matters. Inside Stripe's retention, asking for
 * an order's intent again returns the one that exists; outside it, the same
 * call **creates a second intent**, and cancelling that while the first
 * stays live would release the stock with a real charge pointed at it.
 */
describe('intentToCancel', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');

  let prisma: PrismaMock;
  let stripe: ReturnType<typeof mockDeep<StripeService>>;

  beforeEach(() => {
    prisma = createPrismaMock();
    stripe = mockDeep<StripeService>();
    stripe.createPaymentIntent.mockResolvedValue({
      id: 'pi_created',
    } as Awaited<ReturnType<StripeService['createPaymentIntent']>>);
  });

  /** An order placed a given number of milliseconds before `now`. */
  const anOrderPlaced = (agoMs: number) => ({
    id: 'order-1',
    total: 4_599,
    createdAt: new Date(now.getTime() - agoMs),
  });

  const call = (agoMs: number) =>
    intentToCancel(prisma, stripe, anOrderPlaced(agoMs), now);

  it('returns the intent already recorded, without asking Stripe for one', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      stripePaymentIntentId: 'pi_recorded',
    } as never);

    await expect(call(60_000)).resolves.toBe('pi_recorded');
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('reads the newest attempt, since an order may have more than one', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      stripePaymentIntentId: 'pi_recorded',
    } as never);

    await call(60_000);

    expect(prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });

  it('recovers by idempotency key when no attempt was recorded', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(call(60_000)).resolves.toBe('pi_created');
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('refuses at exactly the retention age, because the key is already gone', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(call(IDEMPOTENCY_KEY_TTL_MS)).resolves.toBeNull();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('refuses past the retention age, rather than creating a second intent', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(call(IDEMPOTENCY_KEY_TTL_MS + 60_000)).resolves.toBeNull();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('still returns a recorded intent for an order past the window, since no key is needed to name it', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      stripePaymentIntentId: 'pi_recorded',
    } as never);

    await expect(call(IDEMPOTENCY_KEY_TTL_MS * 3)).resolves.toBe('pi_recorded');
  });
});
