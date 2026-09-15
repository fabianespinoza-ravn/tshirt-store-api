# A FAILED payment-link order logs an alarm; the refund it owes is issued by the settlement processor, not here

A payment-link order can settle its Stripe payment successfully and still
fail to fulfill — e.g. a reservation backing availability lapses before the
purchase completes — leaving the store holding money for goods it can't ship.
`PaymentLinkCheckoutService` does not issue that refund itself: it only logs
an `error`, because the settlement processor behind `POST /webhooks/stripe`
and its queue already refunds a payment on a CANCELLED order, and that stays
the single place a refund is issued from. Until that path is extended to
cover the FAILED case too, the error log is the only alarm, which is why it
logs at `error` and not `warn`.

## Considered Options

- Refund directly from `PaymentLinkCheckoutService` when settlement produces
  a FAILED order — rejected: it would duplicate refund logic already owned by
  the settlement processor and risk issuing the refund twice.
