import type { PrismaService } from '../prisma/prisma.service';
import type { StripeService } from '../payments/stripe.service';

/**
 * How long Stripe keeps an idempotency key, and therefore how long asking
 * for an order's intent again returns the same one rather than making a new
 * one. Documented by Stripe as 24 hours.
 */
export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1_000;

/** Just enough of an order to reach its payment. */
export interface RecoverableOrder {
  id: string;
  total: number;
  createdAt: Date;
}

/**
 * The intent that has to be cancelled before this order's stock is released,
 * or `null` when it cannot be reached and therefore nothing may be released.
 *
 * Two callers need this and they must not disagree: the sweep, which reclaims
 * an order nobody came back for, and checkout, which reclaims a lapsed order
 * for the customer who did. The first version lived only in the sweep, the
 * second was written again by hand in checkout, and the bound below was left
 * out of the copy — so one path was safe and the other was not. Both call
 * this now, which is the actual fix.
 *
 * The bound is the whole of it. Recovery leans on the order's id still being
 * a live idempotency key: within the window, asking again returns the intent
 * that already exists. Past it, asking again **creates a second one**, and
 * cancelling that while the first stays active would release the stock with a
 * real charge still pointed at it — worse than doing nothing. The comparison
 * is `>=` because a key at exactly its retention age is already gone as far
 * as anything here can tell.
 */
export async function intentToCancel(
  prisma: PrismaService,
  stripe: StripeService,
  order: RecoverableOrder,
  now: Date,
): Promise<string | null> {
  const payment = await prisma.payment.findFirst({
    where: { orderId: order.id, stripePaymentIntentId: { not: null } },
    select: { stripePaymentIntentId: true },
    orderBy: { createdAt: 'desc' },
  });

  if (payment?.stripePaymentIntentId) {
    return payment.stripePaymentIntentId;
  }

  // No recorded intent is the window between checkout's commit and the row
  // that records what it created. Inside the key's lifetime that is
  // recoverable; outside it, it is not.
  if (now.getTime() - order.createdAt.getTime() >= IDEMPOTENCY_KEY_TTL_MS) {
    return null;
  }

  return (await stripe.createPaymentIntent(order)).id;
}
