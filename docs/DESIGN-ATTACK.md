# Design attack

A cross-check of `W2-API/openapi.yaml` (1.0.0, 30 routes and 38 operations) against
`BE-Nerdery-Challenges/4-database/3-tshirt-store-erd/ERD.dbml` (21 tables) against what NestJS 11
and Prisma 6 can actually execute.

**What this is.** Ammunition for the System Design Review. Each finding carries the failure, how to
reproduce it, the ways out with their cost, and a recommendation with **the condition under which it
would change** — the part the program actually asks for, and the only part that makes the
recommendation defensible.

**How to read the recommendations.** They are an opinion, not an answer. The SDR is an individual
exercise and what it evaluates is the reasoning, so the question you need to be able to answer isn't
_which one did you pick_ but _why that one and not the other_. A recommendation whose change
condition doesn't convince you is one to argue with, not follow.

**What this is not.** It is not the System Design Review page, nor a list of improvements. A finding
only earns a place here if you can name the file, the line, or the ERD note where it lives, and
describe the concrete sequence that triggers it.

---

## Index

| #   | Finding                                                            | SDR question |
| --- | ------------------------------------------------------------------ | ------------ |
| 1   | `webhook_events` can lose a payment forever                        | Q3           |
| 2   | Webhook deduplication isn't atomic                                 | Q3           |
| 3   | The queue and the database don't share a transaction               | Q1 Q3        |
| 4   | There's no outbound idempotency key                                | Q3           |
| 5   | The reservation sweep doesn't exist in any diagram                 | Q1 Q3        |
| 6   | Stripe doesn't always allow cancelling the Payment Intent          | Q3           |
| 7   | The refund has a check-then-act                                    | Q3           |
| 8   | A cart reservation can reject a Payment Link sale                  | Q3           |
| 9   | `PATCH /skus` calls Stripe inside a manager request                | Q3           |
| 10  | Whether the checkout transaction wraps the Stripe call             | Q3           |
| 11  | F8 has an uncollapsed fan-out                                      | Q1           |
| 12  | Nobody increments `restock_cycle`                                  | Q1           |
| 13  | "when stock reaches 3" admits two readings                         | Q1           |
| 14  | "haven't bought yet" isn't defined                                 | Q1           |
| 15  | The email carries the image, and the image is an S3 key            | Q1           |
| 16  | There are four background jobs, not one                            | Q1 Q2        |
| 17  | The guest order link is also sent by email                         | Q1           |
| 18  | What happens to a job that fails twice                             | Q1           |
| 19  | `POST /auth/sign-up` is an enumeration oracle                      | Q4           |
| 20  | `GET /guest-orders/{orderId}` is unauthenticated, unrated BOLA     | Q4           |
| 21  | `cartItemId` is a bare UUID in the route                           | Q4           |
| 22  | `/auth/sign-in` doesn't declare 429                                | Q4           |
| 23  | The "404 not 403" rule clashes with how CASL throws                | Q4           |
| 24  | `WWW-Authenticate` and log redaction are declared and don't exist  | Q4 Q5        |
| 25  | `GET /products` orders by a column that isn't unique               | contract     |
| 26  | Dead end in email verification                                     | contract     |
| 27  | The guest order on an already-registered email is born dead        | contract     |
| 28  | `anyOf` stops the contract from catching a projection regression   | Q5           |
| 29  | No error meets the contract today                                  | Q5           |
| 30  | `priceFrom` and `inStock` are aggregates Prisma can't express      | Q2           |
| 31  | The model's guarantees only exist if the migration is hand-written | Q2 Q5        |
| 32  | `CREATE INDEX CONCURRENTLY` doesn't run inside a transaction       | Q2           |
| 33  | Prisma has no down migrations                                      | Q2           |
| 34  | The connection pool the SDR asks you to diagram                    | Q2           |
| 35  | `forbidNonWhitelisted` on query params                             | Q5           |

**Status by question.** Q3 is the only one the W2 work actually answers, and even so the ten
findings in section A belong to it. Q1 has the queue chosen and nothing else. Q4 has the webhook
replay solved and the other two risks unnamed. Q2 and Q5 are blank.

**One principle runs through six of these findings, and it's worth saying once instead of six
times.** Faced with two possible failures, pick the reversible one. Stock held a little too long
recovers on the next sweep; a unit sold twice doesn't. A refund can be explained; an order nobody
can fulfill can't. That's what decides the sweep's ordering (5), what to do when Stripe rejects the
`cancel` (6), what condition the Payment Link settlement uses (8), and why a price change fails
whole rather than half-applying (9).

---

# A. The seam between money and stock

> _"Where's the seam that would leave money and stock disagreeing, and what makes a retry safe
> there?"_

## 1. `webhook_events` can lose a payment forever

**What fails.** The 200 from `/webhooks/stripe` promises that the event _"is recorded and will be
applied"_ (`openapi.yaml:1015`). Settlement happens after the acknowledgment, by explicit decision:
_"verify, record the payment, and respond."_ If deduplication works by row existence, a process
that dies between the `INSERT` and the settlement leaves a row that Stripe's retry recognizes as a
duplicate, gets a 200 back, and nothing ever gets applied. The order stays PENDING, the customer
paid, and the expiration sweep ends up marking it FAILED.

`processed_at` exists precisely to distinguish _recorded_ from _applied_ (`ERD.dbml:359`). Nothing
reads it.

**How to reproduce it.** Kill the process right after the `INSERT` into `webhook_events` commits and
before the write to `payments`. Resend the same event with `stripe trigger` or from the dashboard.
The second delivery responds 200 and the order stays PENDING.

**Ways out.**

| Way out                                                                        | Cost                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Short-circuit only when `processed_at IS NOT NULL`, and reprocess if it's null | The retry has to be idempotent downstream, which is exactly what finding 4 already requires           |
| Periodic sweep of `processed_at IS NULL` past a minimum age                    | One more background job, and a window between the failure and the sweep where the order lies          |
| Settle inside the request, before responding                                   | Puts Stripe's latency back on the request path and contradicts the decision the contract already made |

**Recommendation.** Short-circuit only when `processed_at IS NOT NULL`, **and** keep the sweep as a
safety net. The first alone isn't enough: if the process dies and Stripe exhausts its three days of
retries, nobody looks at that row again. **Would change if** settlement stopped making outbound
calls — then doing it inside the request removes the whole failure class instead of just covering
it.

## 2. Webhook deduplication isn't atomic

**What fails.** A `SELECT` followed by an `INSERT` doesn't deduplicate two concurrent deliveries:
both see an empty table. Stripe delivers in parallel, not serially.

