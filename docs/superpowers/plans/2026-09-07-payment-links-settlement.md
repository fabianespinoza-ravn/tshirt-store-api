# Payment Links Settlement and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete feat/payment-links with manager authorization, safe link deactivation, Stripe checkout-session settlement, and end-to-end coverage.

**Architecture:** Keep StripeWebhookModule as the API-side verifier/recorder/producer. Extend its identifier-only BullMQ job contract for checkout sessions, then let the worker retrieve the recorded Stripe event and call the exported PaymentLinkCheckoutService. Catalogue mutations mark local payment links inactive and attempt Stripe deactivation as best-effort cleanup, so the catalogue remains responsive while failures are logged.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Stripe SDK, BullMQ/Redis, Jest, Supertest, Docker Compose.

**Spec:** docs/superpowers/specs/2026-09-07-payment-links-settlement-design.md

## Global Constraints

- Follow red-green-refactor for every behavior change: write one failing test, observe the expected failure, implement the minimum, then rerun the focused test.
- Preserve integer cents throughout payment-link and settlement flows.
- Keep webhook queue payloads to identifiers; do not copy customer details or full Stripe events into Redis or webhook_events.payload.
- Keep problem-details.filter.ts as the only HTTP error formatter.
- Do not lower the coverage floor or add assertions for assistant-generated code.
- Use English code, comments, commit messages, and test names; use conventional commits.
- Do not change existing payment-intent settlement behavior while adding checkout-session settlement.
- Do not commit .env files, credentials, or assistant attribution.

---

### Task 1: Update the feature branch and integrate the webhook branch

**Files:**

- Git merges: origin/main and origin/feat/stripe-webhook
- Review after merge: src/app.module.ts, src/worker.module.ts, src/main.ts, src/payments/stripe.service.ts, prisma/schema.prisma, package.json, package-lock.json

**Interfaces:**

- The branch contains current main plus the existing Stripe webhook producer/worker infrastructure.
- PaymentLinksModule, GuestOrdersModule, StripeWebhookModule, raw-body boot configuration, settlement processors, confirmation outbox, and schema changes from both branches are preserved.

- [ ] Step 1: Confirm the worktree and fetch refs.

Run from C:\Users\edicius\orca\workspaces\w3-api\links:

~~~powershell
git status --short --branch
git fetch origin
git rev-parse --abbrev-ref HEAD
git rev-list --left-right --count origin/main...HEAD
~~~

Expected: branch feat/payment-links, clean worktree, and one commit behind origin/main before the merge.

- [ ] Step 2: Merge main and the webhook branch.

~~~powershell
git merge --no-ff origin/main -m "merge: update payment links with main"
git merge --no-ff origin/feat/stripe-webhook -m "merge: connect payment links to stripe settlement"
~~~

Resolve shared files with these ownership rules:

- src/app.module.ts keeps both PaymentLinksModule and StripeWebhookModule plus every unrelated module.
- src/worker.module.ts keeps webhook settlement, confirmation-outbox, mail, sweep, and notification providers; it imports PaymentLinksModule; processors remain out of AppModule.
- src/main.ts keeps rawBody: true.
- src/payments/stripe.service.ts retains payment-intent, payment-link creation/deactivation, webhook signature, and refund methods.
- prisma/schema.prisma keeps the union of payment-link, webhook-event, payment, outbox, and existing main models/enums.
- package.json and package-lock.json retain the union of scripts and dependency entries; run npm install only if the lockfile is inconsistent.

After resolving conflicts:

~~~powershell
git add <resolved-files>
git commit --no-edit
~~~

- [ ] Step 3: Verify the merged baseline.

~~~powershell
npm run typecheck
npm test -- --runInBand
git diff --check
~~~

Expected: all three commands pass before feature edits. Fix merge resolutions before continuing if they do not.

---

### Task 2: Authorize managers to create payment links

**Files:**

- Modify: src/auth/casl/app-ability.factory.ts
- Test: src/auth/casl/app-ability.spec.ts

**Interfaces:**

- MANAGER can create PaymentLink unconditionally.
- CLIENT, DELIVERY, and anonymous users remain denied.

- [ ] Step 1: Write the failing CASL tests.

Add these assertions to the existing role cases:

