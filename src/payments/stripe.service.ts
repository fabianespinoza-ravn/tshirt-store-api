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

  constructor(config: ConfigService) {
    this.client = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'));
    this.currency = config.getOrThrow<string>('STRIPE_CURRENCY');
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
      this.logger.error(
        `Could not cancel ${paymentIntentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return false;
    }
  }
}