**How to reproduce it.** Two simultaneous requests with the same `stripe_event_id`. With `SELECT`
then `INSERT`, one of the two collides with the unique constraint and returns 500, which Stripe
retries; with bad luck both reach settlement before either confirms.

**Ways out.** The only approach that holds up is having the database's unique constraint do the
mutual exclusion: `INSERT ... ON CONFLICT (stripe_event_id) DO NOTHING`, settling only if the
inserted row is ours. Prisma expresses this by catching `P2002`, or with `$executeRaw`. The
alternative, a distributed lock in Redis, puts Redis on the path of payment correctness, exactly
where it shouldn't be.

**Recommendation.** `INSERT ... ON CONFLICT (stripe_event_id) DO NOTHING`, settling only if the
inserted row is ours. The database's unique constraint has to provide the mutual exclusion. **Would
change if** there were a single instance consuming with concurrency 1, but that turns a correctness
guarantee into a config setting anyone could bump without noticing.

## 3. The queue and the database don't share a transaction

**What fails.** The `webhook_events` `INSERT` is Postgres and the BullMQ `enqueue` is Redis. No
transaction spans both. A failure between the two loses the job with the row already written —
finding 1 again, now with the queue in the mix. It's the _transactional outbox_ problem, and it
shows up the same way in the password-change email, the verification email, and F8.

**How to reproduce it.** Stop Redis and run a checkout. The Postgres write commits and the `enqueue`
throws; Prisma's rollback can't undo what's already written to Redis.

**Ways out.**

| Way out                                                                                | Cost                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A real outbox: a table of pending jobs in Postgres and a drainer that reads it         | Another table and another process; in exchange, `webhook_events.processed_at` is already half an outbox |
| Commit to Postgres first, enqueue after, and cover the loss with a sweep               | An inconsistency window equal to the sweep's period                                                     |
| Don't queue settlement at all — make it synchronous, and use the queue only for emails | The queue becomes exactly what the brief asked for and nothing more, and Q1 turns into a short answer   |

**Recommendation.** Commit to Postgres, enqueue after, and cover the loss with finding 1's sweep,
which already exists. A dedicated outbox table is more weight than a one-page write-up can carry
when `webhook_events.processed_at` is already half an outbox. **Would change if** a third queue
showed up with a real exactly-once delivery requirement: with three, the outbox stops being
duplication.

## 4. There's no outbound idempotency key

**What fails.** **Inbound** idempotency is solved with `stripe_event_id`. **Outbound** idempotency
isn't solved anywhere. `paymentIntents.create` and `refunds.create` without an `Idempotency-Key`
header create a new object on every retry, and a network timeout doesn't say whether the operation
happened.

It's the exact mirror of the problem already solved in the other direction.

**How to reproduce it.** Cut the network right after `POST /v1/payment_intents` goes out. The client
retries, or the user retries checkout. Two Payment Intents end up against one order that's
constrained by `uq_payments_order_succeeded_partial`, which only allows one to settle: the second
payment that lands gets refunded, and the customer sees two charges on their statement before the
refund shows up.

**Ways out.** The key has to be deterministic and derived from the attempt, not random: the order's
`id` for the Payment Intent, the payment's `id` for the refund. Check Stripe's reference for how
long it retains keys before claiming a late retry is still protected.

**Recommendation.** A deterministic key derived from the attempt: the order's `id` for the Payment
Intent, the payment's `id` for the refund. This isn't a choice, it's what's missing.

**With a limit worth knowing how to state.** Stripe _"prunes keys after they're at least 24 hours
old"_ ([reference](https://docs.stripe.com/api/request_ids)). Since webhook retries run for up to
three days, **there's a two-day window where a late retry is no longer protected by the key**.
There, the real protection comes from `uq_payments_order_succeeded_partial` — one settled payment
per order — and that's why finding 31 isn't a migration detail.

## 5. The reservation sweep doesn't exist in any diagram

**What fails.** `orders.expires_at`, the partial index `idx_orders_pending_expires_partial`, and the
`FAILED` status together describe a periodic job nobody has declared. The contract also adds an
outbound call to it: the `clientSecret` says that _"cancelling the order or letting the reservation
expire also cancels the Payment Intent"_ (`openapi.yaml:1969`).

A scheduled job that releases stock, releases a coupon use, writes status history, and calls Stripe
— and nobody has said how often it runs or what happens if two instances run it at once.

**How to reproduce it.** Deploy two API instances with the cron running in-process. Both sweep the
same row.

**Ways out, and the ordering that matters.** Releasing the stock before cancelling the Payment
Intent opens a window where the customer can still pay for something already sold to someone else.
Cancelling first and having the write fail leaves the stock held forever. Neither order is correct
on its own: the effect needs to be idempotent and the sweep needs to be safely repeatable, the same
property as finding 1.

On where it runs: an in-process cron duplicates the job the moment there's more than one instance; a
BullMQ _repeatable job_ centralizes it in Redis; a dedicated container keeps it off the request path
at the cost of one more piece in the Q2 diagram.

**Recommendation.** A BullMQ _repeatable job_, not an in-process cron, because the cron duplicates
as soon as there are two instances. And the order: **cancel in Stripe first, release the stock
after.** The reasoning is the header's principle: if it fails after cancelling, the stock stays held
and the next pass recovers it; if it fails after releasing, someone pays for something already sold,
and that doesn't undo. **Would change if** the sweep had an exactly-once execution guarantee, which
it doesn't.

## 6. Stripe doesn't always allow cancelling the Payment Intent

**What fails.** The sweep assumes it can cancel. Stripe's reference
(`POST /v1/payment_intents/:id/cancel`) allows cancellation from `requires_payment_method`,
`requires_confirmation`, `requires_action`, `requires_capture`, and `processing`, and adds two
limits:

- **A Payment Intent attached to a Checkout Session can only be cancelled from
  `requires_capture`; in any other state you have to expire the session instead.**
- Some `processing` states don't allow cancellation, like the pre-debit notification window.

**Why the design survives, and it's worth knowing how to say so.** Payment Link orders are born
already settled and have `expires_at` null (`ERD.dbml:294`), so the sweep never touches them and
never runs into a Checkout Session. It's a lucky consequence of a decision made for another reason,
not a precaution.

**What's still open.** What the sweep does when `cancel` errors because the customer is confirming
payment at that exact moment. Retry later, release the stock anyway, or leave the order PENDING past
its expiration are three different answers with three different consequences.

**Recommendation.** Retry on the next pass, without releasing the stock. Same principle: an order
that stays PENDING past its time is a visible, reversible problem; releasing the unit while the
customer is mid-confirmation is not. **Would change if** the holding period started costing real
sales — then the answer isn't to release earlier, it's to shorten `expires_at`.