~~~typescript
expect(managerAbility.can('create', 'PaymentLink')).toBe(true);
expect(factory.createForUser(client).can('create', 'PaymentLink')).toBe(false);
expect(factory.createForUser(delivery).can('create', 'PaymentLink')).toBe(false);
expect(factory.createForUser(undefined).can('create', 'PaymentLink')).toBe(false);
~~~

- [ ] Step 2: Run the focused test and observe the expected failure.

~~~powershell
npm test -- src/auth/casl/app-ability.spec.ts --runInBand
~~~

Expected: the manager assertion fails because the grant is missing.

- [ ] Step 3: Add the minimum production rule.

Inside the existing MANAGER block add:

~~~typescript
can('create', 'PaymentLink');
~~~

Do not grant update/delete or use can('manage', 'all').

- [ ] Step 4: Run and commit.

~~~powershell
npm test -- src/auth/casl/app-ability.spec.ts --runInBand
git add src/auth/casl/app-ability.factory.ts src/auth/casl/app-ability.spec.ts
git commit -m "fix(auth): authorize managers to create payment links"
~~~

Expected: the focused suite passes.

---

### Task 3: Add catalogue-driven payment-link deactivation

**Files:**

- Modify: src/payments/payment-links/payment-links.module.ts
- Modify: src/payments/payment-links/payment-links.service.ts
- Test: src/payments/payment-links/payment-links.service.spec.ts
- Modify: src/products/products.module.ts and src/products/products.service.ts
- Test: src/products/products.service.spec.ts
- Modify: src/skus/skus.module.ts and src/skus/skus.service.ts
- Test: src/skus/skus.service.spec.ts
- Modify: src/testing/build-service.ts

**Interfaces:**

- PaymentLinksService.deactivateForSku(skuId: string): Promise<void> handles active links for one SKU.
- PaymentLinksService.deactivateForProduct(productId: string): Promise<void> handles active links for all SKUs of one product.
- Stripe false/throw is logged; local rows are still marked inactive and the catalogue request does not reject.
- SKU price changes and positive-to-zero stock transitions call deactivateForSku.
- Product deactivation and soft deletion call deactivateForProduct.

- [ ] Step 1: Extend the unit harness with a PaymentLinksService mock.

In src/testing/build-service.ts, add a deep mock provider for PaymentLinksService, expose it as h.paymentLinks, and keep the target provider last so buildService(PaymentLinksService) still returns the real target.

- [ ] Step 2: Write failing lifecycle tests.

In payment-links.service.spec.ts, configure active rows and assert:

~~~typescript
await harness.service.deactivateForSku('sku-1');
expect(harness.stripe.deactivatePaymentLink).toHaveBeenCalledWith('plink-1');
expect(harness.prisma.paymentLink.updateMany).toHaveBeenCalledWith({
  where: { id: 'link-1', isActive: true },
  data: { isActive: false },
});
~~~

For products, assert the query filter is { sku: { productId: 'product-1' }, isActive: true }. Add cases for no active links and deactivatePaymentLink returning false; both must resolve without throwing.

- [ ] Step 3: Run the focused test and observe red.

~~~powershell
npm test -- src/payments/payment-links/payment-links.service.spec.ts --runInBand
~~~

Expected: the new public methods are missing.

- [ ] Step 4: Implement the lifecycle methods.

Query only active rows with id and stripePaymentLinkId. For every row, call StripeService.deactivatePaymentLink in a try/catch, log false/throw with the payment-link id, then run:

~~~typescript
await this.prisma.paymentLink.updateMany({
  where: { id: link.id, isActive: true },
  data: { isActive: false },
});
~~~

Export PaymentLinksService from PaymentLinksModule.

- [ ] Step 5: Run lifecycle tests to green.

~~~powershell
npm test -- src/payments/payment-links/payment-links.service.spec.ts --runInBand
~~~

- [ ] Step 6: Write failing catalog propagation tests.

Add tests asserting:

~~~typescript
await h.service.update(sku.id, { price: 3000 });
expect(h.paymentLinks.deactivateForSku).toHaveBeenCalledWith(sku.id);

await h.service.update(sku.id, { stock: 0 });
expect(h.paymentLinks.deactivateForSku).toHaveBeenCalledWith(sku.id);
~~~

