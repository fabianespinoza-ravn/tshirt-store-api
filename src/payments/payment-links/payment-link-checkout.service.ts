import { Injectable, Logger } from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
  UserState,
} from '@prisma/client';
import type Stripe from 'stripe';
import { availableOf } from '../../catalog/views';
import { newId } from '../../common/ids';
import { recordStatus } from '../../orders/order-writes';
import { PrismaService } from '../../prisma/prisma.service';
import { PAYMENT_LINK_QUANTITY } from '../stripe.service';

/**
 * The two events this service owns. Every other type is somebody else's.
 *
 * **A completed session is not the same as a paid one**, and both entries
 * are here because of that. A card pays inside the session and arrives as
 * `checkout.session.completed` already `paid`. A delayed-notification method
 * — a bank debit, a voucher — completes the session `unpaid` and settles
 * hours or days later as `checkout.session.async_payment_succeeded`, which
 * carries the same session object with `payment_status` finally `paid`.
 *
 * Listening only for the first event would write no order at all for the
 * second kind of buyer: money in, nothing recorded, and no log at the moment
 * it settled. `createPaymentLink` passes no `payment_method_types`, so which
 * methods a link offers comes from the Stripe account's dashboard, and a
 * delayed method being enabled there is a configuration change no code
 * review would see.
 *
 * Both are gated on `payment_status` below rather than on the type, so the
 * rule is one sentence: settle when the money has arrived, whichever event
 * says so. A redelivery of the completion after the async success is
 * harmless — `alreadySettled` and the unique session id catch it.
 */
const SETTLING_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
] as const;

type SettlingEventType = (typeof SETTLING_EVENT_TYPES)[number];

