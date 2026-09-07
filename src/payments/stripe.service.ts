import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * The seam between this API and Stripe.
 *
 * It exists as a class rather than as `new Stripe(...)` at each call site for
 * the same reason `MailTransport` does: the suite can replace exactly this
 * and nothing else, so the order, the reservation and the money arithmetic
 * all run for real and only the network is stood in for.
 *
 * **`apiVersion` is deliberately not set.** Left alone, the SDK sends the
 * version it was built against, so the API version this service talks is
 * pinned by `package-lock.json` and moves only when the package does — one
 * pin instead of two that can disagree. Setting it here would be a second
 * copy of the same fact, free to drift from the types the compiler checks
 * these calls against.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: Stripe;
  private readonly currency: string;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.client = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'));
    this.currency = config.getOrThrow<string>('STRIPE_CURRENCY');
    this.webhookSecret = config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  }

  /**
   * The payment intent for an order, created at most once however many times
   * this runs.
   *
   * The order's id is the idempotency key, and that is the whole point of
   * this method. Checkout commits its transaction before calling Stripe, so
   * between the commit and the row that records the intent there is a window
   * where the process can die having charged the customer's card against an
   * intent nothing in the database knows about. With the order id as the
   * key, asking again returns *the same intent* rather than making a second
   * one — so the recovery path is to ask again, and the sweep can reach an
   * intent whose id was never written down.
   *
   * The amount is the order's total in cents, which is what `Order.total`
   * already holds; Stripe wants the minor unit, so nothing converts and
   * nothing rounds.
   */
  async createPaymentIntent(order: {
    id: string;
    total: number;
  }): Promise<Stripe.PaymentIntent> {
    return this.client.paymentIntents.create(
      {
        amount: order.total,
        currency: this.currency,
        // Correlation that survives us losing the row. `WebhookEvent` has no
        // foreign key for the same reason: the event exists before the rows
        // it will touch, so the link is by value.
        metadata: { orderId: order.id },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: order.id },
    );
  }

  /**
   * Cancels an intent so a payment cannot land after the order is gone.
   *
   * The sweep calls this **before** it releases the reservation, and the
   * order matters: released first, a payment arriving inside the window
   * leaves a charged order whose units have already been sold to somebody
   * else.
   *
   * An intent Stripe will not cancel — already succeeded, already cancelled —
   * is reported rather than raised. The caller is a background sweep working
   * through a batch, and a single unlucky order must not stop the rest; a
   * succeeded intent is a real event that needs a refund, and that is the
   * settlement path's problem, not this one's.
   */
  async cancelPaymentIntent(paymentIntentId: string): Promise<boolean> {
    try {
      await this.client.paymentIntents.cancel(paymentIntentId);
      return true;
    } catch (error) {
      // A refused cancellation is not automatically a refusal to release,
      // and treating it as one costs an order forever. The commonest reason
      // Stripe refuses is that the intent is **already cancelled** — this
      // sweep's own earlier attempt, whose transaction then lost its race —
      // and answering `false` to that would leave the order PENDING, its
      // stock reserved, and the next minute's run refused for exactly the
      // same reason, every minute, with nothing ever releasing it.
      //
      // So the state is read rather than inferred from the error. Only
      // `canceled` releases. `succeeded` must not, because the money
      // arrived; anything else is unknown, and unknown means keep holding.
      const status = await this.statusOf(paymentIntentId);

      if (status === 'canceled') {
        return true;
      }

      this.logger.error(
        `Could not cancel ${paymentIntentId} (now ${status ?? 'unreadable'}): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );

      return false;
    }
  }

  /**
   * The event Stripe signed, or a thrown `StripeSignatureVerificationError`.
   *
   * **The payload has to be the raw bytes.** The signature covers exactly
   * what Stripe put on the wire, so a body that has been parsed and
   * re-serialised no longer hashes to the same value however faithful the
   * round trip looks — key order and whitespace are not preserved by JSON.
   * That is why `main.ts` boots with `rawBody: true` and why this takes a
   * `Buffer` rather than an object.
   *
   * Nothing is caught here on purpose. Whether a bad signature is a 400, a
   * 500 or a dropped job is a decision about the caller, and this class has
   * no caller in view: the same method serves the HTTP route today and would
   * serve a replay tool tomorrow. The route translates it.
   */
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    return this.client.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }

  /**
   * Refunds a charge in full and answers with the refund's id.
   *
   * **This one throws where `cancelPaymentIntent` reports.** The difference
   * is what a failure costs. A cancellation that Stripe refuses leaves an
   * order held for another minute, and the sweep's next run is the retry. A
   * refund that fails is money taken from a customer whose order no longer
   * exists, and the only safe answer is to fail the job so BullMQ retries it
   * for the best part of a day and then parks it where a person can see it —
   * which is exactly what `SETTLEMENT_JOB_OPTIONS` is shaped for.
   *
   * The intent's id is the idempotency key, so a retried job returns the
   * refund that already exists instead of refunding a second time. The
   * caller records the id it gets back **after** Stripe has answered, never
   * before: a `stripe_refund_id` written for a refund that did not happen is
   * indistinguishable, afterwards, from money that was actually returned.
   */
  async refundPaymentIntent(paymentIntentId: string): Promise<string> {
    const refund = await this.client.refunds.create(
      { payment_intent: paymentIntentId },
      { idempotencyKey: `refund:${paymentIntentId}` },
    );

    return refund.id;
  }

  /**
   * The intent's status, or null when even reading it fails.
   *
   * Null is deliberately not an error here: the caller is deciding whether
   * it is safe to release stock, and "I could not find out" has to mean no.
   */
  private async statusOf(paymentIntentId: string): Promise<string | null> {
    try {
      const intent = await this.client.paymentIntents.retrieve(paymentIntentId);

      return intent.status;
    } catch {
      return null;
    }
  }
}
