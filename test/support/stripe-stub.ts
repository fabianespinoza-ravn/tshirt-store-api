import type Stripe from 'stripe';
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
  readonly paymentLinks: {
    requestId: string;
    skuId: string;
    productName: string;
    unitAmount: number;
    id: string;
    url: string;
  }[] = [];
  readonly deactivatedPaymentLinks: string[] = [];
  private readonly events = new Map<string, Stripe.Event>();

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

  createPaymentLink(
    params: Parameters<StripeService['createPaymentLink']>[0],
  ): Promise<Stripe.PaymentLink> {
    const id = `plink_${params.requestId}`;
    const url = `https://stripe.example.test/pay/${params.requestId}`;
    this.paymentLinks.push({ ...params, id, url });

    return Promise.resolve({ id, url, active: true } as Stripe.PaymentLink);
  }

  deactivatePaymentLink(paymentLinkId: string): Promise<boolean> {
    this.deactivatedPaymentLinks.push(paymentLinkId);
    return Promise.resolve(true);
  }

  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    void signature;
    const parsed: unknown = JSON.parse(payload.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('The Stripe test event has no id.');
    }

    const event = this.events.get(parsed.id);
    if (!event) throw new Error(`Stripe test event ${parsed.id} is unknown.`);

    return event;
  }

  retrieveEvent(stripeEventId: string): Promise<Stripe.Event> {
    const event = this.events.get(stripeEventId);
    if (!event) {
      return Promise.reject(
        new Error(`Stripe test event ${stripeEventId} is unknown.`),
      );
    }

    return Promise.resolve(event);
  }

  setWebhookEvent(event: Stripe.Event): void {
    this.events.set(event.id, event);
  }

  /** How many intents were created for one order, which is the double-charge question. */
  createdFor(orderId: string): number {
    return this.created.filter((intent) => intent.orderId === orderId).length;
  }

  reset(): void {
    this.created.length = 0;
    this.cancelled.length = 0;
    this.paymentLinks.length = 0;
    this.deactivatedPaymentLinks.length = 0;
    this.events.clear();
    this.cancelSucceeds = true;
    this.onCancel = undefined;
  }
}