## 7. The refund has a check-then-act

**What fails.** _"A refund already recorded against a payment isn't issued twice"_
(`openapi.yaml:1020`). The mechanism is `payments.stripe_refund_id` and `refunded_at`. Reading that
it's null and then writing it isn't atomic across two concurrent deliveries.

**How to reproduce it.** Two deliveries of the same settlement event on an already-cancelled order,
processed at the same time. Both read `stripe_refund_id IS NULL` and both refund.

**Ways out.** `SELECT ... FOR UPDATE` on the `payments` row, or an `UPDATE ... WHERE
stripe_refund_id IS NULL` that only lets through the one that actually affected a row. Finding 4's
idempotency key covers this from the other side too, and the two together are belt and suspenders.

**Recommendation.** `UPDATE payments SET stripe_refund_id = ... WHERE id = ? AND stripe_refund_id
IS NULL`, proceeding only if it affected one row. Preferable to `FOR UPDATE` because it doesn't hold
a lock open while talking to Stripe. **Would change if** more than one write around the refund
needed to be atomic together, in which case the explicit lock is the right call.

## 8. A cart reservation can reject a Payment Link sale

**What fails.** A Payment Link purchase _doesn't reserve stock_ (`ERD.dbml:350`), and settlement
can't leave stock negative. The condition is then either `stock - reserved >= 1` or `stock >= 1`,
and both hurt:

- `stock - reserved >= 1` refunds a healthy sale because another customer has an open checkout that
  could still expire without paying.
- `stock >= 1` oversells: whoever reserved first reaches payment and there's no unit left.

The contract implicitly picks the first, by saying the duplicate sale _"gets recorded, refunded, and
its order ends CANCELLED"_, without saying it's making a choice.

**How to reproduce it.** A SKU with `stock = 1`. One customer starts checkout and leaves the order
PENDING. Another pays through the link. The second one paid and gets refunded, and the first can end
up never paying at all.

**Ways out.** Accept the refund and state it; or have the link reserve too, which contradicts
`ERD.dbml:350` and forces expiring reservations for buyers without accounts; or close the link when
_available_ hits zero instead of when _stock_ hits zero, which shrinks the window without closing
it.

**Recommendation.** `stock - reserved >= 1`, which is what the contract already picks — **and say so
explicitly**. A refund is reversible and overselling isn't. **Would change if** the reservation
window dropped from hours to minutes: with short reservations, the risk of rejecting a healthy sale
grows and the risk of overselling nearly disappears.

## 9. `PATCH /skus` calls Stripe inside a manager request

**What fails.** Changing the price _"deactivates this SKU's active Payment Link"_
(`openapi.yaml:604`). That's an outbound call to Stripe inside a synchronous manager request. What
happens if Stripe doesn't respond isn't declared.

**How to reproduce it.** Cut outbound access to `api.stripe.com` and change the price of a SKU with
an active link.

**Ways out.** Failing the whole request leaves the price unchanged and is honest, at the cost of a
Stripe outage blocking catalog management. Changing the price and queueing the deactivation leaves a
window where the live link sells at the old price, backstopped by `unit_price_at_creation`'s
guarantee that the advertised price is at least honored. Changing the price and ignoring the failure
is what happens today if nobody decides.

**Recommendation.** Fail the whole request. It's the only way out that doesn't leave the system
lying, and having a Stripe outage block a price change is tolerable in a store whose checkout
depends on Stripe anyway. **Would change if** the catalog needed to stay editable while the payment
provider is down — then the way out is to queue the deactivation, leaning on `unit_price_at_creation`,
which already guarantees the advertised price is honored.

## 10. Whether the checkout transaction wraps the Stripe call

**What fails.** Checkout reserves stock across N lines, reserves a coupon use, creates the order,
its lines and status history, creates the Payment Intent, and returns the `clientSecret`. Where the
transaction boundary falls decides what breaks.

**Inside.** Row locks on N SKUs stay held across a network call. Under load that serializes every
checkout touching a popular SKU, and Prisma's two `$transaction` defaults work against it: a
**5000 ms** `timeout` for the whole transaction, and a **2000 ms** `maxWait` just to get a slot from
the pool. Under contention, the second one times out before the first, and the error the user sees
doesn't even mention Stripe.

**Outside.** The commit lands and Stripe gets called afterward. A process failure in between leaves
an order PENDING with stock held and no way to pay for it, recoverable only by finding 5's sweep.

**How to reproduce it.** With Stripe responding slowly, start twenty checkouts on the same SKU and
measure how many end in a transaction timeout.

**Ways out.** Reserve and commit, call Stripe afterward with finding 4's idempotency key, and lean
on the sweep as a safety net. The alternative, creating the Payment Intent before reserving, swaps
the failure for its mirror: orphaned intents with no order.

**Recommendation.** Reserve and commit, call Stripe outside the transaction with finding 4's
idempotency key, and finding 5's sweep as a safety net. A row lock held across a network call is the
kind of failure that only shows up under load, which is exactly when it's hardest to diagnose.
**Would change if** volume were low enough that contention never happened — but then the difference
doesn't cost anything either, so it's not worth the risk.

---

# B. What comes off the request path

> _"What work gets queued, what's synchronous, and why. What happens to a job that fails twice?"_

## 11. F8 has an uncollapsed fan-out

**What fails.** The like is per **product** (`uq_product_likes_user_product`) and the notification
is per **SKU** (`uq_stock_notifications_user_sku_cycle`, `ERD.dbml:423`). Nothing collapses the
fan-out between the two. A product with 6 sizes and 8 colors has up to 48 variants, and a restock
that touches all of them generates up to 48 emails to the same user for one product they liked once.

**How to reproduce it.** A user likes a product with six variants. The manager restocks all six. The
query joining likes with `skus` returns six rows for that user.

**Ways out.** Group by product before queuing and send one email listing the available variants; or
change `stock_notifications`'s unique key to `(user_id, product_id, cycle)`, which forces redefining
what a cycle is when the cycle currently lives on the SKU; or notify only for the first variant that
crosses the threshold. All three touch the ERD, which makes this week's decision, not next week's.

**Recommendation.** Group by product **in the job**, before queuing the email, and leave
`stock_notifications` per-SKU as it is: the row stays the exact record of which variant was
notified, and the email goes out once per product per cycle. It doesn't touch the ERD, which is what
makes it preferable to the other two. **Would change if** the email had to say _your size M is back_
instead of _this product is back_, in which case the per-SKU fan-out stops being a defect and
becomes the feature.

## 12. Nobody increments `restock_cycle`