Also assert that a positive stock update does not call it, and that ProductsService.update with isActive false and ProductsService.remove call deactivateForProduct.

- [ ] Step 7: Run catalog tests and observe red.

~~~powershell
npm test -- src/skus/skus.service.spec.ts src/products/products.service.spec.ts --runInBand
~~~

Expected: constructors or methods do not yet inject or call PaymentLinksService.

- [ ] Step 8: Wire modules and calls.

Import PaymentLinksModule in ProductsModule and SkusModule, inject PaymentLinksService into both services, and do not make PaymentLinksModule import either catalog module.

In SkusService.update, after the write transaction:

~~~typescript
const priceChanged = dto.price !== undefined && dto.price !== sku.price;
const soldOut = dto.stock !== undefined && sku.stock > 0 && dto.stock === 0;
if (priceChanged || soldOut) await this.paymentLinks.deactivateForSku(skuId);
~~~

In ProductsService.update, call deactivateForProduct after a successful write when the prior product was active and dto.isActive is false. In remove, call it after the soft-delete write.

- [ ] Step 9: Run catalog tests to green and commit.

~~~powershell
npm test -- src/skus/skus.service.spec.ts src/products/products.service.spec.ts --runInBand
git add src/payments/payment-links/payment-links.module.ts src/payments/payment-links/payment-links.service.ts src/payments/payment-links/payment-links.service.spec.ts src/products/products.module.ts src/products/products.service.ts src/products/products.service.spec.ts src/skus/skus.module.ts src/skus/skus.service.ts src/skus/skus.service.spec.ts src/testing/build-service.ts
git commit -m "feat(payments): deactivate stale payment links with catalogue changes"
~~~

---

### Task 4: Extend the Stripe settlement job contract and retrieval seam

**Files:**

- Modify: src/payments/stripe.service.ts and src/payments/stripe.service.spec.ts
- Modify: src/payments/webhooks/settlement.jobs.ts
- Create or modify: src/payments/webhooks/settlement.jobs.spec.ts
- Test: src/payments/webhooks/stripe-webhook.service.spec.ts

**Interfaces:**

- StripeService.retrieveEvent(stripeEventId: string): Promise<Stripe.Event> retrieves the event for the worker.
- SettlementJobData is a discriminated union: payment-intent jobs carry paymentIntentId and orderId; checkout-session jobs carry checkoutSessionId.
- settlementJobFor recognizes checkout.session.completed and checkout.session.async_payment_succeeded.

- [ ] Step 1: Write the failing Stripe retrieval test.

Extend the Stripe SDK double with events.retrieve, then add:

~~~typescript
it('retrieves a recorded event by its Stripe id for worker settlement', async () => {
  const service = makeService();
  const event = { id: 'evt_checkout' } as Stripe.Event;
  events.retrieve.mockResolvedValue(event);

  await expect(service.retrieveEvent(event.id)).resolves.toBe(event);
  expect(events.retrieve).toHaveBeenCalledWith(event.id);
});
~~~

- [ ] Step 2: Run the test and observe red.

~~~powershell
npm test -- src/payments/stripe.service.spec.ts --runInBand
~~~

Expected: retrieveEvent is not defined.

- [ ] Step 3: Add the retrieval seam.

~~~typescript
async retrieveEvent(stripeEventId: string): Promise<Stripe.Event> {
  return this.client.events.retrieve(stripeEventId);
}
~~~

Add events.retrieve to the mocked Stripe client.

- [ ] Step 4: Write and run failing settlement-job tests.

For a checkout.session.completed event with object id cs_123, assert exact output:

~~~typescript
{
  webhookEventId: 'webhook-row',
  stripeEventId: 'evt_checkout',
  eventType: SettlementEventType.CheckoutSessionCompleted,
  checkoutSessionId: 'cs_123',
}
~~~

Repeat for checkout.session.async_payment_succeeded. Assert that paymentIntentId and orderId are absent.

~~~powershell
npm test -- src/payments/webhooks/settlement.jobs.spec.ts --runInBand
~~~

Expected: the current enum and payload builder reject or omit checkout-session events.

- [ ] Step 5: Implement the discriminated payload.

