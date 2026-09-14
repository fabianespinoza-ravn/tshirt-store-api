# DELIVERY's CASL scope leaves `deliveredById` unconditional on status and relies on the order state machine to bound `update`

`docs/AUTHORIZATION-MATRIX.md` scopes DELIVERY to "any SHIPPED order, plus the
DELIVERED ones they delivered," but CASL conditions on `Order` can't express
the destination-specific limit (SHIPPED → DELIVERED only) that `update`
implies. We chose `can(['read','update'], 'Order', { deliveredById: user.id })`
without an added `status: OrderStatus.DELIVERED` clause, because today
`deliveredById` is written only by the DELIVERED transition so the two sets
already coincide, and we chose to grant `update` on any SHIPPED order rather
than a narrower CASL condition, leaving `order-state-machine.ts` as the actual
gate on which transitions a courier may perform — because the ability rule
can't see the destination of an `update`, only the row's current state.

## Considered Options

- Add `status: OrderStatus.DELIVERED` to the `deliveredById` condition now —
  the narrower reading of the matrix, but rejected as redundant while the
  invariant holds; revisit if `deliveredById` is ever set outside the
  DELIVERED transition.
- Scope `update` in CASL to the SHIPPED→DELIVERED transition specifically —
  not possible: the rule sees only the row, not the destination status, so
  the state machine enforces this instead.