**What fails.** `skus.restock_cycle` exists, `stock_notifications`'s unique constraint uses it as
its third column, and **no operation in the contract writes it**. `PATCH /skus` updates price,
stock, and image (`openapi.yaml:597`) and never mentions the cycle. Without the rule that increments
it, the unique constraint permanently blocks a second notification to the same user for the same
SKU: it fires once in the product's whole lifetime.

**How to reproduce it.** Restock a SKU, get the email, sell it out completely, restock it again.
Nothing arrives.

**Ways out.** The missing rule is one sentence, and it has to be chosen: increment when stock
crosses the threshold upward from below; increment when it hits zero and then rises; increment on
every update that raises stock. The third over-notifies, the second misses a partial restock, and
the first needs the prior value inside the same transaction.

**Recommendation.** Increment when stock crosses the threshold upward from below. It's the only one
of the three that makes the word _cycle_ mean anything. The prior value is available in the same
transaction with `RETURNING`, so no extra read is needed. **Would change if** the threshold became
configurable per product — then the cycle has to record which threshold was crossed.

## 13. "when stock reaches 3" admits two readings

**What fails.** The brief says _"when a product's stock reaches 3, notify the users who liked it but
haven't bought it yet."_ It reads two ways:

- **Scarcity.** Stock falls to 3 through sales. The email says _only a few left_. This reading fits
  the sentence better, since notifying non-buyers makes sense as a nudge.
- **Restock.** Stock rises to 3 or more. The email says _it's back_. This is the reading the model
  already picked: `restock_cycle` only makes sense for restocks, and the `product_images` note talks
  about the _"restock email"_ (`ERD.dbml:210`).

**Why it matters.** It isn't a wording detail. Under the scarcity reading, the trigger sits at
payment settlement, inside the webhook path. Under the restock reading, it sits in `PATCH /skus`,
inside a manager request. They're two different places on the Q1 diagram.

**Ways out.** Either reading is defensible. What isn't: the ERD having picked one without being able
to say why.

**Recommendation.** Restock, which is what the ERD already picked. Switching to the scarcity reading
now costs rebuilding `restock_cycle`, and the brief's wording isn't strong enough to justify that.
**And this is the part to defend:** not the reading itself, but that the ambiguity was noticed and
one was chosen. **Would change if** the mentor reads the sentence as scarcity — then the trigger
moves from the `PATCH` to the webhook.

## 14. "haven't bought yet" isn't defined

**What fails.** The query needs _liked product P and has no order line for any variant of P_, and
it's missing which statuses count as a purchase. Does a CANCELLED order disqualify? A FAILED one
from an expired reservation? A PENDING one that was never paid?

**How to reproduce it.** A user with a like and a FAILED order for the same product. Depending on
the definition, they do or don't get the email, and today the answer depends on whoever wrote the
`where`.

**Ways out.** Counting only PAID and later is the narrowest and the easiest to explain. Counting any
non-FAILED order avoids re-pitching someone who cancelled. The difference only shows up with real
data, so it's worth writing the decision down before the `where` sets it by accident.

**Recommendation.** Count PAID and everything after it, including CANCELLED, as a purchase. It's the
narrowest and fits in one sentence: _if they ever got as far as paying, don't nag them._ **Would
change if** the email's goal shifted to recovering abandoned carts — then PENDING and FAILED stop
disqualifying too, and the email changes purpose.

## 15. The email carries the image, and the image is an S3 key

**What fails.** The brief requires _"including the product image in the email."_
`product_images.s3_key` stores the key, not a URL (`ERD.dbml:207`). An email gets read weeks after
it's sent.

**Ways out.** A presigned URL expires, and nobody controls when an email expires. A public bucket or
prefix contradicts keeping the rest private. Attaching the image bloats the email and trips spam
filters. A CDN in front is the serious answer, and adds one more piece to the Q2 diagram.

**The numbers, verified.** The maximum lifetime of a SigV4 presigned URL is **7 days**, and only via
SDK or CLI — 12 hours through the console. And there's a trap that decides the answer: **if the URL
is signed with temporary credentials, it expires when the credential expires**, no matter what
lifetime was requested
([AWS docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)). An IAM
role on a container hands out credentials good for hours, not days.

**Recommendation.** With long-lived IAM user credentials, sign for 7 days and accept that an older
email loses its image. **But if the deployment uses a role**, which is normal on any container
platform, the 7 days is fiction and the only honest answer is a CDN in front of S3 with a stable URL.
**Would change if** the extra-credit deployment to the cloud is attempted, because that's exactly the
second case: the IAM role comes with the platform.

## 16. There are four background jobs, not one

**What fails.** The brief names one, F8's email, and the design already implies three more:

| Job                                         | Where it comes from                                                   | Status                       |
| ------------------------------------------- | --------------------------------------------------------------------- | ---------------------------- |
| F8 restock email                            | Brief, feature 8                                                      | Named, undesigned            |
| Expired reservation sweep                   | `orders.expires_at` + `idx_orders_pending_expires_partial` + `FAILED` | Unnamed                      |
| `webhook_events` drain for unapplied events | Nullable `processed_at`, finding 1                                    | Unnamed                      |
| `webhook_events` purge and redaction        | ERD note, section 8 (`ERD.dbml:362`)                                  | Promised in the ERD, unnamed |

On top of those come verification emails, password-reset emails, password-change emails, and the
guest order link.

**Why it matters.** _"One page, and if it doesn't fit, you don't have a design."_ Four periodic jobs
that don't fit on the page are four that need merging, delegating, or justifying one by one.

**Recommendation.** Merge the three periodic ones into **a single sweeper with three passes**, and
leave F8 as its own queue. The diagram goes from four boxes to two, which is what makes it fit.
**Would change if** one pass needed a very different frequency: the `webhook_events` purge is daily
and the reservation sweep runs in minutes, so they might end up as two after all.

## 17. The guest order link is also sent by email

**What fails.** `GET /guest-orders/{orderId}` only works if the buyer receives the URL, and the only
place it can come from is an email sent from the webhook. That send doesn't appear in any decision.

**Consequence.** The email depends on `customer_details` from the Stripe event, which is exactly one
of the fields the `webhook_events` note marks for redaction. Redacting it before sending leaves the
buyer without a link.

**Recommendation.** Send the email from the same job that creates the order, reading the address off
the event **before** redacting the payload. It isn't a real conflict, it's an ordering one:
`webhook_events.payload` redaction happens after the data is used, not before. Writing it that way
avoids discovering the problem once redaction gets implemented.

## 18. What happens to a job that fails twice