Add CheckoutSessionCompleted and CheckoutSessionAsyncPaymentSucceeded to SettlementEventType. Define SettlementJobData as a union of the existing payment-intent shape and checkout-session shape. Branch in settlementJobFor before reading PaymentIntent metadata; preserve current orderId validation for payment-intent events.

- [ ] Step 6: Update producer tests and run them.

The existing test that expects checkout.session.completed to be recorded without a job must now assert one settle-payment job with the checkout-session payload while retaining the exact allowlisted database payload.

~~~powershell
npm test -- src/payments/webhooks/settlement.jobs.spec.ts src/payments/webhooks/stripe-webhook.service.spec.ts --runInBand
~~~

- [ ] Step 7: Commit the producer contract.

~~~powershell
git add src/payments/stripe.service.ts src/payments/stripe.service.spec.ts src/payments/webhooks/settlement.jobs.ts src/payments/webhooks/settlement.jobs.spec.ts src/payments/webhooks/stripe-webhook.service.spec.ts
git commit -m "feat(payments): enqueue checkout session settlement jobs"
~~~

---

### Task 5: Dispatch checkout-session jobs in the worker

**Files:**

- Modify: src/payments/webhooks/settlement.service.ts and its spec
- Modify: src/queue/processors/settlement.processor.ts and its spec
- Modify: src/worker.module.ts
- Modify: src/payments/payment-links/payment-links.module.ts

**Interfaces:**

- SettlementService.settle retrieves a checkout event by stripeEventId, calls PaymentLinkCheckoutService.settleCheckoutSession, marks the webhook row processed, and returns SettlementOutcome.PaymentLinkSettled or SettlementOutcome.Ignored.
- Payment-intent jobs continue through existing pay and refund branches.
- Failure logs identify orderId or checkoutSessionId.

- [ ] Step 1: Write failing worker-dispatch tests.

Inject a PaymentLinkCheckoutService double into settlement.service.spec.ts and add a checkout job case asserting:

~~~typescript
h.stripe.retrieveEvent.mockResolvedValue(event);
checkout.settleCheckoutSession.mockResolvedValue({
  orderId: 'order-1',
  paymentId: 'payment-1',
  status: OrderStatus.PAID,
});

await expect(service.settle(checkoutJob, now)).resolves.toBe(
  SettlementOutcome.PaymentLinkSettled,
);
expect(h.stripe.retrieveEvent).toHaveBeenCalledWith('evt_checkout');
expect(checkout.settleCheckoutSession).toHaveBeenCalledWith(event);
expect(h.prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
  where: { id: checkoutJob.webhookEventId, processedAt: null },
  data: { processedAt: now },
});
~~~

Add a null-handler case returning Ignored and marking the event processed, plus a retrieval failure case that rejects.

- [ ] Step 2: Run the focused test and observe red.

~~~powershell
npm test -- src/payments/webhooks/settlement.service.spec.ts --runInBand
~~~

Expected: checkout jobs currently fall into the old ignored branch without retrieving Stripe or calling the link handler.

- [ ] Step 3: Implement the dispatch branch.

Inject PaymentLinkCheckoutService. Before the existing payment-intent branch, retrieve the event, call settleCheckoutSession, mark the webhook row processed, and return PaymentLinkSettled when a settlement is returned or Ignored when null. Do not call pay, refund, recordCharge, or consumeReservations for a checkout-session job.

- [ ] Step 4: Update processor logging with a failing test.

Add a checkout job to settlement.processor.spec.ts and assert the failure log contains the Stripe event id and checkoutSessionId rather than undefined for the absent orderId. Then change the log target to:

~~~typescript
job.data.orderId ?? job.data.checkoutSessionId ?? 'unknown-target'
~~~

Run:

~~~powershell
npm test -- src/payments/webhooks/settlement.service.spec.ts src/queue/processors/settlement.processor.spec.ts --runInBand
~~~

- [ ] Step 5: Wire and compile the worker.

Add PaymentLinksModule to WorkerModule.imports and export PaymentLinkCheckoutService plus PaymentLinksService from PaymentLinksModule. Keep StripeWebhookModule producer-only and keep processors out of AppModule.

~~~powershell
npm run typecheck
npm run build
~~~

- [ ] Step 6: Commit the worker dispatch.

