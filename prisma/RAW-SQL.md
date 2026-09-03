# What Prisma cannot express

`schema.prisma` is a translation of the Week 1 ERD, but **three classes of object have
no syntax in Prisma** and have to be written by hand inside a migration.

How it's done: generate the empty migration and edit it before applying it.

```bash
npx prisma migrate dev --create-only --name partial_indexes_and_checks
# edit the generated .sql, add what's below, and then:
npx prisma migrate dev
```

If this isn't done, **the schema compiles and the model silently loses its guarantees**:
the partial uniques start behaving like full uniques or stop existing altogether, and none of
the CHECK invariants hold.

---

## 1. The six partial unique indexes

The ERD declares them with the `uq_` prefix and `_partial` suffix, and their predicate lives
in each table's note. None is expressible with `@@unique`, because Prisma doesn't support a
predicate.

| Name | Table | Definition |
|---|---|---|
| `uq_users_email_live_partial` | `users` | `UNIQUE (email) WHERE deleted_at IS NULL` |
| `uq_email_verification_tokens_live_partial` | `email_verification_tokens` | `UNIQUE (user_id) WHERE consumed_at IS NULL` |
| `uq_carts_user_active_partial` | `carts` | `UNIQUE (user_id) WHERE status = 'ACTIVE'` |
| `uq_payments_order_succeeded_partial` | `payments` | `UNIQUE (order_id) WHERE status = 'SUCCEEDED'` |
| `uq_payment_links_sku_active_partial` | `payment_links` | `UNIQUE (sku_id) WHERE is_active` |
| `uq_promo_codes_code_live_partial` | `promo_codes` | `UNIQUE (code) WHERE deleted_at IS NULL` |

Each one backs a decision in the model. `uq_carts_user_active_partial` is what guarantees a
single active cart per user; `uq_payment_links_sku_active_partial` is what makes the
*get-or-create* creation safe under concurrency; `uq_payments_order_succeeded_partial` is one
settled payment per order.

## 2. The sweep's partial index

| Name | Table | Definition |
|---|---|---|
| `idx_orders_pending_expires_partial` | `orders` | `(expires_at) WHERE status = 'PENDING'` |

It isn't unique. It's the index the sweep that expires reservations uses.

## 3. The CHECK constraints

Copied from the ERD's notes, which are the source of truth.

**`users`**
- `password_hash IS NOT NULL OR email_verified_at IS NULL`
- `state = 'ACTIVE' OR email_verified_at IS NULL`

**`skus`**
- `price > 0`, `stock >= 0`, `reserved >= 0`, `reserved <= stock`, `restock_cycle >= 0`

**`cart_items`**
- `quantity > 0`

**`orders`**
- `total = subtotal - order_discount_amount`
- `subtotal >= 0`, `order_discount_amount >= 0`
- `(delivered_by_id IS NULL) = (delivered_at IS NULL)`

**`order_items`**
- `quantity > 0`, `unit_price >= 0`

**`payment_links`**
- `unit_price_at_creation > 0`

**`promo_codes`**
- `discount_value > 0`
- `discount_value <= 100 WHEN type = 'PERCENTAGE'`
- `usage_count >= 0`, `usage_reserved >= 0`, `usage_limit >= 0`
- `usage_count + usage_reserved <= usage_limit`
- `minimum_purchase_amount >= 0` when not null
- `expires_at > created_at`

**`stock_notifications`**
- `(sent_at IS NOT NULL) = (status = 'SENT')`

---

## Two things worth checking when applying

**The application generates the UUIDs, not the database.** The ERD's header says so: *"All
UUIDs are generated as UUIDv7 in Prisma, not via a SQL default."* That's why no `id` carries
`@default` in the schema. If an `INSERT` fails on a null id, the generator is missing from the
application, not a default from the migration.

**`skus`'s composite FK is already in the schema.** `image` references
`ProductImage(id, productId)`, which is what stops a variant from pointing at another product's
image. Prisma does express that one, thanks to `product_images`'s `@@unique([id, productId])`.
