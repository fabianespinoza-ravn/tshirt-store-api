import type Stripe from 'stripe';
import { SettlementEventType, settlementJobFor } from './settlement.jobs';

const aCheckoutEvent = (
  type:
    'checkout.session.completed' | 'checkout.session.async_payment_succeeded',
): Stripe.Event =>
  ({
    id: 'evt_checkout',
    type,
    data: { object: { id: 'cs_123' } },
  }) as Stripe.Event;

describe('settlementJobFor checkout sessions', () => {
  it('builds an identifier-only job for a completed checkout session', () => {
    expect(
      settlementJobFor(
        aCheckoutEvent('checkout.session.completed'),
        'webhook-row',
      ),
    ).toEqual({
      webhookEventId: 'webhook-row',
      stripeEventId: 'evt_checkout',
      eventType: SettlementEventType.CheckoutSessionCompleted,
      checkoutSessionId: 'cs_123',
    });
  });

  it('builds an identifier-only job when asynchronous checkout payment succeeds', () => {
    const job = settlementJobFor(
      aCheckoutEvent('checkout.session.async_payment_succeeded'),
      'webhook-row',
    );

    expect(job).toEqual({
      webhookEventId: 'webhook-row',
      stripeEventId: 'evt_checkout',
      eventType: SettlementEventType.CheckoutSessionAsyncPaymentSucceeded,
      checkoutSessionId: 'cs_123',
    });
    expect(job).not.toHaveProperty('paymentIntentId');
    expect(job).not.toHaveProperty('orderId');
  });
});
