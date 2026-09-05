import { OrderStatus, PaymentMethod, UserState } from '@prisma/client';
import { newId } from '../../common/ids';
import { Problems } from '../../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { GuestOrdersService } from './guest-orders.service';
import { GUEST_ORDER_SELECT, type GuestOrderRow } from './guest-orders.views';

/* Jest's asymmetric matchers are typed as `any`; the assertions below are
 * deliberately partial Prisma-call checks, not values passed to production. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const now = () => new Date('2026-08-28T12:00:00.000Z');

const BUYER_EMAIL = 'buyer@example.invalid';
const RECIPIENT_NAME = 'Ada Lovelace';
const STREET = '1 Analytical Street';
const CHECKOUT_SESSION_ID = 'cs-1';
const PAYMENT_INTENT_ID = 'pi-1';
const EXPIRES_AT = '2026-08-28T12:30:00.000Z';

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

/**
 * The same order with every column the select exists to leave behind bolted
 * back on.
 *
 * This is the fixture the "must never carry" cases need, and it is the
 * opposite of the one above on purpose. Feeding `toGuestOrder` a row that
 * only holds the published columns would make those cases pass against a
 * projection written as `{ ...order }`: the absence would be the fixture
 * doing the work rather than the code. The Stripe ids live on `Payment`
 * rather than on `Order` and are here for the same reason — a widened
 * `include` is exactly how they would arrive.
 */
function aLeakyRow(): GuestOrderRow {
  return {
    ...aGuestOrderRow(),
    recipientName: RECIPIENT_NAME,
    line1: STREET,
    line2: null,
    city: 'London',
    region: null,
    postalCode: 'E1 6AN',
    userId: newId(),
    user: { email: BUYER_EMAIL, liveEmail: BUYER_EMAIL },
    stripeCheckoutSessionId: CHECKOUT_SESSION_ID,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    expiresAt: new Date(EXPIRES_AT),
  } as unknown as GuestOrderRow;
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
    it('asks for the order by id', async () => {
      const orderId = newId();

      await harness.service.getOne(orderId);

      expect(harness.prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: orderId }),
        }),
      );
    });

    it('requires a PAYMENT_LINK payment, so a signed-in client order is unreachable here', async () => {
      const orderId = newId();

      await harness.service.getOne(orderId);

      expect(harness.prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: orderId,
            payments: { some: { method: PaymentMethod.PAYMENT_LINK } },
            user: { state: UserState.GUEST, deletedAt: null },
          },
        }),
      );
    });

    it('stops finding the order once its buyer verified an account, because verification moved it into their signed-in history', async () => {
      const orderId = newId();
      harness.prisma.order.findFirst.mockResolvedValue(null);

      await expect(harness.service.getOne(orderId)).rejects.toMatchObject({
        kind: Problems.notFound,
      });
      expect(harness.prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: { state: UserState.GUEST, deletedAt: null },
          }),
        }),
      );
    });

    it('selects only the published columns, so the address never leaves Postgres', async () => {
      await harness.service.getOne(newId());

      const [args] = harness.prisma.order.findFirst.mock.calls[0];
      const select = args?.select;

      expect(select).toEqual(GUEST_ORDER_SELECT);
      // An `include` would fetch the whole row and leave the projection as
      // the only thing between the address and the response.
      expect(args?.include).toBeUndefined();

      for (const column of [
        'recipientName',
        'line1',
        'line2',
        'city',
        'region',
        'postalCode',
        'userId',
        'user',
        'expiresAt',
        'payments',
      ]) {
        expect(select).not.toHaveProperty(column);
      }
    });
  });

  describe('what it answers', () => {
    it('answers 404 for an id that matches nothing', async () => {
      harness.prisma.order.findFirst.mockResolvedValue(null);

      await expect(harness.service.getOne(newId())).rejects.toMatchObject({
        // The kind, not the class: `toBeInstanceOf(ProblemException)` passes
        // for every problem this API can raise.
        kind: Problems.notFound,
      });
    });

    it('answers 404 and never 403 for an order that exists but was not paid by link', async () => {
      harness.prisma.order.findFirst.mockResolvedValue(null);

      const rejected: unknown = await harness.service
        .getOne(newId())
        .catch((error: unknown) => error);

      expect(rejected).toMatchObject({ kind: Problems.notFound });
      expect(rejected).not.toMatchObject({ kind: Problems.forbidden });
    });

    it('computes each line total from the snapshot unit price', async () => {
      harness.prisma.order.findFirst.mockResolvedValue(
        aGuestOrderRow({
          total: 4749,
          items: [
            { productName: 'Snapshot tee', unitPrice: 1250, quantity: 3 },
            { productName: 'Second line', unitPrice: 999, quantity: 1 },
          ],
        }) as never,
      );

      const view = await harness.service.getOne(newId());

      expect(view.items).toEqual([
        {
          productName: 'Snapshot tee',
          unitPrice: 1250,
          quantity: 3,
          lineTotal: 3750,
        },
        {
          productName: 'Second line',
          unitPrice: 999,
          quantity: 1,
          lineTotal: 999,
        },
      ]);
    });

    it('serialises placedAt as an ISO string', async () => {
      harness.prisma.order.findFirst.mockResolvedValue(
        aGuestOrderRow({ createdAt: now() }) as never,
      );

      const view = await harness.service.getOne(newId());

      expect(typeof view.placedAt).toBe('string');
      expect(view.placedAt).toBe('2026-08-28T12:00:00.000Z');
      expect(view).not.toHaveProperty('createdAt');
    });
  });

  describe('what the view must never carry', () => {
    beforeEach(() => {
      harness.prisma.order.findFirst.mockResolvedValue(aLeakyRow() as never);
    });

    it('publishes no recipient name and no shipping address', async () => {
      const view = await harness.service.getOne(newId());

      for (const field of [
        'recipientName',
        'line1',
        'line2',
        'city',
        'region',
        'postalCode',
      ]) {
        expect(view).not.toHaveProperty(field);
      }

      // The values as well as the keys: a leak under a renamed key is still
      // a leak.
      expect(JSON.stringify(view)).not.toContain(RECIPIENT_NAME);
      expect(JSON.stringify(view)).not.toContain(STREET);
    });

    it('publishes no buyer id and no buyer email', async () => {
      const view = await harness.service.getOne(newId());

      expect(view).not.toHaveProperty('userId');
      expect(view).not.toHaveProperty('user');
      expect(view).not.toHaveProperty('email');
      expect(JSON.stringify(view)).not.toContain(BUYER_EMAIL);
    });

    it('publishes no Stripe session or payment intent id', async () => {
      const view = await harness.service.getOne(newId());

      expect(view).not.toHaveProperty('stripeCheckoutSessionId');
      expect(view).not.toHaveProperty('stripePaymentIntentId');
      expect(JSON.stringify(view)).not.toContain(CHECKOUT_SESSION_ID);
      expect(JSON.stringify(view)).not.toContain(PAYMENT_INTENT_ID);
    });

    it('publishes no expiresAt', async () => {
      const view = await harness.service.getOne(newId());

      expect(view).not.toHaveProperty('expiresAt');
      expect(JSON.stringify(view)).not.toContain(EXPIRES_AT);
    });
  });
});