**What fails.** The question is bolded in the program's brief and today has no answer. BullMQ ships
retries with backoff and a failed-jobs queue, and nothing says how many attempts, what spacing, or
what happens to the one that dies.

**Why it isn't the same for every queue.** A restock email that gets lost is a lost sale. A payment
settlement that gets lost is money charged with no order behind it. They can't share a policy, and
today they share the absence of one.

**Recommendation.** Two policies, because the two failures don't cost the same. Emails: three
attempts with exponential backoff, and the one that dies goes to the failed-jobs queue with an error
log. Payment settlement: it shouldn't be queued at all, and if it is, indefinite retries with backoff
and an alert, because losing it means losing money already charged. **Would change if** finding 1's
synchronous settlement gets adopted — then there's only one policy left, and the answer to this
question shrinks to one line.

---

# C. This API's security risks

> _"Your top three from OWASP, specific to this API, not generic ones. The webhook replay is a good
> place to start."_

The replay is already solved with `webhook_events.stripe_event_id`. Two are missing, and there are
four candidates.

## 19. `POST /auth/sign-up` is an enumeration oracle

**What fails.** `forgot-password` responds 202 _"whether or not the address exists, so the route
can't be used to find out which emails are registered"_ (`openapi.yaml:169`), and
`email-verifications` does the same for the same reason. `sign-up` returns **409** when the email
already exists (`openapi.yaml:86`).

The contract closes two enumeration channels carefully and leaves the third open.

**How to reproduce it.** `POST /auth/sign-up` with a list of emails. The 409 marks which ones are
registered.

**Ways out.** Always responding 201 with `VerificationPending`, and sending the already-registered
address a different email — a _you already have an account_ type — is what the industry does, at the
cost of one more template and one more path to test. Keeping the 409 and stating it in writing is
also defensible. What isn't defensible is having two routes hardened and one left open without it
being a decision.

**Recommendation.** Close it: always 201, and a different _you already have an account_ email to the
already-registered address. It costs one template and one branch, and leaves all three auth routes
consistent, which is the first thing anyone reading the contract will check. **And there's a side
effect that pays for itself:** with the 409 gone, signing up again rewrites `pending_password_hash`,
and **that closes finding 26 along the way**. **Would change if** the frontend needed to tell the two
cases apart in the response, which it doesn't, because the email is what tells them apart.

## 20. `GET /guest-orders/{orderId}` is unauthenticated, unrated BOLA

**What fails.** OWASP API1:2023, _Broken Object Level Authorization_, in its purest form: the object
identifier **is** the credential (`openapi.yaml:917`). On top of that:

- It doesn't require authentication, by design.
- It serves `OrderDetail`, which includes `destination`: the recipient's name, street, city, and
  postal code (`openapi.yaml:1909`).
- **It doesn't declare 429.** The brief only requires rate limiting on password reset, so nothing
  today slows down exploration.

**On the entropy, with the number.** The id is a UUIDv7, and the ERD says so explicitly by using id
order as creation order (`ERD.dbml:210`). RFC 9562's layout is
`unix_ts_ms (48) | ver (4) | rand_a (12) | var (2) | rand_b (62)`, so **the protection is 74 random
bits, not 128**: the timestamp sits in the clear in the prefix.

74 bits is still brute-force-proof. What matters is being able to say **that's the number, that it's
deliberate, and that what makes it enough is the route being rate-limited** — because an identifier
that travels in an email leaks through forwarding long before it leaks through guessing.

**Ways out.** A single-use token independent of the order id separates the credential from the
identifier. A per-IP rate limit on this route raises the cost of sweeping without changing the
model. Trimming `destination` from this response reduces the damage without closing the hole.

**Recommendation.** A per-IP rate limit on this route, and nothing more. The single-use token is the
right answer in the abstract, and it costs a new table and a new path, and **guest checkout is added
scope the brief doesn't ask for**: hardening it heavily is investing where nobody asked. Trimming
`destination` leaves the buyer unable to see where their order is going, which is exactly what the
route exists to show. **Would change if** guest checkout stopped being added scope, or if the route
started serving more than a single order.

## 21. `cartItemId` is a bare UUID in the route

**What fails.** `PATCH` and `DELETE /cart/items/{cartItemId}` take an identifier with no ownership
check baked into the route. `Cart` doesn't even have an `id` in the contract, because a user's active
cart is unique. If the implementation resolves with `findUnique({ id })` and then checks ownership
separately, that separate check is the only thing keeping one customer's cart apart from another's.

**How to reproduce it.** Two customers. Copy a `cartItemId` from one's response and use it in the
other's `DELETE`. With the scope check misplaced, it deletes.

**Ways out.** Always scope by the caller's active cart, never by the line's id alone:
`cartItem.findFirst({ where: { id, cart: { userId, status: 'ACTIVE' } } })`. The 404 falls out for
free, with no separate check that can be forgotten. It's the same shape that fixes finding 23.

**Recommendation.** `findFirst({ where: { id, cart: { userId, status: 'ACTIVE' } } })`. No downside:
the 404 comes from the row not existing, with no separate check to forget in a refactor.

## 22. `/auth/sign-in` doesn't declare 429

**What fails.** The contract puts 429 on `forgot-password`, `reset-password`, and
`email-verifications`, and not on `sign-in` (`openapi.yaml:104`). The route that validates
credentials is the only auth route with no declared limit.

**Ways out.** Limit by email address, by IP, or progressive account lockout. Account lockout turns
the limit into a denial of service against a specific user, which is why per-IP limiting with
backoff is usually preferred.

**Recommendation.** Per-IP limit with backoff, not account lockout. Account lockout turns the limit
into a targeted denial of service: anyone can lock out a specific user just by knowing their email.
**Would change if** distributed credential stuffing showed up, where a per-IP limit doesn't help —
then it's account lockout with email-based unlock.

## 23. The "404 not 403" rule clashes with how CASL throws

**What fails.** The contract is explicit: _"Any order outside the caller's scope returns 404, never
403, so the code can't be used to enumerate other people's order identifiers"_ (`openapi.yaml:845`).
But `PATCH /orders/{orderId}/status` declares **both**: 403 for the wrong role and 404 for someone
else's order (`openapi.yaml:869`).

The same route has to tell _you can't do this operation_ apart from _this order doesn't exist for
you_, and CASL throws `ForbiddenError` for both.

**Why this is the worst place for it.** The program says it outright: _"a generated CASL ability
that looks correct and silently grants a client access to another customer's orders will pass every
test you thought to write."_

**Ways out.** The approach that holds up is separating the two questions by mechanism: ownership
gets resolved **in the `where`** with `accessibleBy`, so the 404 falls out of the row not existing;
role and transition get resolved with `can()` on an already-loaded object, and that's what throws the 403. Mixing the two into one check is what produces the silent failure.

