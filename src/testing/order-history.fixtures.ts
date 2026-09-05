import { OrderStatus, type OrderStatusHistory } from '@prisma/client';
import { anOrderStatusHistory } from './factories';
import type { PrismaMock } from './prisma.mock';

/**
 * Fixtures for `OrdersService.statusHistory`, kept here rather than inline so
 * the unit spec and any later suite arrange the same five transitions.
 *
 * The service reads the history through the order — one `order.findFirst`
 * with `statusHistory` selected — so arranging it means resolving that call
 * with a row carrying the entries, and *not* mocking
 * `prisma.orderStatusHistory.findMany`. A mock of the latter would pass while
 * the service asked for nothing at all.
 *
 * WHAT AN ASSERTION HERE CAN AND CANNOT PROVE. The mock ignores `orderBy`, so
 * the array a case receives is whatever `transitions` held: asserting on its
 * order proves the fixture, not the code. `SHUFFLED_TRANSITIONS` exists to
 * make that failure mode visible rather than to be asserted on. The claim
 * that the answer is ordered by `sequence` is proved by asserting the Prisma
 * call — `expect(prisma.order.findFirst).toHaveBeenCalledWith(...)` with
 * `orderBy: { sequence: 'asc' }` inside the selected relation — which is what
 * `CLAUDE.md` asks for and the only thing that survives a rewrite of the
 * query.
 */
export const HISTORY_ORDER_ID = 'order-with-history';

/**
 * One order's life, as `recordStatus` would have written it: five rows,
 * `sequence` starting at zero and rising by one, timestamps ascending with
 * it. The last two share a timestamp on purpose — that is the case a
 * timestamp sort cannot order and `sequence` can.
 */
export const RECORDED_TRANSITIONS: readonly OrderStatusHistory[] = [
  anOrderStatusHistory(HISTORY_ORDER_ID, {
    status: OrderStatus.PENDING,
    sequence: 0,
    createdAt: new Date('2026-01-10T09:00:00.000Z'),
  }),
  anOrderStatusHistory(HISTORY_ORDER_ID, {
    status: OrderStatus.PAID,
    sequence: 1,
    createdAt: new Date('2026-01-10T09:04:00.000Z'),
  }),
  anOrderStatusHistory(HISTORY_ORDER_ID, {
    status: OrderStatus.PROCESSING,
    sequence: 2,
    createdAt: new Date('2026-01-11T08:00:00.000Z'),
  }),
  anOrderStatusHistory(HISTORY_ORDER_ID, {
    status: OrderStatus.SHIPPED,
    sequence: 3,
    createdAt: new Date('2026-01-12T10:15:00.000Z'),
  }),
  anOrderStatusHistory(HISTORY_ORDER_ID, {
    status: OrderStatus.DELIVERED,
    sequence: 4,
    createdAt: new Date('2026-01-12T10:15:00.000Z'),
  }),
];

/**
 * The same five rows in an order no reader should depend on. Arrange with
 * these when the case is about the query carrying `orderBy`, so that a
 * service which dropped it cannot be rescued by a fixture that happened to
 * be sorted already.
 */
export const SHUFFLED_TRANSITIONS: readonly OrderStatusHistory[] = [
  RECORDED_TRANSITIONS[3],
  RECORDED_TRANSITIONS[0],
  RECORDED_TRANSITIONS[4],
  RECORDED_TRANSITIONS[1],
  RECORDED_TRANSITIONS[2],
];

export interface StatusHistoryArrangement {
  orderId?: string;
  transitions?: readonly OrderStatusHistory[];
  /**
   * False arranges an order the caller cannot reach — which, because the
   * scope is inside the `where`, is the same resolved `null` as an order that
   * does not exist. That indistinguishability is the point of the 404, so the
   * two cases share one arrangement rather than getting one each.
   */
  reachable?: boolean;
}

/**
 * Resolves the single `order.findFirst` the read makes, and returns the
 * transitions it will find so a case can name its expectations from the same
 * source the service was handed.
 */
export function arrangeStatusHistory(
  prisma: PrismaMock,
  options: StatusHistoryArrangement = {},
): readonly OrderStatusHistory[] {
  const transitions = options.transitions ?? RECORDED_TRANSITIONS;

  prisma.order.findFirst.mockResolvedValue(
    options.reachable === false
      ? null
      : ({ statusHistory: transitions } as never),
  );

  return transitions;
}
