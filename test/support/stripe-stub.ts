import type { StripeService } from '../../src/payments/stripe.service';

/**
 * The intent id this stub answers with for an order, derived rather than
 * random so a fixture can seed the `Payment` row an already-placed order
 * would carry and name the same intent the application would find.
 */
export const intentIdFor = (orderId: string): string => `pi_${orderId}`;

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

  /**
   * Runs while a cancellation is in flight, before the caller learns whether
   * it succeeded.
   *
   * It exists for one question the recorded arrays cannot answer: checkout
   * must stop a lapsed order's payment *before* anything releases its stock,
   * and both happen inside one request. A hook here is the only vantage point
   * from which the reservations can be read at the moment the intent is being
   * cancelled — after that instant the two orderings look identical.
   */
  onCancel?: (paymentIntentId: string) => Promise<void> | void;

  createPaymentIntent(order: { id: string; total: number }) {
    this.created.push({ orderId: order.id, amount: order.total });

    return Promise.resolve({
      id: intentIdFor(order.id),
      client_secret: `${intentIdFor(order.id)}_secret`,
    } as Awaited<ReturnType<StripeService['createPaymentIntent']>>);
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<boolean> {
    this.cancelled.push(paymentIntentId);
    await this.onCancel?.(paymentIntentId);

    return this.cancelSucceeds;
  }

  /** How many intents were created for one order, which is the double-charge question. */
  createdFor(orderId: string): number {
    return this.created.filter((intent) => intent.orderId === orderId).length;
  }

  reset(): void {
    this.created.length = 0;
    this.cancelled.length = 0;
    this.cancelSucceeds = true;
    this.onCancel = undefined;
  }
}