**Recommendation.** Ownership in the `where` with `accessibleBy`, role and transition with `can()` on
the already-loaded object. No downside, and it's the only way to get the 404 and the 403 out of two
separate mechanisms instead of one check someone has to remember to write. **This is the exact point
in the capstone the program itself warns about: a failure that passes every test you thought to
write.**

## 24. `WWW-Authenticate` and log redaction are declared and don't exist

**What fails.** Two written obligations, neither implemented:

- The 401 declares the `WWW-Authenticate` header with `error="invalid_token"`, citing RFC 9110
  §15.5.2 as the obligation and RFC 6750 as the source of the value (`openapi.yaml:1264`). Nest
  doesn't emit it.
- The program's brief bans logging passwords, tokens, secrets, card data, connection strings, and
  personal data, and notes that logs also fall under GDPR. `webhook_events.payload` stores
  `customer_details` and `shipping_details` in the clear (`ERD.dbml:362`), and its promised redaction
  hasn't happened.

**Recommendation.** `WWW-Authenticate` belongs in block 1's global filter, with
`error="invalid_token"` only when a token was presented and rejected. Redaction belongs in a logging
interceptor with a field list, not scattered across call sites. Neither has a tradeoff: both are
written down and neither exists today.

---

# D. Contradictions between the contract and the model

These four get fixed, not annotated.

## 25. `GET /products` orders by a column that isn't unique

**What fails.** The `info` block promises that _"every collection declares a total order with a
unique tiebreaker, so paginating with limit and offset over data that never changes neither repeats
nor skips a row"_ (`openapi.yaml:1166`). `GET /products` declares _"ordered by name ascending"_
(`openapi.yaml:392`), and **`products.name` isn't unique in the ERD**: no `[unique]` and no index
enforces it (`ERD.dbml:182`).

With two products sharing a name, PostgreSQL doesn't guarantee a stable order between them, and the
tiebreaker the `info` block promises doesn't exist.

**How to reproduce it.** Create twenty-one products, two of them sharing a name right at a page
boundary, and request `limit=20&offset=0` then `offset=20`. A product can show up twice, or not at
all.

**Everything else holds up.** `categories.name` is unique (`ERD.dbml:175`). `promo_codes.code` is
unique in practice, since the partial unique constraint holds while `deleted_at IS NULL` and nothing
deletes rows. Orders already tiebreak with `id`. The defect is specific to this one collection.

**Fix.** Declare the order as name ascending, then `id`, the same way orders already do.

**Recommendation.** Name ascending, then `id`, the same as orders already do. **Would change if** the
API moved to cursor pagination, where the cursor itself provides the tiebreak and `offset`
disappears — but that breaks the contract across all five collections and doesn't buy anything at
this scale.

## 26. Dead end in email verification

**What fails.** Someone who signs up, never verifies, and then forgets their password gets locked
out, and the three doors are each closed by a different decision that never crossed paths:

1. `sign-up` again returns **409**, because the `users` row already exists.
2. `resend-verification` **doesn't accept a password** (`openapi.yaml:225`), so the new
   `email_verification_tokens` row has to carry the old, forgotten `pending_password_hash`. Setting
   it to NULL isn't an option: confirming it would violate the CHECK `password_hash IS NOT NULL OR
email_verified_at IS NULL` (`ERD.dbml:126`).
3. `reset-password` would write `users.password_hash`, but `sign-in` also requires
   `email_verified_at IS NOT NULL`, and those are _"three separate guards, deliberately not
   merged."_

**How to reproduce it.** Sign up, never open the email, forget the password, and try to get in
through any of the three routes.

**This falls inside the Week 3 checkpoint.** Authentication is one of the three areas graded there.

**Ways out.** Have `resend-verification` accept a new password and rewrite `pending_password_hash`,
which gives the route a use it doesn't have today and needs checking for what it opens up. Or make
confirming and resetting the same path for an unverified account. Or accept the lockout and say the
way out is support — a fine answer, as long as it's deliberate.

**Recommendation.** **Close finding 19 first and check whether this one closes itself.** With
sign-up always returning 201, signing up again on an unverified account rewrites
`pending_password_hash` and the dead end disappears without touching `resend-verification`. It's a
free fix that comes from fixing something else.

If the 409 stays for whatever reason, the second option is having `resend-verification` accept an
optional password. **This doesn't open anything new**, because the ERD already states the account
_"goes to whoever controls the inbox and registered most recently"_: whoever can request the resend
already controls the inbox.

## 27. The guest order on an already-registered email is born dead

**What fails.** `orders.user_id` is NOT NULL and points at `users`. When a Payment Link payment
lands, the webhook needs a user row. If the buyer's email **already belongs to an ACTIVE account**,
`uq_users_email_live_partial` blocks creating a second one, so the order gets attached to the
existing account. And then the link sent to the buyer returns **404**, because
`GET /guest-orders/{orderId}` is _"public only while the order's owner is still in GUEST status"_
(`openapi.yaml:918`).

The buyer pays, gets an email, clicks it, and sees nothing. The order is in their authenticated
history, but nobody told them that.

**How to reproduce it.** Sign up and verify with an address. Buy through a Payment Link with that
same address without logging in. Open the email link.

**Ways out.** Have the email detect the case and point to sign-in instead of the guest link. Or have
the link keep working for orders born as guest orders even once the owner is ACTIVE, which turns a
URL into a permanent credential over a real account and makes finding 20 worse. The first requires
the webhook to know which case it's handling, which is information it already has.

**Recommendation.** Have the email detect the case and point to sign-in instead of the guest link.
The webhook already has this information, because it knows whether it created the user row or found
it. The other way out, keeping the link working, turns a URL into a permanent credential over a real
account and makes finding 20 worse.

## 28. `anyOf` stops the contract from catching a projection regression

**What fails.** Three operations declare their response as an `anyOf` of the public and manager
projections: `getProduct`, `listOrders`, and `getOrder`. The reason is sound — OpenAPI 3.0 can't
condition a schema on the caller's role. The consequence wasn't stated: **`anyOf` validates if any
one branch validates.**

A manager response missing `customer` still validates against `OrderSummary`. A customer-facing
response carrying extra `stock` and `reserved` also validates, because `ManagerProduct` doesn't
forbid anything extra and `ProductDetail` doesn't declare `additionalProperties: false`.

**Why it matters more than it looks.** It's the best answer available today to the SDR's Q5, _"name
a regression that would reach production today without anyone noticing"_: **an inventory leak, or a
leak of the buyer's email through the wrong projection, passes the contract's validation in both
directions.** And it comes from a Week 2 decision, not an oversight.

**Ways out.** The contract can't fix this within 3.0. What can catch it is the test suite: checking
each role's projection field by field instead of validating against the schema.

**Recommendation.** Leave the contract alone, and put the field-by-field check in the tests. This
also **answers the SDR's Q5**, so it's worth stating in those terms: _the regression that would reach
production today unnoticed is a wrong-role projection, because `anyOf` validates in both directions._

**A partial fix does exist.** `additionalProperties: false` on `ManagerProduct` makes it disjoint
from its counterpart. It doesn't work for `ProductDetail`, `OrderDetail`, or `ManagerOrderSummary`,
which are `allOf`: in OpenAPI 3.0, `additionalProperties` **doesn't see through an `allOf`**, so the
composed branch rejects even the properties its own siblings declare. The clean fix is
`unevaluatedProperties`, which only exists in OpenAPI 3.1, and migrating the whole document to 3.1
just for this breaks more than it fixes. A half-fix with a half-asymmetry is harder to explain than
no fix at all.

---

# E. What NestJS and Prisma won't do alone

## 29. No error meets the contract today

**What fails.** The contract requires RFC 9457 on **every** error response: a
`{type, title, status, detail, instance}` body with all five fields required (`openapi.yaml:1436`),
served as `application/problem+json`. **Verified by running it** against Nest 11 with the
`ValidationPipe` already in `main.ts`:

```
400  application/json; charset=utf-8
     {"message":["limit must not be less than 1"],"error":"Bad Request","statusCode":400}