function isSettlingEvent(
  event: Stripe.Event,
): event is Extract<Stripe.Event, { type: SettlingEventType }> {
  return (SETTLING_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Stripe's `Session.payment_status` when the money has actually arrived. It
 * is a union of strings and not an enum, so the literal is the value.
 */
const SESSION_PAID: Stripe.Checkout.Session.PaymentStatus = 'paid';

/** What the dispatcher gets back, so it can log or queue without re-reading. */
export interface PaymentLinkSettlement {
  orderId: string;
  paymentId: string;
  status: OrderStatus;
}

/** The parts of a Stripe address this API stores, already made total. */
interface ShippingDetails {
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
}

/**
 * The order a Payment Link purchase produces.
 *
 * It is a service and not a controller on purpose, and the boundary is the
 * point: `POST /webhooks/stripe` verifies the signature over the raw body,
 * writes `WebhookEvent.stripeEventId` — the unique column that makes Stripe's
 * three days of retries idempotent — and dispatches. This class is handed the
 * result of all that and does the money and the stock. Nothing here verifies
 * a signature, deduplicates an event, or answers HTTP.
 *
 * **How it differs from checkout, and why it cannot reuse `OrdersService`.**
 * That service is built around an authenticated user and a CASL row scope,
 * and a link buyer has neither: no session, no cart, and possibly no account
 * at all. It also runs in the opposite order. Checkout reserves stock and
 * then asks for money; a link takes the money first and only then finds out
 * whether the units are there. Everything below follows from that inversion.
 */
@Injectable()
export class PaymentLinkCheckoutService {
  private readonly logger = new Logger(PaymentLinkCheckoutService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Settles one `checkout.session.completed`.
   *
   * **The caller's contract.** The event has already had its signature
   * verified against the raw body and has already been deduplicated on
   * `WebhookEvent.stripeEventId`. This method assumes both and re-checks
   * neither.
   *
   * **`null` means "not mine".** A different event type, a session with no
   * payment link, a session whose link is not in our table, a session that
   * completed without being paid: none of those is a failure, and answering
   * `null` lets the dispatcher acknowledge them and move on. A failure is
   * thrown instead, so an unsettled event stays unsettled and Stripe's retry
   * gets another go at it.
   *
   * **The one thing it re-checks anyway** is `Payment.stripeCheckoutSessionId`,
   * which is unique in the schema. The caller's `WebhookEvent` row is the
   * real idempotency, and this is a second, narrower one keyed on the money
   * rather than on the message: two *different* events describing the same
   * session — a completion and a later replay of it — would both pass the
   * event-id check and only this one stops them writing two orders.
   *
   * That check is a read outside the transaction, so it cannot be the last
   * word, and it is not asked to be. `Payment.stripeCheckoutSessionId` is
   * unique in the schema, so two deliveries that raced past it both reach
   * `payment.create` and the loser is refused as P2002 — inside the
   * transaction, which rolls back the order, the history row and the stock
   * decrement with it. The read is what makes a redelivery cheap and quiet;
   * the constraint is what makes it safe.
   */
  async settleCheckoutSession(
    event: Stripe.Event,
  ): Promise<PaymentLinkSettlement | null> {
    if (!isSettlingEvent(event)) return null;

    const session = event.data.object;

    if (session.payment_status !== SESSION_PAID) {
      // Not a failure: a delayed-notification method completes the session
      // before the money moves, and `checkout.session.async_payment_succeeded`
      // is what comes back when it does.
      this.logger.log(
        `Checkout session ${session.id} is ${session.payment_status}; nothing to settle yet.`,
      );
      return null;
    }

    const paymentLinkId = idOf(session.payment_link);
    if (!paymentLinkId) return null;

    const already = await this.alreadySettled(session.id);
    if (already) return already;

    const link = await this.prisma.paymentLink.findUnique({
      where: { stripePaymentLinkId: paymentLinkId },
      include: { sku: { include: { product: true } } },
    });

    // Not one of ours. Checkout proper uses Payment Intents and never
    // creates a Checkout Session, so a session pointing at a link this table
    // has never seen belongs to something else in the Stripe account.
    if (!link) {
      this.logger.warn(
        `Checkout session ${session.id} names payment link ${paymentLinkId}, which this API did not create.`,
      );
      return null;
    }

    const email = session.customer_details?.email;

    // Checkout always collects an email, so this is a malformed event rather
    // than a buyer who declined to give one. It is thrown and not swallowed:
    // `Order.userId` is not nullable, so with no email there is no order to
    // write, and an acknowledged-but-unsettled payment is the one outcome
    // nobody would ever notice.
    //
    // A plain `Error`, not a `ProblemException`, and the difference is the
    // actor. This class has no request and no client: it is fed by a webhook
    // dispatcher, the way `mail.processor.ts` and `maintenance.processor.ts`
    // are fed by a queue, and those throw `Error` for the same reason. A
    // catalog entry here would be an HTTP status chosen by code that answers
    // no HTTP, and `problem-details.filter.ts` would then serve it to Stripe
    // as though Stripe had made a bad request.
    if (!email) {
      throw new Error(
        `Checkout session ${session.id} carries no customer email; the order cannot be attributed.`,
      );
    }

    return this.placeLinkOrder(session, link, email);
  }

  /**
   * The order, the stock and the payment row, in one `Serializable`
   * transaction.
   *
   * `Serializable` for the reason `OrdersService.checkout` gives: available
   * stock is `stock - reserved`, which Prisma cannot express as a `where` on
   * an atomic update, so the read that decides and the write that acts are
   * two statements and only this isolation level makes the pair safe.
   *
   * **Nothing is reserved.** A reservation exists to hold units between an
   * order being placed and its money arriving. Here the money has already
   * arrived, so there is no window to hold and the order is PAID at birth:
   * `stock` goes down by the quantity sold and `reserved` is not touched.
   * That is the same net effect the settlement of a checkout order has, with
   * the reservation step skipped because there never was one.
   *
   * **The unfulfillable purchase is recorded, not hidden.** A link takes the
   * money before it looks at anything, so by the time this runs the sale can
   * be one this API would never have made. Refusing to write anything would
   * leave a charge with no order behind it, so the order is written FAILED,
   * no stock moves, and the payment is still SUCCEEDED because the money
   * genuinely arrived. FAILED with a succeeded payment is precisely the state
   * that owes a refund.
   *
   * Three separate things make a purchase unfulfillable, and they are worth
   * enumerating because only the first is obvious:
   *
   * 1. **The units are gone.** Availability is `stock - reserved`, so a cart
   *    checkout holding a reservation is enough — the link buyer's money is
   *    kept while the reservation may later lapse and put the unit back.
   * 2. **The product is withdrawn.** Nothing deactivates a link when its
   *    product is soft-deleted or switched inactive, so the URL keeps taking
   *    money for something `OrdersService.placeOrder` would refuse to sell.
   *    The same check is applied here, against a row re-read in this
   *    transaction.
   * 3. **Stripe charged an amount this link does not account for.**
   *    `PAYMENT_LINK_QUANTITY` is an assertion about how the link was created
   *    — one unit, no adjustable quantity — and never a fact read back from
   *    the session's line items. Enabling adjustable quantity or promotion
   *    codes on the link in the Stripe dashboard would break it silently:
   *    a buyer pays for three, the order says one, and `Payment.amount` and
   *    `Order.total` disagree for good. Comparing the totals is the only
   *    detector available without a second Stripe call, and refusing the sale
   *    is what keeps that disagreement out of the database.
   */
  private async placeLinkOrder(
    session: Stripe.Checkout.Session,
    link: LinkWithSku,
    email: string,
  ): Promise<PaymentLinkSettlement> {
    const shipping = this.shippingFrom(session);
    // The link's price and not the SKU's: `unitPriceAtCreation` is what the
    // buyer was charged, and a price edit since then must not rewrite it.
    const unitPrice = link.unitPriceAtCreation;
    const total = unitPrice * PAYMENT_LINK_QUANTITY;

    // Both sides are integer cents, so a difference is a real disagreement
    // and never a rounding artefact.
    const chargedAsExpected =
      session.amount_total === null || session.amount_total === total;

    if (!chargedAsExpected) {
      this.logger.error(
        `Checkout session ${session.id} charged ${session.amount_total} for payment link ${link.id}, whose recorded unit price totals ${total}; the order is written FAILED and owes a refund.`,
      );
    }

    const orderId = newId();
    const paymentId = newId();

    const status = await this.prisma.$transaction(
      async (tx) => {
        const buyerId = await this.buyerFor(tx, email);

        // Re-read inside the transaction, with the product, because every
        // row that decides whether this sale can be fulfilled has to be in
        // the transaction's read set or `Serializable` has nothing to
        // protect. The link row was loaded outside it and its copy of both
        // is already stale.
        const sku = await tx.sku.findUnique({
          where: { id: link.skuId },
          include: { product: true },
        });

        const fulfillable =
          chargedAsExpected &&
          sku !== null &&
          sku.product.deletedAt === null &&
          sku.product.isActive &&
          availableOf(sku) >= PAYMENT_LINK_QUANTITY;

        if (fulfillable) {
          await tx.sku.update({
            where: { id: link.skuId },
            data: { stock: { decrement: PAYMENT_LINK_QUANTITY } },
          });
        }

        const orderStatus = fulfillable ? OrderStatus.PAID : OrderStatus.FAILED;

        await tx.order.create({
          data: {
            id: orderId,
            userId: buyerId,
            status: orderStatus,
            // Null on purpose: `expiresAt` is what the sweep uses to reclaim
            // a PENDING order, and this order was never pending.
            expiresAt: null,
            subtotal: total,
            orderDiscountAmount: 0,
            total,
            recipientName: shipping.recipientName,
            line1: shipping.line1,
            line2: shipping.line2,
            city: shipping.city,
            region: shipping.region,
            postalCode: shipping.postalCode,
            items: {
              create: [
                {
                  id: newId(),
                  sku: { connect: { id: link.skuId } },
                  // Frozen, like every order line: the history survives a
                  // rename, a price change or a product taken off sale. The
                  // freshly read name wins when there is one, so the snapshot
                  // is of the moment the order was written.
                  productName: sku?.product.name ?? link.sku.product.name,
                  unitPrice,
                  quantity: PAYMENT_LINK_QUANTITY,
                },
              ],
            },
          },
        });

        await recordStatus(tx, orderId, orderStatus);

        await tx.payment.create({
          data: {
            id: paymentId,
            orderId,
            method: PaymentMethod.PAYMENT_LINK,
            // SUCCEEDED even when the order is FAILED. The two columns
            // answer different questions: whether the money arrived, and
            // whether the goods can be sent.
            status: PaymentStatus.SUCCEEDED,
            amount: session.amount_total ?? total,
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId: idOf(session.payment_intent),
          },
        });

        return orderStatus;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (status === OrderStatus.FAILED) {
      // ─── Extension point: the refund this order owes ──────────────────
      //
      // A FAILED order with a SUCCEEDED payment is money kept for goods that
      // cannot be sent. The refund belongs to the settlement processor that
      // owns `POST /webhooks/stripe` and the queue — it is the same path that
      // already refunds a payment landing on a CANCELLED order, and
      // duplicating it here would give one order two refunders.
      //
      // **How often this branch is reached is not a rare-case question.** It
      // is not only sell-out: availability is `stock - reserved`, so a single
      // cart checkout holding a reservation is enough, and that reservation
      // can lapse half an hour later and put the unit back on the shelf with
      // the link buyer's money still ours. Nothing here retries and nothing
      // reconciles, so until the refund path exists this log line is the only
      // alarm, and it is an `error` for that reason rather than a `warn`.
      //
      // What this branch guarantees for that path is the state to act on: the
      // order, its single line, and a `Payment` row carrying the checkout
      // session and the payment intent.
      //
      // The other half of the answer is not here at all. A link should stop
      // taking money when its SKU sells out or its product is withdrawn, and
      // nothing deactivates one today — see the extension point at the foot
      // of `payment-links.service.ts`, which owns that call. Refusing the
      // sale is damage control; not offering it is the fix.
      // ──────────────────────────────────────────────────────────────────
      this.logger.error(
        `Order ${orderId} was paid through payment link ${link.id} but could not be fulfilled from SKU ${link.skuId}; it owes a refund.`,
      );
    }

    return { orderId, paymentId, status };
  }

  /**
   * The settlement this session already got, or null.
   *
   * `Payment.stripeCheckoutSessionId` is unique, so at most one row can
   * exist. Answering with it rather than throwing keeps a redelivery
   * harmless: the dispatcher sees the same settlement it saw the first time.
   */
  private async alreadySettled(
    sessionId: string,
  ): Promise<PaymentLinkSettlement | null> {
    const payment = await this.prisma.payment.findUnique({
      where: { stripeCheckoutSessionId: sessionId },
      include: { order: { select: { status: true } } },
    });

    if (!payment) return null;

    this.logger.log(
      `Checkout session ${sessionId} was already settled as order ${payment.orderId}.`,
    );

    return {
      orderId: payment.orderId,
      paymentId: payment.id,
      status: payment.order.status,
    };
  }

  /**
   * The buyer, found or created.
   *
   * A link buyer may have no account, and `Order.userId` is not nullable, so
   * one is made: `UserState.GUEST`, no password hash, no verified-at. That
   * account cannot be signed into — `AuthService` has no credential to check
   * — which is the intended shape: it exists to own an order, not to be a
   * login. `liveEmail` is the unique column, so a buyer who later registers
   * with the same address meets the ordinary "email already in use" path
   * rather than acquiring a second identity.
   *
   * A buyer who *already* has an account gets the order attached to it,
   * because the email is the same email they verified. That is why the
   * lookup comes first.
   */
  private async buyerFor(
    tx: Prisma.TransactionClient,
    email: string,
  ): Promise<string> {
    const existing = await tx.user.findUnique({
      where: { liveEmail: email },
      select: { id: true },
    });

    if (existing) return existing.id;

    const id = newId();

    await tx.user.create({
      data: {
        id,
        email,
        liveEmail: email,
        passwordHash: null,
        role: UserRole.CLIENT,
        state: UserState.GUEST,
        emailVerifiedAt: null,
      },
    });

    return id;
  }

  /**
   * The address Stripe collected, made total.
   *
   * The link is created with `billing_address_collection: 'required'`, so in
   * practice every field below is present. The types say otherwise, and the
   * decision when they are right is deliberate: **the empty string, and a
   * warning, rather than a refusal.** The money has already arrived. Refusing
   * to write the order would lose the sale and leave Stripe redelivering a
   * payload that will never improve, while an order carrying a blank address
   * line is visible, searchable and fixable by a manager. `getGuestOrder`
   * never publishes any of this, so a blank field is an operations problem
   * and not something a buyer is shown.
   */
  private shippingFrom(session: Stripe.Checkout.Session): ShippingDetails {
    const details = session.customer_details;
    const address = details?.address;
    const shipping: ShippingDetails = {
      recipientName: details?.name ?? details?.email ?? '',
      line1: address?.line1 ?? '',
      line2: address?.line2 ?? null,
      city: address?.city ?? '',
      region: address?.state ?? null,
      postalCode: address?.postal_code ?? '',
    };

    if (!shipping.recipientName || !shipping.line1 || !shipping.postalCode) {
      this.logger.warn(
        `Checkout session ${session.id} arrived without a complete address; the order is written with the fields Stripe supplied.`,
      );
    }

    return shipping;
  }
}

type LinkWithSku = Prisma.PaymentLinkGetPayload<{
  include: { sku: { include: { product: true } } };
}>;

/**
 * A Stripe field that is either an id or the expanded object, reduced to the
 * id. Nothing here expands anything, but the SDK types every such field as
 * the union and a webhook payload can carry either.
 */
function idOf(field: string | { id: string } | null): string | null {
  if (field === null) return null;

  return typeof field === 'string' ? field : field.id;
}
