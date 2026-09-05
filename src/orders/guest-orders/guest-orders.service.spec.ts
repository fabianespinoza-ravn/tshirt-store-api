import { OrderStatus } from '@prisma/client';
import { newId } from '../../common/ids';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { GuestOrdersService } from './guest-orders.service';
import type { GuestOrderRow } from './guest-orders.views';

const now = () => new Date('2026-08-28T12:00:00.000Z');

/**
 * The row shape `GUEST_ORDER_SELECT` produces, and nothing wider.
 *
 * Building it from `factories.anOrder` would hand the service a full `Order`
 * — address, buyer id and all — and a projection that leaked one of them
 * would still pass. A fixture that only holds the selected columns is what
 * makes the absence of the rest testable at all.
 */
function aGuestOrderRow(overrides: Partial<GuestOrderRow> = {}): GuestOrderRow {
  return {
    id: newId(),
    status: OrderStatus.PAID,
    total: 2599,
    createdAt: now(),
    items: [{ productName: 'Snapshot tee', unitPrice: 2599, quantity: 1 }],
    ...overrides,
  };
}

describe('GuestOrdersService', () => {
  let harness: ServiceHarness<GuestOrdersService>;

  beforeAll(async () => {
    harness = await buildService(GuestOrdersService);
  });

  beforeEach(() => {
    resetPrismaMock(harness.prisma);
    jest.clearAllMocks();

    harness.prisma.order.findFirst.mockResolvedValue(aGuestOrderRow() as never);
  });

  describe('the query it sends', () => {
    it.todo('asks for the order by id');

    it.todo(
      'requires a PAYMENT_LINK payment, so a signed-in client order is unreachable here',
    );

    it.todo(
      'selects only the published columns, so the address never leaves Postgres',
    );
  });

  describe('what it answers', () => {
    it.todo('answers 404 for an id that matches nothing');

    it.todo(
      'answers 404 and never 403 for an order that exists but was not paid by link',
    );

    it.todo('computes each line total from the snapshot unit price');

    it.todo('serialises placedAt as an ISO string');
  });

  describe('what the view must never carry', () => {
    it.todo('publishes no recipient name and no shipping address');

    it.todo('publishes no buyer id and no buyer email');

    it.todo('publishes no Stripe session or payment intent id');

    it.todo('publishes no expiresAt');
  });
});
