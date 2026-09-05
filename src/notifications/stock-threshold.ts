import { OrderStatus } from '@prisma/client';

/**
 * The number the brief names: *"when the stock of a product reaches 3"*.
 *
 * It is a constant and not a literal because it appears in three places
 * that must agree — the crossing that fires the notification, the crossing
 * that opens the next cycle, and whatever a future `PATCH /skus` decides to
 * publish — and because "3" scattered about is indistinguishable from the
 * three of any other rule.
 *
 * It is deliberately not an environment variable. Making it configurable
 * would mean a `StockNotification` row no longer records which threshold it
 * was written for, and `uq_stock_notifications_user_sku_cycle` would start
 * deduplicating across two different rules. That is finding 12's "would
 * change if" in docs/DESIGN-ATTACK.md, and it needs a schema column before
 * it needs a variable.
 */
export const LOW_STOCK_THRESHOLD = 3;

/**
 * **Reaching three is an event, not a state, and this is the whole point.**
 *
 * `stock <= 3` is true of every sale after the third-from-last one, so a
 * rule written that way re-fires on 3 → 2 → 1 → 0 and sends the same person
 * the same message four times. What the brief describes is the moment the
 * count *arrives* at three from above, which needs the previous value as
 * well as the new one — and the only place both exist is inside the write
 * that changed it.
 *
 * `>` on the left and `<=` on the right, rather than `=== LOW_STOCK_THRESHOLD`
 * on the right: an order for five units takes a SKU from 6 to 1 without ever
 * being equal to 3, and that is a crossing by any reading of the sentence.
 */
export const fallsToThreshold = (
  previousStock: number,
  newStock: number,
): boolean =>
  previousStock > LOW_STOCK_THRESHOLD && newStock <= LOW_STOCK_THRESHOLD;

/**
 * The same crossing upwards, which is what ends a cycle.
 *
 * `Sku.restockCycle` is the third column of
 * `uq_stock_notifications_user_sku_cycle`, so it is the thing that lets the
 * same user be told about the same SKU twice in its lifetime. Nothing in the
 * contract writes it — finding 12 in docs/DESIGN-ATTACK.md — and until
 * something does, a SKU that sells down, is restocked and sells down again
 * notifies nobody the second time.
 *
 * This is the rule that finding recommends: the cycle advances when stock
 * comes back up through the threshold, which is the only reading under which
 * the word *cycle* means anything. It must be applied in the same write that
 * changes the stock, which is why it is exposed as a predicate rather than
 * performed here.
 */
export const risesAboveThreshold = (
  previousStock: number,
  newStock: number,
): boolean =>
  previousStock <= LOW_STOCK_THRESHOLD && newStock > LOW_STOCK_THRESHOLD;

/**
 * What "has purchased it" means, and it is a decision rather than a lookup.
 *
 * The brief says *"liked the product but haven't purchased it yet"*. An
 * `OrderItem` alone does not say a purchase happened: a PENDING order is a
 * held reservation that expires on its own, and CANCELLED and FAILED are the
 * two ways it ends without money moving. Counting any of those three would
 * silence the nudge for somebody who never bought anything — the exact
 * person the message is for.
 *
 * So the list is the statuses an order can only reach *after* a payment
 * succeeded. PAID is the settlement itself; PROCESSING, SHIPPED and
 * DELIVERED are downstream of it and no path returns to PENDING, so an order
 * in any of them was paid for.
 *
 * Deliberately not modelled: a refund. `Payment.refundedAt` exists and no
 * order status corresponds to it, so a refunded order still counts as a
 * purchase here. Suppressing a marketing nudge is the harmless direction to
 * be wrong in, and the alternative would be inventing a status the schema
 * does not have.
 */
export const PURCHASED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];
