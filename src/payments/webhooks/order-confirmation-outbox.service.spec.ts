import { NotificationStatus } from '@prisma/client';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { OrderConfirmationOutboxService } from './order-confirmation-outbox.service';

/** A row this service would find still owing a confirmation. */
export const aPendingOutboxRow = (
  overrides: {
    id?: string;
    orderId?: string;
    email?: string;
    attempts?: number;
  } = {},
) => ({
  id: overrides.id ?? '018f3b6f-0000-7000-8000-000000000099',
  orderId: overrides.orderId ?? '018f3b6f-0000-7000-8000-000000000001',
  email: overrides.email ?? 'buyer@example.com',
  status: NotificationStatus.PENDING,
  attempts: overrides.attempts ?? 0,
  sentAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
});

/**
 * The scheduled retry `settlement.service.spec.ts` documents but cannot
 * exercise itself, since `SettlementService.confirm` never drains anything —
 * it only writes and reads the one row its own transaction created. This is
 * the other half: given whatever is still PENDING, does a run send it, mark
 * it, and leave alone what it could not.
 *
 * Every case here is a stub. The behaviour is new and was written this
 * session, so proving it correct — the Prisma calls a drain actually makes,
 * not what a mock happens to return — is the assertion this repo's CLAUDE.md
 * reserves for whoever picks the stub up.
 */
describe('OrderConfirmationOutboxService', () => {
  let h: ServiceHarness<OrderConfirmationOutboxService>;

  beforeEach(async () => {
    h = await buildService(OrderConfirmationOutboxService);
    resetPrismaMock(h.prisma);

    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([]);
  });

  it.todo('reads only rows in NotificationStatus.PENDING, oldest first');
  it.todo(
    'bounds one run to CONFIRMATION_OUTBOX_BATCH_SIZE rows, like the sweep bounds its own batch',
  );
  it.todo(
    "sends the confirmation to each pending row's own email and order id",
  );
  it.todo(
    'marks a row SENT with a sentAt once its confirmation was actually enqueued',
  );
  it.todo(
    'leaves a row PENDING and increments its attempts when the enqueue rejects',
  );
  it.todo(
    'keeps draining the rest of the batch after one row fails to enqueue',
  );
  it.todo(
    'reports examined, sent and failed counts that add up to what the run actually did',
  );
  it.todo('does nothing, and logs nothing, when no row is PENDING');
});
