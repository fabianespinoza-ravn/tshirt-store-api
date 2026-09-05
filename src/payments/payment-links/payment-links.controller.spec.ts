/**
 * The controller takes a hand-built double rather than the `buildService`
 * harness, the way `cart/cart.controller.spec.ts` does: there is no Prisma
 * and no Stripe on this side of the boundary, only a service mock, an
 * Express response reduced to `status`, and the DTO.
 *
 * `PaymentLinksController.createPaymentLink` is the only handler, and the
 * cases below are the whole of its contract — delegation, and the 201/200
 * split the matrix declares for `createPaymentLink`.
 */
describe('PaymentLinksController', () => {
  it.todo('delegates the SKU id from the DTO to the service');

  it.todo('sets 201 when the service reports it created the link');

  it.todo('sets 200 when the SKU already had an active link');

  it.todo('returns the link view as the body in both cases');

  // Named here rather than left to the ability spec, because it is this
  // route's contract rather than the ability's: `PaymentLink` is a declared
  // CASL subject carrying no rule, so `PoliciesGuard` denies every caller —
  // a MANAGER included — until the rule named in the controller's extension
  // point is written.
  it.todo(
    'requires create on PaymentLink, which no ability rule grants yet, so the route answers 403',
  );
});
