import type Stripe from 'stripe';

/**
 * What travels to the worker when a Stripe delivery has been verified and
 * recorded.
 *
 * **Identifiers only, and that is a requirement rather than a preference.**
 * `SETTLEMENT_JOB_OPTIONS` keeps failed jobs forever, so whatever is in here
 * lives in Redis until somebody removes it by hand; the architecture
 * write-up allows that precisely because the payload is a handful of Stripe
 * ids and nothing about the customer. The verified event itself is already
 * in `webhook_events.payload`, which is where the worker would go if it ever
 * needed more than these.
 *
 * Amounts are deliberately absent. The order's own `total` is what settles,
 * read inside the transaction that moves it; copying a number out of the
 * event would introduce a second opinion about how much was owed.
 */
export interface SettlementJobData {
  /** The `webhook_events` row this job came from, so it can be marked processed. */
  webhookEventId: string;
  /** Stripe's id for the delivery, for logs and for the job's own id. */
  stripeEventId: string;
  /** The event type, so the worker branches on what actually arrived. */
  eventType: SettlementEventType;
  paymentIntentId: string;
  /** From the intent's metadata, which checkout set. */
  orderId: string;
}

/**
 * The Stripe event types this API settles.
 *
 * An enum rather than string literals because the value appears in three
 * places — the producer's filter, the worker's branch and the recorded row —
 * and three copies of `'payment_intent.succeeded'` is three chances for one
 * of them to be misspelled into a silence nobody notices.
 *
 * Only one member today, and the two obvious absences are deliberate.
 *
 * `payment_intent.payment_failed` is not here because nothing in the current
 * flow acts on it: the order simply stays PENDING until the sweep reclaims
 * it, and an event type listed here is a promise that a job will be created
 * for it.
 *
 * **`checkout.session.completed` is the payment-link seam.** A link purchase
 * arrives as that event and settles differently — there is no cart, possibly
 * no account, and the order is created by the handler rather than moved by
 * it. Adding the member here is the whole of the producer's side of that
 * wiring; the worker then needs a branch in `SettlementService.settle` that
 * calls the payment-link handler instead of `pay`, and the payload above
 * needs the session id, which the intent id cannot stand in for. Until both
 * exist, such an event is recorded in `webhook_events` and enqueued for
 * nothing, which is the honest state rather than a job with no consumer.
 */
export enum SettlementEventType {
  PaymentIntentSucceeded = 'payment_intent.succeeded',
}

const SETTLED_TYPES = new Set<string>(Object.values(SettlementEventType));

/**
 * The job a verified event produces, or `undefined` when this API has
 * nothing to do with it.
 *
 * Stripe delivers whatever the endpoint is subscribed to, and an account
 * sends far more than this integration acts on. Every delivery is still
 * recorded — the row is the audit trail and the idempotency key — but only
 * the types above become work, so the settlement queue's depth and its
 * failed set stay measurements of the money path and not of Stripe's
 * chattiness.
 *
 * `undefined` is also the answer when a `payment_intent.succeeded` arrives
 * without the metadata checkout writes. That should not happen — the intent
 * is created with `metadata.orderId` — and when it does, the event is one
 * this deployment did not create: a link-mode payment, or another
 * integration pointed at the same endpoint. Enqueueing it would give the
 * worker an order id it has to invent; recording it and stopping is the
 * honest answer, and the unprocessed row is what the monitoring alert on
 * "recorded but not settled" is looking at.
 */
export function settlementJobFor(
  event: Stripe.Event,
  webhookEventId: string,
): SettlementJobData | undefined {
  if (!SETTLED_TYPES.has(event.type)) return undefined;

  const intent = event.data.object as Stripe.PaymentIntent;
  const orderId = intent.metadata?.orderId;

  if (typeof orderId !== 'string' || orderId.length === 0) return undefined;

  return {
    webhookEventId,
    stripeEventId: event.id,
    eventType: event.type as SettlementEventType,
    paymentIntentId: intent.id,
    orderId,
  };
}
