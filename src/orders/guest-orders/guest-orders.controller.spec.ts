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
 * under "What does NOT go in the ability".
 */
describe('GuestOrdersController', () => {
  it.todo('delegates the order id to the service');

  it.todo('returns the guest view unchanged');

  it.todo('carries @Public(), so an anonymous caller is not answered 401');

  it.todo('carries no @CheckPolicies, because there is no subject to grant');

  it.todo('rejects a path segment that is not a UUID before it reaches Prisma');
});
