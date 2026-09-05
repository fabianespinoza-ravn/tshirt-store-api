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
/**
 * One unit per Payment Link purchase, and the quantity the settlement
 * handler assumes on the way back.
 *
 * It is a named constant rather than a bare `1` because it is the same fact
 * in two places: the link is created without `adjustable_quantity`, so the
 * buyer cannot change it, and that is the only reason the handler is allowed
 * to derive an order total from `unitPriceAtCreation` without reading the
 * session's line items back from Stripe.
 */
export const PAYMENT_LINK_QUANTITY = 1;

/** Stripe's `billing_address_collection`, which is a union and not an enum. */
const BILLING_ADDRESS_REQUIRED: Stripe.PaymentLinkCreateParams.BillingAddressCollection =
  'required';

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
   * The Payment Link for one SKU, which is the second payment method the
   * contract mandates.
   *
   * **The price travels inline rather than as a `Price` id we keep.** A
   * Payment Link needs a `Price`, and there are two ways to get one: create
   * and store a Stripe `Price` per SKU, or let `price_data` mint one as the
   * link is created. The second is chosen because it removes a whole class
   * of drift — with a stored id, `Sku.price` and the Stripe price are two
   * copies of one number that nothing keeps in step, and a manager editing
   * the price would silently keep charging the old one. Here the amount that
   * reaches Stripe is the amount the caller passed, once, and
   * `PaymentLink.unitPriceAtCreation` records it on our side so a later edit
   * cannot rewrite what an already-published link charges.
   *
   * `unitAmount` is cents, which is what `Sku.price` already holds; nothing
   * converts and nothing rounds.
   *
   * `metadata` carries the SKU id because Stripe copies a Payment Link's
   * metadata onto every Checkout Session the link creates. Settlement does
   * not read it — it looks the `PaymentLink` row up by
   * `session.payment_link`, which is the authoritative join — so this is the
   * self-describing copy: what an operator sees in the dashboard, and what
   * remains if the event ever has to be reconciled against a row that is no
   * longer there. Correlation by value, the same reason `WebhookEvent`
   * carries no foreign key.
   *
   * `requestId` is the idempotency key and is meant to be the id of the
   * `PaymentLink` row about to be written: a retried request creates one
   * link, not two. It is deliberately *not* the SKU id — the same SKU must
   * be able to get a second link after the first is deactivated, and Stripe
   * refuses a reused key whose parameters changed.
   */
  async createPaymentLink(params: {
    requestId: string;
    skuId: string;
    productName: string;
    unitAmount: number;
  }): Promise<Stripe.PaymentLink> {
    return this.client.paymentLinks.create(
      {
        line_items: [
          {
            quantity: PAYMENT_LINK_QUANTITY,
            price_data: {
              currency: this.currency,
              unit_amount: params.unitAmount,
              product_data: { name: params.productName },
            },
          },
        ],
        // The buyer of a link has no account and no saved address, so this
        // is the only place an address can be collected. `getGuestOrder`
        // never publishes it; the order needs one to be shippable at all.
        billing_address_collection: BILLING_ADDRESS_REQUIRED,
        metadata: { skuId: params.skuId },
      },
      { idempotencyKey: params.requestId },
    );
  }

  /**
   * Turns a link off at Stripe, reporting rather than raising.
   *
   * Both callers are cleaning up after a decision that has already been
   * made — a link that lost the race for its SKU's one active slot, and
   * later the price edit that supersedes a link — so a failure here must not
   * become the answer to a request that otherwise succeeded. What it costs
   * when it returns false is a link that still charges at Stripe while our
   * row says inactive, which is worth a loud log and a manual visit to the
   * dashboard.
   */
  async deactivatePaymentLink(paymentLinkId: string): Promise<boolean> {
    try {
      await this.client.paymentLinks.update(paymentLinkId, { active: false });
      return true;
    } catch (error) {
      this.logger.error(
        `Could not deactivate payment link ${paymentLinkId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );

      return false;
    }
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
