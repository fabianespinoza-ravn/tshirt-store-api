# Guest order lookup treats the order id as the credential, not a session

A payment-link buyer may have no account, yet still needs a way to check on
their order after checkout. We scope `GuestOrdersService.getOne` to orders
that carry a `PaymentMethod.PAYMENT_LINK` payment, treat the UUIDv7 order id
as the sole credential, and return 404 — never 403 — for anything outside
that scope, including a signed-in client's own `PAYMENT_INTENT` order. This
is accepted because a UUIDv7 (a millisecond timestamp plus 74 random bits) is
not guessable, even though it leaks the way URLs leak — referrers,
screenshots, a shared browser — and never expires, which is why the guest
view stays deliberately thin: sized to what a leaked URL may cost.

## Considered Options

- Require the caller to be signed in (or hold an ephemeral token) to view a
  paid-by-link order — rejected: it would defeat the point of a checkout flow
  aimed at buyers with no account.
- Return 403 for an order outside the caller's reach — rejected: it would let
  the route be used to enumerate which order ids exist.
