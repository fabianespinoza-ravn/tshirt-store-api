import { HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { OrderStatus } from '@prisma/client';
import { CHECK_POLICIES_KEY } from '../../auth/casl/check-policies.decorator';
import { newId } from '../../common/ids';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { GuestOrdersController } from './guest-orders.controller';
import type { GuestOrdersService } from './guest-orders.service';
import type { GuestOrderView } from './guest-orders.views';

/**
 * A hand-built service double is all this needs, the way
 * `cart/cart.controller.spec.ts` works: the handler delegates and returns,
 * and everything that makes the route safe lives in the service's `where`
 * and in `guest-orders.views.ts`.
 *
 * The two cases that are not about delegation are the two that make this a
 * public route: `@Public()` has to be on the handler or the global JWT guard
 * answers 401 to the buyer the route exists for, and no `@CheckPolicies` may
 * appear on it, because docs/AUTHORIZATION-MATRIX.md puts `getGuestOrder`
 * under "What does NOT go in the ability". Both are asserted here rather
 * than assumed: they are the reachability of an unauthenticated route, and
 * a decorator quietly dropped from the handler is invisible until a real
 * buyer is answered 401 by a route that exists for them.
 */
const guestView: GuestOrderView = {
  id: newId(),
  status: OrderStatus.PAID,
  items: [
    {
      productName: 'Snapshot tee',
      quantity: 1,
      unitPrice: 2599,
      lineTotal: 2599,
    },
  ],
  total: 2599,
  placedAt: '2026-08-28T12:00:00.000Z',
};

describe('GuestOrdersController', () => {
  const service = { getOne: jest.fn() };
  const controller = new GuestOrdersController(
    service as unknown as GuestOrdersService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    service.getOne.mockResolvedValue(guestView);
  });

  it('delegates the order id to the service', async () => {
    const orderId = newId();

    await controller.getGuestOrder(orderId);

    expect(service.getOne).toHaveBeenCalledWith(orderId);
    expect(service.getOne).toHaveBeenCalledTimes(1);
  });

  it('returns the guest view unchanged', async () => {
    // `toBe` and not `toEqual`: the handler must hand back the very object
    // the service built, so a controller that reshaped or re-wrapped the view
    // — the way a leak would arrive — fails here.
    await expect(controller.getGuestOrder(guestView.id)).resolves.toBe(
      guestView,
    );
  });

  it('carries @Public(), so an anonymous caller is not answered 401', () => {
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        GuestOrdersController.prototype.getGuestOrder,
      ),
    ).toBe(true);
  });

  it('carries no @CheckPolicies, because there is no subject to grant', () => {
    expect(
      Reflect.getMetadata(
        CHECK_POLICIES_KEY,
        GuestOrdersController.prototype.getGuestOrder,
      ),
    ).toBeUndefined();
  });

  it('rejects a path segment that is not a UUID before it reaches Prisma', async () => {
    // Two halves, and both are needed: that the pipe is declared on the
    // `orderId` parameter, and that the pipe refuses a malformed id with a
    // 400 while letting a real UUIDv7 through. Asserting only the second
    // would pass with the decorator deleted.
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      GuestOrdersController,
      'getGuestOrder',
    ) as Record<string, { index: number; data: string; pipes: unknown[] }>;

    const [orderIdParam] = Object.values(args);
    expect(orderIdParam.data).toBe('orderId');
    expect(orderIdParam.pipes).toEqual([ParseUUIDPipe]);

    const pipe = new ParseUUIDPipe();
    const metadata = { type: 'param', data: 'orderId' } as const;

    const refused: unknown = await pipe
      .transform('not-a-uuid', metadata)
      .catch((error: unknown) => error);

    expect((refused as { getStatus: () => number }).getStatus()).toBe(
      HttpStatus.BAD_REQUEST,
    );
    expect((refused as Error).message).toContain('uuid');

    await expect(pipe.transform(guestView.id, metadata)).resolves.toBe(
      guestView.id,
    );
    expect(service.getOne).not.toHaveBeenCalled();
  });
});
