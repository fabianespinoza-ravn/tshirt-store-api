# Authorization matrix

Extracted from `W2-API/openapi.yaml` at `1.0.1`, all 38 operations, no exceptions. **This is not
an authorization model**: it is your contract reordered by who can do what, which is the raw
material the ability is built from. You write the model.

**One status code is not in that extract.** The implementation also answers **503** on every
operation: every route reads or writes Postgres, and `src/common/problem/translators/` turns an
unreachable database or a busy S3 into `service-unavailable` instead of a 500 that tells a client
to give up. The per-operation lists below are left exactly as extracted, because falsifying an
extract is worse than an omission — `W2-API/openapi.yaml` is where the code has to be added.

---

## The three zones

| Zone | How many | What it implies |
|---|---|---|
| **Public** | 10 | `security: []`. The global guard has to let them through, and that is what `@Public()` is for |
| **Optional authentication** | 1 | `getProduct`. Accepts anonymous and widens the response for a manager |
| **Authenticated** | 27 | Token required. 23 declare 403; the other 4 are worth a closer look |

---

## Authentication

| Operation | Route | Who | Codes |
|---|---|---|---|
| `signUp` | `POST /auth/sign-up` | public | 201 400 429 500 |
| `signIn` | `POST /auth/sign-in` | public | 200 400 401 403 429 500 |
| `forgotPassword` | `POST /auth/forgot-password` | public | 202 400 429 500 |
| `resetPassword` | `POST /auth/reset-password` | public | 204 400 404 429 500 |
| `resendEmailVerification` | `POST /auth/email-verifications` | public | 202 400 429 500 |
| `confirmEmailVerification` | `POST /auth/email-verifications/confirm` | public | 204 400 404 500 |
| `refreshSession` | `POST /auth/refresh` | refresh cookie | 200 401 500 |
| `signOut` | `POST /auth/sign-out` | **bearer + cookie**, both | 204 401 500 |
| `changePassword` | `PATCH /auth/password` | any authenticated user | 204 400 401 500 |

The 403 on `signIn` is not about role: it's `EmailNotVerified`. Don't lump it in with the rest.

## Catalog

| Operation | Route | Who | Codes |
|---|---|---|---|
| `listCategories` | `GET /categories` | public | 200 400 500 |
| `createCategory` | `POST /categories` | MANAGER | 201 400 401 403 409 500 |
| `updateCategory` | `PATCH /categories/{categoryId}` | MANAGER | 200 400 401 403 404 409 500 |
| `deleteCategory` | `DELETE /categories/{categoryId}` | MANAGER | 204 401 403 404 409 500 |
| `listProducts` | `GET /products` | public | 200 400 500 |
| `getProduct` | `GET /products/{productId}` | **anonymous or authenticated** | 200 401\* 404 500 |
| `createProduct` | `POST /products` | MANAGER | 201 400 401 403 404 500 |
| `updateProduct` | `PATCH /products/{productId}` | MANAGER | 200 400 401 403 404 500 |
| `deleteProduct` | `DELETE /products/{productId}` | MANAGER | 204 401 403 404 409 500 |
| `uploadProductImage` | `POST /products/{productId}/images` | MANAGER | 201 400 401 403 404 413 415 500 |
| `deleteProductImage` | `DELETE /products/{productId}/images/{imageId}` | MANAGER | 204 401 403 404 409 500 |
| `createSku` | `POST /products/{productId}/skus` | MANAGER | 201 400 401 403 404 409 500 |
| `updateSku` | `PATCH /skus/{skuId}` | MANAGER | 200 400 401 403 404 409 500 |
| `setProductLike` | `PUT /products/{productId}/like` | **CLIENT** | 200 400 401 403 404 500 |

\* Declared in the contract but unreachable here: `getProduct` is `@Public()`, and
`JwtAuthGuard` only tries to attach a token when one is presented on a public route
(`src/auth/guards/jwt-auth.guard.ts:31-34`) — an invalid or expired token is silently
ignored instead of rejected, so this operation never actually returns 401.

## Cart

All four are **CLIENT only**, and all four declare 403.

| Operation | Route | Codes |
|---|---|---|
| `getCart` | `GET /cart` | 200 401 403 500 |
| `addCartItem` | `POST /cart/items` | 200 201 400 401 403 404 409 500 |
| `updateCartItem` | `PATCH /cart/items/{cartItemId}` | 200 400 401 403 404 409 500 |
| `removeCartItem` | `DELETE /cart/items/{cartItemId}` | 200 401 403 404 500 |

## Orders

| Operation | Route | Who | Codes |
|---|---|---|---|
| `listOrders` | `GET /orders` | CLIENT their own · MANAGER all · DELIVERY within scope | 200 400 401 403 500 |
| `checkout` | `POST /orders` | **CLIENT** | 201 400 401 403 409 500 |
| `getOrder` | `GET /orders/{orderId}` | CLIENT their own · MANAGER all · DELIVERY within scope | 200 401 **404** 500 |
| `getOrderStatusHistory`† | `GET /orders/{orderId}/status-history` | CLIENT their own · MANAGER all · DELIVERY within scope | 200 401 **404** 500 |
| `updateOrderStatus` | `PATCH /orders/{orderId}/status` | MANAGER · CLIENT · DELIVERY, each with different destinations | 200 400 401 **403** **404** 409 500 |
| `getGuestOrder` | `GET /guest-orders/{orderId}` | public, the URL is the credential | 200 404 500 |

