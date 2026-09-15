import { OrderStatus } from '@prisma/client';
import {
  fallsToThreshold,
  risesAboveThreshold,
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
 * The cases are named for the sentence each one pins rather than for the
 * arithmetic: what a reader needs is which reading of the brief is being
 * defended, and the numbers are derived from the constant so a change to it
 * cannot leave a case name lying.
 */
describe('the low-stock threshold', () => {
  const threshold = LOW_STOCK_THRESHOLD;
  const everyStatus = Object.values(OrderStatus);

  describe('falling to it, which is what fires the notification', () => {
    it(`fires on the sale that takes stock from ${threshold + 1} down to ${threshold}`, () => {
      expect(fallsToThreshold(threshold + 1, threshold)).toBe(true);
    });

    it(`fires when a multi-unit sale jumps clean over ${threshold}, from ${threshold + 3} to ${threshold - 2}`, () => {
      expect(fallsToThreshold(threshold + 3, threshold - 2)).toBe(true);
    });

    it(`does not fire again on the next sale, from ${threshold} to ${threshold - 1}`, () => {
      expect(fallsToThreshold(threshold, threshold - 1)).toBe(false);
    });

    it('does not fire when the stock was already at or below the threshold before the write', () => {
      expect(fallsToThreshold(threshold, 0)).toBe(false);
      expect(fallsToThreshold(threshold - 1, threshold - 2)).toBe(false);
      expect(fallsToThreshold(0, 0)).toBe(false);
    });

    it('does not fire when the write left the stock unchanged', () => {
      expect(fallsToThreshold(threshold + 1, threshold + 1)).toBe(false);
      expect(fallsToThreshold(threshold, threshold)).toBe(false);
    });

    it('does not fire when the write raised the stock', () => {
      expect(fallsToThreshold(threshold - 1, threshold + 5)).toBe(false);
      expect(fallsToThreshold(threshold + 1, threshold + 2)).toBe(false);
    });

    it('fires exactly once over a run of sales that walks the stock down to zero', () => {
      const start = threshold + 3;
      const firings = Array.from({ length: start }, (_, index) =>
        fallsToThreshold(start - index, start - index - 1),
      );

      expect(firings.filter(Boolean)).toHaveLength(1);
      expect(firings.indexOf(true)).toBe(start - threshold - 1);
    });
  });

  describe('rising back above it, which is what ends a cycle', () => {
    it(`treats a restock from ${threshold} up to ${threshold + 1} as the start of a new cycle`, () => {
      expect(risesAboveThreshold(threshold, threshold + 1)).toBe(true);
    });

    it(`does not start a cycle for a partial restock that stops at ${threshold}`, () => {
      expect(risesAboveThreshold(0, threshold)).toBe(false);
      expect(risesAboveThreshold(threshold - 1, threshold)).toBe(false);
    });

    it('does not start a cycle when the stock was already above the threshold', () => {
      expect(risesAboveThreshold(threshold + 1, threshold + 9)).toBe(false);
    });

    it('is never true at the same time as the falling predicate, for any pair of values', () => {
      const range = Array.from({ length: threshold * 3 }, (_, value) => value);
      const bothTrue = range.flatMap((previous) =>
        range
          .filter(
            (next) =>
              fallsToThreshold(previous, next) &&
              risesAboveThreshold(previous, next),
          )
          .map((next) => [previous, next]),
      );

      expect(bothTrue).toEqual([]);
      // And the pair that proves the sweep was capable of finding one.
      expect(fallsToThreshold(threshold + 1, threshold)).toBe(true);
      expect(risesAboveThreshold(threshold, threshold + 1)).toBe(true);
    });
  });

  describe('what counts as having purchased the product', () => {
    it('counts an order that settled, and the three states after it', () => {
      expect(PURCHASED_ORDER_STATUSES).toEqual([
        OrderStatus.PAID,
        OrderStatus.PROCESSING,
        OrderStatus.SHIPPED,
        OrderStatus.DELIVERED,
      ]);
    });

    it('does not count a PENDING order, which is a reservation that expires on its own', () => {
      expect(PURCHASED_ORDER_STATUSES).not.toContain(OrderStatus.PENDING);
    });

    it('does not count a cancelled order', () => {
      expect(PURCHASED_ORDER_STATUSES).not.toContain(OrderStatus.CANCELLED);
    });

    it('does not count a failed order', () => {
      expect(PURCHASED_ORDER_STATUSES).not.toContain(OrderStatus.FAILED);
    });

    it(`classifies each of the ${everyStatus.length} statuses OrderStatus declares, so a new one has to be decided on purpose`, () => {
      const classified = new Set(PURCHASED_ORDER_STATUSES);
      const expected: Record<OrderStatus, boolean> = {
        [OrderStatus.PENDING]: false,
        [OrderStatus.PAID]: true,
        [OrderStatus.PROCESSING]: true,
        [OrderStatus.SHIPPED]: true,
        [OrderStatus.DELIVERED]: true,
        [OrderStatus.CANCELLED]: false,
        [OrderStatus.FAILED]: false,
      };

      expect(Object.keys(expected)).toHaveLength(everyStatus.length);
      expect(
        everyStatus.map((status) => [status, classified.has(status)]),
      ).toEqual(everyStatus.map((status) => [status, expected[status]]));
    });

    it(`keeps ${PURCHASED_ORDER_STATUSES.length} statuses in the list, every one of them downstream of a settled payment`, () => {
      expect(PURCHASED_ORDER_STATUSES).toHaveLength(4);
      expect(new Set(PURCHASED_ORDER_STATUSES)).toEqual(
        new Set([
          OrderStatus.PAID,
          OrderStatus.PROCESSING,
          OrderStatus.SHIPPED,
          OrderStatus.DELIVERED,
        ]),
      );
    });
  });
});
