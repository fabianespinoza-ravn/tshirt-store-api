import { OrderStatus } from '@prisma/client';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { anOrder, anOrderItem, aSku, aUser } from '../../testing/factories';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { SettlementEventType, type SettlementJobData } from './settlement.jobs';
import { SettlementService } from './settlement.service';

const buyer = aUser();
const sku = aSku('018f3b6f-0000-7000-8000-0000000000ff', {
  stock: 10,
  reserved: 3,
});

/** The order as settlement reads it: its rows and its lines in one object. */
export const aSettleableOrder = (
  overrides: Parameters<typeof anOrder>[1] = {},
  quantity = 3,
) => {
  const order = anOrder(buyer.id, overrides);

  return {
    ...order,
    items: [anOrderItem(order.id, sku.id, { quantity })],
  };
};

/**
 * The job the webhook produced. Identifiers only, which is what
 * `SETTLEMENT_JOB_OPTIONS` keeping failures forever obliges the payload to
 * be.
 */
export const aSettlementJob = (
  overrides: Partial<SettlementJobData> = {},
): SettlementJobData => ({
  webhookEventId: '018f3b6f-0000-7000-8000-000000000010',
  stripeEventId: 'evt_delivered_once',
  eventType: SettlementEventType.PaymentIntentSucceeded,
  paymentIntentId: 'pi_settled_by_the_suite',
  orderId: '018f3b6f-0000-7000-8000-000000000001',
  ...overrides,
});

/**
 * The one file in this block where a missing assertion costs money, and the
 * cases are named accordingly.
 *
 * **The stock write is new behaviour and the reason the block exists.** Until
 * now a PAID order kept its units in `reserved` forever, so `stock -
 * reserved` understated availability for the rest of the SKU's life. What
 * has to be asserted is that both columns move, by the same amount, in the
 * same statement — a version that decremented only `reserved` would give the
 * units back to the shelf it had already sold them from, and one that
 * decremented only `stock` would leave the reservation stranded exactly as
 * before. Assert the Prisma call, not the returned row: the call is what
 * says which columns the code asked the database to change.
 *
 * **Every precondition has to be back in the `where`.** The sweep cancels
 * the same orders from the other direction, so the two race by design and
 * the only thing that keeps them safe is that each writes `status: PENDING`
 * into its own update and acts on the count. A settlement that read the
 * status and then wrote unconditionally passes every happy-path test and
 * decrements stock the sweep has already released.
 *
 * **The refund branch must record nothing before Stripe agrees.** A
 * `stripe_refund_id` written first is, afterwards, indistinguishable from
 * money that was actually returned — and the monitoring query that looks
 * for succeeded payments on cancelled orders with no refund id would then
 * read healthy over a customer who was never paid back. Order of calls is
 * the assertion, not the resulting row.
 */
describe('SettlementService', () => {
  let h: ServiceHarness<SettlementService>;

  beforeEach(async () => {
    h = await buildService(SettlementService);
    resetPrismaMock(h.prisma);

    // The ordinary settlement: a PENDING order with one line, an update
    // that moves exactly one row, and a refund Stripe would accept. Each
    // stub below changes one of those.
    h.prisma.order.findUnique.mockResolvedValue(aSettleableOrder());
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.orderStatusHistory.count.mockResolvedValue(1);
    h.stripe.refundPaymentIntent.mockResolvedValue('re_refunded_by_the_suite');
  });

  describe('an order that is still PENDING', () => {
    it.todo(`moves it to ${OrderStatus.PAID} and clears its expiry`);
    it.todo(
      `repeats ${OrderStatus.PENDING} in the where of the update, so a sweep that got there first wins`,
    );
    it.todo('writes nothing else when that update moved no row');
    it.todo(
      'fails the job when that update moved no row, so the retry re-reads the order',
    );
    it.todo(
      'decrements reserved and stock by the line quantity, in the same sku update',
    );
    it.todo('decrements each line of a multi-line order');
    it.todo(`appends the ${OrderStatus.PAID} row to the status history`);
    it.todo('marks the payment SUCCEEDED with the intent from the job');
    it.todo(
      'creates the payment row when checkout died before recording the intent',
    );
    it.todo("records the order's total, never an amount read out of the event");
    it.todo('stamps the webhook event processed inside the same transaction');
    it.todo('runs the whole settlement at Serializable');
    it.todo('opens exactly one transaction');
  });

  describe('an order that was already CANCELLED', () => {
    it.todo('refunds the intent through Stripe');
    it.todo('records the refund id and the refunded time on the payment');
    it.todo('records the refund only after Stripe has answered');
    it.todo(
      'leaves the order CANCELLED, because the sweep already sold its units to somebody else',
    );
    it.todo('gives nothing back to reserved or to stock');
    it.todo('lets a refund Stripe refuses fail the job, so BullMQ retries it');
    it.todo('records no refund id when the refund failed');
    it.todo(
      'does not create a second payment row when the only row is one it already refunded',
    );
    it.todo('keeps the first refunded time when the job runs again');
  });

  describe('an order in any other status', () => {
    it.todo('settles nothing for an order that is already PAID');
    it.todo('stamps the webhook event processed anyway, so the alert clears');
    it.todo('opens no transaction');
  });

  describe('what it refuses', () => {
    it.todo(
      'throws when the order named by the intent does not exist, rather than swallowing it',
    );
    it.todo('ignores an event type it has no branch for, without failing');
    it.todo(
      'does not overwrite the processed stamp of a delivery already settled',
    );
  });
});
