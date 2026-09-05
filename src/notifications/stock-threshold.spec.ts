import { OrderStatus } from '@prisma/client';
import {
  LOW_STOCK_THRESHOLD,
  PURCHASED_ORDER_STATUSES,
} from './stock-threshold';

/**
 * The two predicates and the one list that carry the whole reading of
 * *"when the stock of a product reaches 3"*.
 *
 * They are worth their own file because each is a decision stated as a
 * value, and a value is exactly what a later tidy changes without meaning
 * to. `>` becoming `>=` on the left of `fallsToThreshold` re-fires the
 * notification on every sale below three. `OrderStatus.PENDING` finding its
 * way into `PURCHASED_ORDER_STATUSES` silences the message for everybody
 * with an abandoned basket. Neither would fail anything else in this suite.
 *
 * The stubs are named for the sentence each one pins rather than for the
 * arithmetic: what a reader needs is which reading of the brief is being
 * defended, and the numbers are derived from the constant so a change to it
 * cannot leave a case name lying.
 */
describe('the low-stock threshold', () => {
  const threshold = LOW_STOCK_THRESHOLD;
  const everyStatus = Object.values(OrderStatus);

  describe('falling to it, which is what fires the notification', () => {
    it.todo(
      `fires on the sale that takes stock from ${threshold + 1} down to ${threshold}`,
    );

    it.todo(
      `fires when a multi-unit sale jumps clean over ${threshold}, from ${threshold + 3} to ${threshold - 2}`,
    );

    it.todo(
      `does not fire again on the next sale, from ${threshold} to ${threshold - 1}`,
    );

    it.todo(
      'does not fire when the stock was already at or below the threshold before the write',
    );

    it.todo('does not fire when the write left the stock unchanged');

    it.todo('does not fire when the write raised the stock');

    it.todo(
      'fires exactly once over a run of sales that walks the stock down to zero',
    );
  });

  describe('rising back above it, which is what ends a cycle', () => {
    it.todo(
      `treats a restock from ${threshold} up to ${threshold + 1} as the start of a new cycle`,
    );

    it.todo(
      `does not start a cycle for a partial restock that stops at ${threshold}`,
    );

    it.todo(
      'does not start a cycle when the stock was already above the threshold',
    );

    it.todo(
      'is never true at the same time as the falling predicate, for any pair of values',
    );
  });

  describe('what counts as having purchased the product', () => {
    it.todo('counts an order that settled, and the three states after it');

    it.todo(
      'does not count a PENDING order, which is a reservation that expires on its own',
    );

    it.todo('does not count a cancelled order');

    it.todo('does not count a failed order');

    it.todo(
      `classifies each of the ${everyStatus.length} statuses OrderStatus declares, so a new one has to be decided on purpose`,
    );

    it.todo(
      `keeps ${PURCHASED_ORDER_STATUSES.length} statuses in the list, every one of them downstream of a settled payment`,
    );
  });
});
