import { OrderStatus, UserRole } from '@prisma/client';
import {
  destinationsFor,
  releasesStock,
  TransitionVerdict,
  verdictFor,
} from './order-state-machine';

/**
 * These are authorization tests, not workflow tests, and the difference
 * decides how much they are worth.
 *
 * Because the contract exposes one route with the destination in the body,
 * the role could not move into a CASL action — so this function, and nothing
 * else, decides who may take an order where. `casl-guard` will not cover it:
 * that agent asks whether a CLIENT can reach another user's row, which the
 * ability's scope answers. "A CLIENT ships their own order" is outside its
 * question and inside this table.
 *
 * Assert the verdict and not merely that something was refused. The two
 * refusals are different answers — `ForbiddenForRole` becomes 403 and
 * `IllegalFromState` becomes 409 — and a test that only checks "not allowed"
 * would pass with the two swapped, which tells a client to retry something
 * that will never work or to give up on something that would have worked a
 * minute earlier.
 */
describe('verdictFor', () => {
  describe('a manager', () => {
    it('allows PAID to PROCESSING', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.PROCESSING, UserRole.MANAGER),
      ).toBe(TransitionVerdict.Allowed));
    it('allows PROCESSING to SHIPPED', () =>
      expect(
        verdictFor(
          OrderStatus.PROCESSING,
          OrderStatus.SHIPPED,
          UserRole.MANAGER,
        ),
      ).toBe(TransitionVerdict.Allowed));
    it('refuses PAID to SHIPPED as illegal, because it skips a step', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.SHIPPED, UserRole.MANAGER),
      ).toBe(TransitionVerdict.IllegalFromState));
    it('refuses PENDING to PROCESSING as illegal, before payment', () =>
      expect(
        verdictFor(
          OrderStatus.PENDING,
          OrderStatus.PROCESSING,
          UserRole.MANAGER,
        ),
      ).toBe(TransitionVerdict.IllegalFromState));
    it('refuses CANCELLED as forbidden: no manager move reaches it', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.CANCELLED, UserRole.MANAGER),
      ).toBe(TransitionVerdict.ForbiddenForRole));
    it("refuses DELIVERED as forbidden: that destination is the courier's", () =>
      expect(
        verdictFor(
          OrderStatus.SHIPPED,
          OrderStatus.DELIVERED,
          UserRole.MANAGER,
        ),
      ).toBe(TransitionVerdict.ForbiddenForRole));
  });

  describe('a client', () => {
    it('allows PENDING to CANCELLED', () =>
      expect(
        verdictFor(OrderStatus.PENDING, OrderStatus.CANCELLED, UserRole.CLIENT),
      ).toBe(TransitionVerdict.Allowed));
    it('refuses PAID to CANCELLED as illegal, which block 5 opens once a refund exists', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.CANCELLED, UserRole.CLIENT),
      ).toBe(TransitionVerdict.IllegalFromState));
    it('refuses PROCESSING to CANCELLED as illegal, for the same reason', () =>
      expect(
        verdictFor(
          OrderStatus.PROCESSING,
          OrderStatus.CANCELLED,
          UserRole.CLIENT,
        ),
      ).toBe(TransitionVerdict.IllegalFromState));
    it('refuses PROCESSING as forbidden: no client move reaches it', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.PROCESSING, UserRole.CLIENT),
      ).toBe(TransitionVerdict.ForbiddenForRole));
    it('refuses SHIPPED as forbidden', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.SHIPPED, UserRole.CLIENT),
      ).toBe(TransitionVerdict.ForbiddenForRole));
  });

  describe('a courier', () => {
    it('allows SHIPPED to DELIVERED', () =>
      expect(
        verdictFor(
          OrderStatus.SHIPPED,
          OrderStatus.DELIVERED,
          UserRole.DELIVERY,
        ),
      ).toBe(TransitionVerdict.Allowed));
    it('refuses PAID to DELIVERED as illegal', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.DELIVERED, UserRole.DELIVERY),
      ).toBe(TransitionVerdict.IllegalFromState));
    it('refuses SHIPPED as forbidden: only a manager ships', () =>
      expect(
        verdictFor(OrderStatus.PAID, OrderStatus.SHIPPED, UserRole.DELIVERY),
      ).toBe(TransitionVerdict.ForbiddenForRole));
  });

  describe('the states nothing leaves', () => {
    it('refuses every move out of CANCELLED', () => {
      for (const to of Object.values(OrderStatus))
        expect(
          verdictFor(OrderStatus.CANCELLED, to, UserRole.MANAGER),
        ).not.toBe(TransitionVerdict.Allowed);
    });
    it('refuses every move out of DELIVERED', () => {
      for (const to of Object.values(OrderStatus))
        expect(
          verdictFor(OrderStatus.DELIVERED, to, UserRole.MANAGER),
        ).not.toBe(TransitionVerdict.Allowed);
    });
    it('refuses a move from a status to itself', () => {
      for (const status of Object.values(OrderStatus))
        expect(verdictFor(status, status, UserRole.MANAGER)).not.toBe(
          TransitionVerdict.Allowed,
        );
    });
  });
});

describe('destinationsFor', () => {
  it('lists PROCESSING and SHIPPED for a manager', () =>
    expect(destinationsFor(UserRole.MANAGER)).toEqual([
      OrderStatus.PROCESSING,
      OrderStatus.SHIPPED,
    ]));
  it('lists only CANCELLED for a client', () =>
    expect(destinationsFor(UserRole.CLIENT)).toEqual([OrderStatus.CANCELLED]));
  it('is derived from the same table, so it cannot omit a legal move', () =>
    expect(destinationsFor(UserRole.DELIVERY)).toEqual([
      OrderStatus.DELIVERED,
    ]));
});

describe('releasesStock', () => {
  it('says a cancellation gives the units back', () =>
    expect(releasesStock(OrderStatus.CANCELLED)).toBe(true));
  it('says no other destination does', () => {
    for (const status of Object.values(OrderStatus).filter(
      (status) => status !== OrderStatus.CANCELLED,
    ))
      expect(releasesStock(status)).toBe(false);
  });
});