404  application/json; charset=utf-8
     {"message":"Cannot GET /no-existe","error":"Not Found","statusCode":404}
```

Not one field matches, and neither does the `Content-Type`.

**Scope.** Twelve shared responses, thirty-eight operations. None comply today.

**Why this has to be written first.** Every unit test that asserts on an error asserts on whatever
shape exists at the time. Writing the tests before the filter means writing them against the wrong
shape, and the program warns that a test written after the fact describes what came out — bugs
included.

**A detail that slips through, and the two lines above show it.** `message` is **an array** when
`ValidationPipe` throws it and **a string** when any other exception throws it. The filter has to
handle both shapes to produce a `detail` that's always a string, or the 400 breaks its own schema
while the 404 passes.

**Recommendation.** Write it before any test, no exceptions. There's no real choice here: 38
operations return a shape the contract doesn't declare today, and every test written before the
filter asserts the wrong one.

## 30. `priceFrom` and `inStock` are aggregates Prisma can't express

**What fails.** `ProductSummary` requires `priceFrom`, `image`, `inStock`, and `categories` with
`minItems: 1` (`openapi.yaml:1517`), and none of them is a column:

- `priceFrom` is `MIN(price)` across the variants.
- `inStock` is `EXISTS` of a variant with `stock - reserved > 0`.
- `image` is the cover image, defined as `ORDER BY id LIMIT 1` over `product_images`.
- `PublicSku.available` is `stock - reserved`, masked to null once it's above five.

Prisma can't express the _lateral join_ that gets one cover image per product in a single query.

**Ways out.** Computing it in JS per page pulls in every variant for the twenty products on the
page, and is perfectly fine at this scale, as long as it's stated as a decision and not an oversight.
Dropping to `$queryRaw` with `DISTINCT ON`, or a view, is faster and loses type safety. Materializing
`priceFrom` into a column introduces the problem of keeping it in sync.

**Aside.** The publication filter, _"active, not deleted, with a priceFrom, at least one SKU, and at
least one image,"_ is expressible in a single `where` with `skus: { some: {} }` and
`images: { some: {} }`.

**Recommendation.** Compute it in JS per page, and **state it as a decision**. Twenty products with
their variants is two queries and a `map`, and at this scale the difference doesn't register.
**Would change if** the catalog grew past a few hundred products, or the listing became the hot
endpoint — that's where `$queryRaw` with `DISTINCT ON` stops being premature.

## 31. The model's guarantees only exist if the migration is hand-written

**What fails.** This was documented in the raw-SQL notes that left the repository with the
migration history; the header of `prisma/schema.prisma` now tracks what is still pending — and it's
worth restating here because it's a **silent** failure mode: six partial unique constraints, one partial sweep index, and
the CHECKs on eight tables — none of which Prisma knows how to declare. Without the hand-written
migration, the schema compiles and the model loses its guarantees without a single error.

**What's actually lost.** `uq_carts_user_active_partial` is the only thing guaranteeing one active
cart per user. `uq_payment_links_sku_active_partial` is what makes the _get-or-create_ under
concurrency safe. `uq_payments_order_succeeded_partial` is one settled payment per order, and
without it finding 4 has no safety net.

**Recommendation.** Write it, and make it the first thing in block 1. There's no real choice: without
it, the single active cart, the safe _get-or-create_ for links, and the one settled payment per
order — which is finding 4's safety net — all disappear silently.

## 32. `CREATE INDEX CONCURRENTLY` doesn't run inside a transaction

**What fails, corrected after checking it.** Prisma's wrapping behavior **depends on the number of
statements**: a migration with several statements runs inside a transaction, one with a single
statement doesn't. Since PostgreSQL forbids `CREATE INDEX CONCURRENTLY` inside a transaction, that
turns the limitation into a fairly convenient rule: **each concurrent index goes in its own
migration file, alone.**

Beyond the wrapping, a normal `CREATE UNIQUE INDEX` takes a lock that blocks writes while it builds,
and `ALTER TABLE ... ADD CONSTRAINT ... CHECK` takes ACCESS EXCLUSIVE and validates the whole table.

**Consequence for block 1's migration.** The six partial unique constraints and finding 31's sweep
index currently sit in a single file, so they run inside a transaction and without `CONCURRENTLY`.
At seed scale that's correct; on a table with data, it isn't.

**Why this is here even though it doesn't matter at seed scale.** Because at seed scale it
**doesn't matter**, and the SDR's Q2 asks _"how does a migration reach production without
downtime?"_ The defensible answer is `NOT VALID` followed by `VALIDATE CONSTRAINT`, and
`CONCURRENTLY` in a migration marked to skip the wrapper.

**Recommendation.** At this scale, a normal migration in a single file, no `CONCURRENTLY`, no
`NOT VALID`. On the SDR page, say the no-downtime approach is `NOT VALID` followed by
`VALIDATE CONSTRAINT`, and `CONCURRENTLY` **in one migration file per index**, which is what keeps it
out of a transaction without needing any Prisma option. **Both at once are the answer**: knowing what
the correct approach is, and why it isn't needed here yet.

## 33. Prisma has no down migrations

**What fails.** Q2 also asks _"how do you roll back a bad deploy?"_ Rolling back the code means
going back to the previous image. Rolling back the schema doesn't exist in `prisma migrate`.

**Way out.** Expand-and-contract: every migration stays backward-compatible with the previous
version of the code, and the old column gets dropped one version later. That's what makes rolling
back the code sufficient on its own.

**Recommendation.** Expand-and-contract: every migration backward-compatible with the previous code
version, with the old column dropped one version later. That's what makes rolling back the image
sufficient, which is what Q2 is actually asking.

## 34. The connection pool the SDR asks you to diagram

**What fails.** The deliverable's brief asks for the diagram _"including how connections are
pooled,"_ and it's the part that gets forgotten. The total against PostgreSQL's `max_connections`,
100 by default, is `(API instances + workers) × pool size`.

**And the pool size depends on the version, which is exactly the failure mode the program warns
about.** On **Prisma 6, the version in use here**, the default is `physical_cpus * 2 + 1`, meaning it
changes just by switching hosting plans. On Prisma 7 with a driver adapter, it becomes a **fixed
10**. Citing the number without citing the version is exactly the mistake to avoid.

Four API instances and two workers on four vCPUs add up to 54, which fits. A stateless deployment
autoscaling to dozens of instances doesn't fit, and that's where an external pooler comes in.

Every BullMQ `Worker` also opens its own connection to Redis, and that belongs in the diagram too.

**Recommendation.** An explicit pool of 5 to 10 per process in the connection string, not the
default, plus a stated instance count in the diagram. The default depends on the machine's CPU
count, so it changes just by switching hosting plans. **Would change if** the deployment went
stateless with autoscaling, where the number of processes isn't known and an external pooler becomes
necessary.

## 35. `forbidNonWhitelisted` on query params

**What fails.** `main.ts:13` turns on `whitelist: true` and `forbidNonWhitelisted: true` globally.
On the body, that's correct. On the query string, it turns any extra parameter into a 400, tracking
parameters that browsers and analytics tools add on their own included.

**Verified by running it**, with `main.ts`'s exact configuration:

```
GET /probe?limit=20&utm_source=x
400  {"message":["property utm_source should not exist"],"error":"Bad Request","statusCode":400}
```

**Ways out.** Accept it and state it, since it's also what keeps `customerId` from being silently
ignored. Or relax it only on query DTOs. What isn't worth doing is discovering it from the frontend.

**Recommendation.** Keep it on the body, and relax it only on query DTOs: `whitelist: true` without
`forbidNonWhitelisted`. Parameters that do carry authorization, like `customerId`, are declared and
so keep being validated, so the guarantee that they're never silently ignored doesn't go away.
**Would change if** an undeclared query parameter showed up with an effect on scope, which is exactly
what the declaration prevents.

---

# Sources

Verification pass from **August 28, 2026**. Every number above comes from here, not from a model's
memory. The program asks for exactly this: _"the required readings are the source of truth; the
characteristic failure is a superseded API stated with confidence, not an invented one."_

## Verified by running it

The strongest kind of entry on this list, because it verifies the system, not a source. Test module
via `Test.createTestingModule` with the same `ValidationPipe` as `main.ts`, on Nest 11.

| Finding | Result                                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **29**  | Nest's error is `{message, error, statusCode}` as `application/json`. Not one field of the contract matches. And `message` is an array on validation errors and a string everywhere else |
| **35**  | `?utm_source=x` returns 400 with `property utm_source should not exist`                                                                                                                  |

## Verified against documentation

| Finding | Fact                                                                                                                                                                                                   | Source                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4**   | Idempotency keys are pruned _"after they're at least 24 hours old"_                                                                                                                                    | [docs.stripe.com/api/request_ids](https://docs.stripe.com/api/request_ids)                                                                         |
| **6**   | `cancel` allows `requires_payment_method`, `requires_confirmation`, `requires_action`, `requires_capture`, and `processing`. **A Checkout Session's PI can only be cancelled from `requires_capture`** | [docs.stripe.com/api/payment_intents/cancel](https://docs.stripe.com/api/payment_intents/cancel)                                                   |
| **10**  | `$transaction`: `timeout` 5000 ms, `maxWait` 2000 ms                                                                                                                                                   | [Prisma, transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)                                                          |
| **15**  | SigV4 maxes out at 7 days via SDK or CLI, 12 h via console, **and with temporary credentials it expires with the credential**                                                                          | [AWS, presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)                                              |
| **20**  | UUIDv7 splits into 48 bits of timestamp, 4 of version, 12 of `rand_a`, 2 of variant, and 62 of `rand_b`: **74 random bits**                                                                            | [RFC 9562](https://www.rfc-editor.org/info/rfc9562/)                                                                                               |
| **28**  | `additionalProperties` doesn't see through an `allOf` in 3.0; `unevaluatedProperties` only exists in 3.1                                                                                               | [Swagger, keywords](https://swagger.io/docs/specification/v3_0/data-models/keywords/)                                                              |
| **32**  | Prisma wraps a migration **with multiple statements**; a single-statement one, it doesn't                                                                                                              | [Prisma, pgfence](https://www.prisma.io/docs/guides/integrations/pgfence) · [discussion 10601](https://github.com/prisma/prisma/discussions/10601) |
| **34**  | Default pool: `physical_cpus * 2 + 1` on Prisma 6, **fixed 10** on Prisma 7 with an adapter                                                                                                            | [Prisma, connection pool](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool)              |

## Three corrections that came out of the pass

1. **H32 was too strong.** It said Prisma wraps _every_ migration in a transaction. It only wraps
   multi-statement ones, and that turns the limitation into a useful rule: one concurrent index per
   file.
2. **H15's recommendation changed.** The 7 days is real, but only with long-lived IAM user
   credentials. With a role, which is normal in containers, the URL dies with the credential and the
   CDN stops being plan B.
3. **H4 gained a limit.** Keys last at least 24 h and webhook retries run for three days, leaving a
   two-day window with no key coverage. What covers that window is `payments`'s partial unique
   constraint, and that ties finding 4 to finding 31.

## Still pending, and can't be done yet

**H23, CASL.** `accessibleBy` and `ForbiddenError` are exactly the case the program warns about, and
there's nothing to verify today because CASL isn't installed and no version has been chosen. **That
check happens at `npm install` time, against that specific version's documentation**, and before
writing a single ability.

**H1, Stripe's three-day retry window.** Comes from the Week 2 pass and is written in
`openapi.yaml:1024`. Not reverified in this pass.