† **The one row here that is not from the extract.** `getOrderStatusHistory` is the delivery
extension of the challenge — *"clients can view their order's full status history"* — and it is
additive: it takes no existing operation's codes away and changes no existing row. Its scope column
is `getOrder`'s, copied word for word, and that is the whole design: the transitions of an order
are readable exactly when the order is, so the route sends the same Prisma `where` and answers
**404 and never 403** for the same reason, which is that a 403 would confirm that an identifier
belongs to somebody. The answer is ordered by the per-order `sequence` the API assigns as it
records each transition. `W2-API/openapi.yaml` is where the operation has to be added for the
served document and the deliverable to agree.

DELIVERY's scope: any **SHIPPED** order, plus the **DELIVERED** ones they delivered.

The destinations allowed in `updateOrderStatus`:

| Role | Destination | From |
|---|---|---|
| MANAGER | `PROCESSING`, then `SHIPPED` | `PAID` |
| CLIENT | `CANCELLED` | own and not yet shipped |
| DELIVERY | `DELIVERED` | `SHIPPED` |

**The implementation narrows the client's row, on purpose and temporarily.** Only `PENDING` is
accepted today, not "own and not yet shipped": cancelling a `PAID` or `PROCESSING` order owes a
refund, and no refund exists until Stripe lands. An order cancelled with the money kept is worse
than a route that refuses the case, so the other two states open where the refund does. The table
above is left as extracted; `src/orders/order-state-machine.ts` is where the narrowing lives and
where it is undone.

## Payment links, webhooks and promotions

| Operation | Route | Who | Codes |
|---|---|---|---|
| `createPaymentLink` | `POST /payment-links` | MANAGER | 200 201 400 401 403 404 500 |
| `receiveStripeEvent` | `POST /webhooks/stripe` | Stripe, by signature | 200 400 500 |
| `listPromoCodes` | `GET /promo-codes` | MANAGER | 200 400 401 403 500 |
| `createPromoCode` | `POST /promo-codes` | MANAGER | 201 400 401 403 409 500 |
| `updatePromoCode` | `PATCH /promo-codes/{promoCodeId}` | MANAGER | 200 400 401 403 404 409 500 |
| `validatePromoCode` | `POST /promo-codes/validate` | **CLIENT** | 200 400 401 403 409 500 |

---

# The four rows that break the pattern

These are the ones worth a second look, and they come from counting codes, not from opinion.

**1. `getOrder` is the only role-scoped route that does NOT declare 403.** The other three without
403 (`signOut`, `refreshSession`, `changePassword`) don't need it because any authenticated role can
call them. In `getOrder` the absence is deliberate: someone else's order returns **404**, so the
status code can't be used to enumerate identifiers. `getOrderStatusHistory` is the second, added
after the extract: it hangs off the same order and inherits the same reasoning, so counting from
the 1.0.1 contract this is still the only one.

**2. `updateOrderStatus` declares 403 and 404 on the same resource.** 403 for the wrong role, 409
for an invalid transition, 404 for someone else's order. It's the only operation in the contract
that needs all three distinct responses, and it's where the failure the program warns about hides.

**3. `getProduct` accepts anonymous and does not declare 403.** An inactive product is 404 for a
client and 200 for a manager. **Visibility is not a permission here, it's a condition on the row.**

**4. `setProductLike` is CLIENT only and a manager gets 403.** Together with the four cart
operations and `checkout`, these are the six operations that a `can('manage', 'all')` for MANAGER
would silently break.

---

# What this table puts in front of you

These are not answers. They are the decisions the matrix leaves in plain sight.

**The subjects that appear.** `Category`, `Product`, `ProductImage`, `Sku`, `ProductLike`, `Cart`,
`CartItem`, `Order`, `PaymentLink`, `PromoCode`. Ten, and none is `User`: no operation reads or
writes another user.

**Where ownership isn't where it looks.** `CartItem` has no owner of its own: its `Cart` does. Any
condition on a cart line has to climb one level, and if the `@casl/prisma` version you install
doesn't support conditions on relations, that changes the shape of the whole module.

**Whether `update` and `cancel` are distinct actions.** In `updateOrderStatus` the three roles do
different things to the same resource. With separate actions, the role-based 403 falls out of the
ability for free; with a single action and conditions, you have to produce it yourself.

**Which part of DELIVERY's scope is a condition and which is state.** *"Any SHIPPED"* is a
condition on the row. *"The DELIVERED ones they delivered"* is a condition on `deliveredById`. Both
translate to a `where`, so both can live in the ability.

**The six client-only operations.** They're above with 403 declared. Enumerate them in the
positive.

---

# What does NOT go in the ability

- **`getGuestOrder`.** The credential is possessing the URL, not a role. Modeling it as an ability
  forces you to invent a subject that doesn't exist.
- **`receiveStripeEvent`.** An HMAC signature authorizes it.
- **The state transition.** `PAID → PROCESSING → SHIPPED` is a state machine and returns 409. Who
  can attempt which destination is authorization, and that does return 403.
- **The per-role projection.** A manager seeing `stock` and `reserved` is serialization. CASL's
  field-level permissions only restrict, and here you need to add.
- **Catalog visibility.** Active and not deleted is a condition on the row, not a role permission,
  and that's why `getProduct` returns 404 and not 403.