~~~powershell
git add src/payments/webhooks/settlement.service.ts src/payments/webhooks/settlement.service.spec.ts src/queue/processors/settlement.processor.ts src/queue/processors/settlement.processor.spec.ts src/worker.module.ts src/payments/payment-links/payment-links.module.ts
git commit -m "feat(payments): settle checkout sessions in the worker"
~~~

---

### Task 6: Add end-to-end payment-link and webhook coverage

**Files:**

- Modify: test/support/stripe-stub.ts
- Create: test/payment-links.e2e-spec.ts
- Modify only if required by reset behavior: test/support/database.ts

**Interfaces:**

- The Stripe stub records payment-link creation/deactivation, returns configured webhook events, and retrieves events by Stripe id.
- The suite uses the real API module, worker module, Prisma database, BullMQ queue, and no Stripe network.

- [ ] Step 1: Extend the Stripe stub.

Add deterministic createPaymentLink, deactivatePaymentLink, constructWebhookEvent, retrieveEvent, setWebhookEvent, and reset behavior. A created link id must derive from requestId. Reset must clear links, deactivation records, and event storage.

- [ ] Step 2: Add manager creation and denial tests.

Create test/payment-links.e2e-spec.ts using createE2eApp, signUpVerified, promoteToManager, and signIn. Seed an active product and SKU with stock 1, reserved 0, and price 12500 through Prisma. Assert manager POST /api/v1/payment-links returns 201, includes the SKU and unitPriceAtCreation, and creates one active PaymentLink row.

Add a client test asserting 403 and no Stripe link creation.

- [ ] Step 3: Run the focused e2e file and observe red.

With Compose services running and DATABASE_URL available:

~~~powershell
npm run prisma:sync
npm run test:e2e -- --runInBand test/payment-links.e2e-spec.ts
~~~

Expected: the new flow fails at the first missing stub or settlement integration.

- [ ] Step 4: Add the checkout-session worker scenario.

Configure a paid checkout.session.completed event with id cs_e2e_1, the created Stripe payment-link id, amount_total 12500, currency usd, guest email, and a complete shipping address. Register the event as evt_checkout_e2e in the stub, POST /api/v1/webhooks/stripe with Stripe-Signature, and assert HTTP 200 with { received: true }.

Poll Payment by stripeCheckoutSessionId until the worker writes it, then assert PAYMENT_LINK, SUCCEEDED, a GUEST user, a PAID order, and SKU stock zero.

- [ ] Step 5: Prove redelivery idempotency.

POST the same event after webhookEvent.processedAt is set. Assert HTTP 200, one payment for the session, one order for that payment, and one guest user.

- [ ] Step 6: Run and commit e2e coverage.

~~~powershell
npm run test:e2e -- --runInBand test/payment-links.e2e-spec.ts
git add test/support/stripe-stub.ts test/payment-links.e2e-spec.ts test/support/database.ts
git commit -m "test(e2e): cover payment link authorization and settlement"
~~~

---

### Task 7: Full verification, main refresh, and publication

**Files:**

- Verify all tracked files in feat/payment-links.

- [ ] Step 1: Run formatting, static checks, unit tests, and build.

~~~powershell
npm run format:check
npm run typecheck
npm run lint:ci
npm run build
npm test -- --runInBand
~~~

Expected: all existing and new tests pass with the coverage floor intact.

- [ ] Step 2: Synchronize schema and run the complete e2e suite.

~~~powershell
npm run prisma:sync
npm run test:e2e -- --runInBand
~~~

Expected: schema is converged or only the intended payment-link/webhook changes are applied. Zero backfilled users/tokens is valid for an empty local database.

- [ ] Step 3: Refresh from main if new commits landed.

~~~powershell
git fetch origin
git merge --no-ff origin/main -m "merge: refresh payment links with main"
~~~

If there is a conflict, reuse Task 1 ownership rules and rerun typecheck, unit, and e2e tests after resolution.

- [ ] Step 4: Inspect the final branch.

~~~powershell
git diff --check
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
git log --oneline --decorate --max-count=12
~~~

Expected: no uncommitted changes, HEAD is not behind origin/main, and the log contains authorization, lifecycle, settlement, and e2e commits.

- [ ] Step 5: Publish the verified branch.

~~~powershell
git push origin HEAD:feat/payment-links
~~~

Expected: origin/feat/payment-links points to the verified branch tip.
