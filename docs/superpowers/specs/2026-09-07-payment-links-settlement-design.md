# Payment Links Settlement and Lifecycle Design

## Goal

Complete `feat/payment-links` so managers can publish payment links, stale links are retired when catalogue state changes, Stripe checkout-session events reach the existing payment-link settlement handler, and the public flow is covered by end-to-end tests.

## Scope and branch topology

Work on `feat/payment-links`, first incorporating `origin/main`, then incorporating the existing `origin/feat/stripe-webhook` implementation. The webhook branch remains the single source of truth for signature verification, event recording, BullMQ settlement jobs, and the payment-intent settlement path; payment links add only the checkout-session branch and its consumer.

## Design

### Authorization

Grant `MANAGER` the unconditional CASL ability `create` on `PaymentLink`. Keep `CLIENT`, `DELIVERY`, and unauthenticated users denied. Add focused ability tests and an HTTP e2e assertion that a manager can call `POST /payment-links`, while a non-manager receives the existing policy response.

### Link lifecycle and Stripe errors

Add lifecycle operations to `PaymentLinksService` that find active links for a SKU or product, call `StripeService.deactivatePaymentLink`, and mark the local rows inactive. Invoke them when a SKU price changes, when SKU stock reaches zero, when a product is set inactive, and when a product is soft-deleted.

The local catalogue mutation remains authoritative and must not be rolled back because Stripe refused a cleanup call: the link is marked inactive locally, the failed Stripe operation is logged with the payment-link id, and the manager request still completes. This prevents stale links from blocking replacement links while making the residual Stripe exposure observable for manual remediation. Existing race-cleanup behavior remains best-effort and successful responses are preserved.

### Webhook settlement

Extend the shared settlement job contract with checkout-session event types (`checkout.session.completed` and `checkout.session.async_payment_succeeded`) and a `checkoutSessionId`. Keep job payloads identifier-only. The webhook producer records and queues these events exactly like payment-intent events.

The worker retrieves the verified Stripe event by its `stripeEventId`, then dispatches it to the exported `PaymentLinkCheckoutService.settleCheckoutSession`. The current payment-link service remains responsible for guest-user creation, amount/currency validation, stock fulfillment, failed-order/refund semantics, and session idempotency. Payment-intent settlement remains unchanged.

Keep the API tree's `StripeWebhookModule` as the producer-only boundary and keep `PaymentLinksModule` in the API `AppModule` for the manager endpoint. Import `PaymentLinksModule` into the worker tree so `SettlementService` can call the exported checkout handler without moving processors into the API process. Add a small Stripe-service seam for retrieving a recorded event so the worker does not copy customer data into Redis or the webhook table.

### End-to-end coverage

Extend the existing Stripe stub with payment-link creation/deactivation and event retrieval. Add e2e coverage for:

1. manager authorization and creation of one active payment-link row;
2. denial for a non-manager;
3. a signed checkout-session delivery being acknowledged, queued, and settled by the payment-link handler into a guest PAID order; and
4. event redelivery remaining idempotent.

The tests use the existing real Nest application, Prisma database, Redis queue, and fixture conventions. Stripe's network remains replaced at the `StripeService` seam.

## Error and idempotency invariants

- A Stripe deactivation failure cannot make a previously successful catalogue mutation appear failed.
- A checkout session is settled at most once by the unique Stripe session id and the recorded webhook event.
- A webhook acknowledgement means verified and recorded, not that the worker has completed the order.
- Payment-link order amounts come from the locally recorded `unitPriceAtCreation`, never from an untrusted event amount.
- No customer payload is added to Redis job data.

## Verification

Run focused unit tests after each red-green cycle, then the complete unit suite, typecheck/lint, and the e2e suite against the project Compose services. Confirm the updated branch is based on `origin/main` and contains the webhook integration without unrelated worktree changes.
