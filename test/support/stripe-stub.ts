import type { StripeService } from '../../src/payments/stripe.service';

/**
 * Stands in for `StripeService` across the end-to-end suite, so checkout
 * runs for real and only the network is replaced.
 *
 * It records rather than merely returning, because the interesting questions
 * about payments are about *what was asked for*: the amount handed to Stripe
 * is the order's total in cents, and an intent must be created once per
 * order however many times a client retries. A stub that only answered would
 * let a double charge pass unnoticed.
 *
 * Ids are derived from the order rather than random, so a test can name the
 * intent it expects without threading a value through the fixture.
 */
export class StripeStub {
  readonly created: { orderId: string; amount: number }[] = [];
  readonly cancelled: string[] = [];

  /** Set false to make cancelling fail, which is the sweep's refusal path. */
  cancelSucceeds = true;

  createPaymentIntent(order: { id: string; total: number }) {
    this.created.push({ orderId: order.id, amount: order.total });

    return Promise.resolve({
      id: `pi_${order.id}`,
      client_secret: `pi_${order.id}_secret`,
    } as Awaited<ReturnType<StripeService['createPaymentIntent']>>);
  }

  cancelPaymentIntent(paymentIntentId: string): Promise<boolean> {
    this.cancelled.push(paymentIntentId);

    return Promise.resolve(this.cancelSucceeds);
  }

  /** How many intents were created for one order, which is the double-charge question. */
  createdFor(orderId: string): number {
    return this.created.filter((intent) => intent.orderId === orderId).length;
  }

  reset(): void {
    this.created.length = 0;
    this.cancelled.length = 0;
    this.cancelSucceeds = true;
  }
}
